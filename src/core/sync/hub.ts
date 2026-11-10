// In-memory, per-repository event hub with resumable cursors.
// - `epoch` changes every process start, so clients detect restarts and reconcile.
// - Each repository keeps a bounded ring buffer; a cursor older than the buffer gets a `resync`.
// - Publishing is idempotent per (repo, dedupeKey) within a window, so duplicate webhook
//   deliveries or watcher bursts never produce duplicate state changes.

import { formatCursor, parseCursor, type EventEnvelope, type RepositoryEvent } from "../types.ts";

export type HubListener = (env: EventEnvelope) => void;

interface RepoStream {
  buffer: EventEnvelope[];
  listeners: Set<HubListener>;
  dedupe: Map<string, number>;
  /** Highest seq evicted from the buffer (0 = nothing evicted). */
  evictedUpTo: number;
}

export interface EventHubOptions {
  bufferSize?: number;
  dedupeWindowMs?: number;
  now?: () => number;
  epoch?: string;
}

export class EventHub {
  readonly epoch: string;
  private seq = 0;
  private readonly streams = new Map<string, RepoStream>();
  private readonly bufferSize: number;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly globalListeners = new Set<HubListener>();

  constructor(opts: EventHubOptions = {}) {
    this.epoch = opts.epoch ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.bufferSize = opts.bufferSize ?? 512;
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  private stream(repo: string): RepoStream {
    let s = this.streams.get(repo);
    if (!s) {
      s = { buffer: [], listeners: new Set(), dedupe: new Map(), evictedUpTo: 0 };
      this.streams.set(repo, s);
    }
    return s;
  }

  /** Publish an event. Returns the envelope, or null if `dedupeKey` was already published recently. */
  publish(event: RepositoryEvent, dedupeKey?: string): EventEnvelope | null {
    const repo = event.repositoryId;
    const s = this.stream(repo);
    const t = this.now();
    if (dedupeKey) {
      for (const [k, at] of s.dedupe) if (t - at > this.dedupeWindowMs) s.dedupe.delete(k);
      if (s.dedupe.has(dedupeKey)) return null;
      s.dedupe.set(dedupeKey, t);
    }
    const env: EventEnvelope = { epoch: this.epoch, seq: ++this.seq, at: t, event };
    s.buffer.push(env);
    if (s.buffer.length > this.bufferSize) {
      const evicted = s.buffer.splice(0, s.buffer.length - this.bufferSize);
      s.evictedUpTo = evicted[evicted.length - 1]!.seq;
    }
    for (const l of s.listeners) safeCall(l, env);
    for (const l of this.globalListeners) safeCall(l, env);
    return env;
  }

  /**
   * Subscribe to a repository. If `cursor` is given, missed events are replayed first; when the
   * cursor is from another epoch or older than the buffer, a synthetic `resync` is delivered instead.
   */
  subscribe(repo: string, listener: HubListener, cursor?: string | null): () => void {
    const s = this.stream(repo);
    const c = parseCursor(cursor ?? null);
    if (cursor) {
      if (!c || c.epoch !== this.epoch) {
        listener(this.synthetic(repo, cursor && c?.epoch !== this.epoch ? "server restarted" : "invalid cursor"));
      } else {
        // Continuity is provable only if no event newer than the cursor was evicted.
        if (s.evictedUpTo > c.seq) {
          listener(this.synthetic(repo, "event buffer overflow"));
        } else {
          for (const env of s.buffer) if (env.seq > c.seq) safeCall(listener, env);
        }
      }
    }
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }

  /** Listen to every repository (used by webhook fan-out tests and logging). */
  subscribeAll(listener: HubListener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  cursor(): string {
    return formatCursor(this.epoch, this.seq);
  }

  listenerCount(repo: string): number {
    return this.streams.get(repo)?.listeners.size ?? 0;
  }

  private synthetic(repo: string, reason: string): EventEnvelope {
    return { epoch: this.epoch, seq: this.seq, at: this.now(), event: { type: "resync", repositoryId: repo, reason } };
  }
}

function safeCall(l: HubListener, env: EventEnvelope) {
  try {
    l(env);
  } catch {
    /* a failing subscriber must not break others */
  }
}

/** Encode one SSE frame. */
export function sseFrame(env: EventEnvelope): string {
  return `id: ${formatCursor(env.epoch, env.seq)}\nevent: ${env.event.type}\ndata: ${JSON.stringify(env)}\n\n`;
}
