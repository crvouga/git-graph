// Ref reconciliation: never trust webhook payload state. After any ref-affecting signal (webhook,
// poll, our own mutation) re-read the authoritative refs from GitHub (conditional request, so an
// unchanged repo costs a 304) and publish `refs.changed` only when the version actually changed.
// Requests are coalesced per repository: the first one runs immediately (low latency), requests
// that arrive while it runs are folded into one trailing run after a short window.

import { AppError, type RefsSnapshot } from "../../core/types.ts";
import type { EventHub } from "../../core/sync/hub.ts";
import type { GitHubAdapter } from "../../github/adapter.ts";
import { tokenIdentity } from "../../github/client.ts";
import type { Principal, SubscriptionRegistry } from "./subscriptions.ts";

export interface RepoSyncState {
  repo: string;
  lastVersion: string | null;
  lastSuccessAt: number | null;
  lastError: { at: number; message: string } | null;
  lastWebhookAt: number | null;
  lastChangeAt: number | null;
  reconciles: number;
  /** refs.changed events published. */
  changes: number;
  lastSyncOkPublishedAt: number;
  failing: boolean;
  /** Token identity used by the last successful read (for rate-budget aware polling). */
  lastTokenId: string | null;
}

interface Waiter {
  resolve: (r: ReconcileResult) => void;
  reject: (e: unknown) => void;
}

interface Loop {
  waiting: Waiter[];
  running: Promise<void> | null;
}

export interface ReconcileResult {
  changed: boolean;
  version: string | null;
  skipped?: boolean;
}

export interface ReconcilerOptions {
  hub: EventHub;
  registry: SubscriptionRegistry;
  /** Adapter for a repository key acting as `principal` (null = anonymous / public token). */
  adapterFor: (repo: string, token: string | null, anonymous: boolean) => GitHubAdapter;
  coalesceMs: number;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  /** Re-announce sync.ok at most this often while healthy. */
  syncOkEveryMs?: number;
}

export class Reconciler {
  private readonly o: ReconcilerOptions;
  private readonly states = new Map<string, RepoSyncState>();
  private readonly loops = new Map<string, Loop>();
  private readonly now: () => number;
  private closed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(o: ReconcilerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  state(repo: string): RepoSyncState {
    let s = this.states.get(repo);
    if (!s) {
      s = { repo, lastVersion: null, lastSuccessAt: null, lastError: null, lastWebhookAt: null, lastChangeAt: null, reconciles: 0, changes: 0, lastSyncOkPublishedAt: 0, failing: false, lastTokenId: null };
      this.states.set(repo, s);
      if (this.states.size > 10_000) this.states.delete(this.states.keys().next().value!);
    }
    return s;
  }

  noteWebhook(repo: string) {
    this.state(repo).lastWebhookAt = this.now();
  }

  /** Forget the known version (e.g. after a rename or access change) so the next run republishes. */
  forget(repo: string) {
    const s = this.states.get(repo);
    if (s) s.lastVersion = null;
  }

  /** Request a reconciliation; resolves when a run that started after this call completes. */
  request(repo: string): Promise<ReconcileResult> {
    let loop = this.loops.get(repo);
    if (!loop) {
      loop = { waiting: [], running: null };
      this.loops.set(repo, loop);
    }
    const l = loop;
    return new Promise<ReconcileResult>((resolve, reject) => {
      l.waiting.push({ resolve, reject });
      if (!l.running) l.running = this.run(repo, l);
    });
  }

  private sleep(ms: number) {
    return new Promise<void>((res) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        res();
      }, ms);
      this.timers.add(t);
    });
  }

  private async run(repo: string, l: Loop): Promise<void> {
    try {
      while (l.waiting.length && !this.closed) {
        const batch = l.waiting;
        l.waiting = [];
        try {
          const r = await this.reconcileOnce(repo);
          for (const w of batch) w.resolve(r);
        } catch (e) {
          for (const w of batch) w.reject(e);
        }
        if (l.waiting.length) await this.sleep(this.o.coalesceMs);
      }
    } finally {
      l.running = null;
      if (!l.waiting.length) this.loops.delete(repo);
      else if (!this.closed) l.running = this.run(repo, l);
    }
  }

  private async readRefs(repo: string, s: RepoSyncState): Promise<RefsSnapshot> {
    const principals: (Principal | null)[] = this.o.registry.principals(repo);
    let lastErr: unknown = null;
    for (const p of principals) {
      if (!p?.userId) continue;
      let token: string | null = null;
      try {
        token = await p.token();
      } catch {
        continue;
      }
      if (!token) continue;
      try {
        const snap = await this.o.adapterFor(repo, token, false).refs();
        s.lastTokenId = tokenIdentity(token);
        return snap;
      } catch (e) {
        const code = AppError.from(e).code;
        if (code !== "NOT_FOUND" && code !== "UNAUTHENTICATED" && code !== "FORBIDDEN") throw e;
        lastErr = e;
      }
    }
    try {
      const a = this.o.adapterFor(repo, null, true);
      const snap = await a.refs();
      s.lastTokenId = a.tokenId;
      return snap;
    } catch (e) {
      throw lastErr && AppError.from(e).code === "NOT_FOUND" ? lastErr : e;
    }
  }

  private async reconcileOnce(repo: string): Promise<ReconcileResult> {
    const s = this.state(repo);
    // Nobody is listening: clients load fresh refs when they subscribe, so skip the GitHub call.
    if (this.o.registry.interestCount(repo) === 0) return { changed: false, version: s.lastVersion, skipped: true };
    s.reconciles++;
    const hub = this.o.hub;
    try {
      const snap = await this.readRefs(repo, s);
      const t = this.now();
      s.lastSuccessAt = t;
      s.lastError = null;
      const changed = snap.version !== s.lastVersion;
      const wasFailing = s.failing;
      s.failing = false;
      if (changed) {
        const first = s.lastVersion === null;
        s.lastVersion = snap.version;
        s.lastChangeAt = t;
        // The first observation after (re)start is announced too: clients compare it with what they hold.
        hub.publish({ type: "refs.changed", repositoryId: repo, version: snap.version });
        s.changes++;
        if (!first) this.o.log?.("info", "refs changed", { repo, version: snap.version });
      }
      if (wasFailing || t - s.lastSyncOkPublishedAt >= (this.o.syncOkEveryMs ?? 5 * 60_000)) {
        s.lastSyncOkPublishedAt = t;
        hub.publish({ type: "sync.ok", repositoryId: repo, at: t });
      }
      return { changed, version: snap.version };
    } catch (e) {
      const err = AppError.from(e);
      const reason = err.code === "RATE_LIMITED" ? `GitHub rate limit; retry in ${err.details?.retryAfter ?? "?"}s` : err.message;
      const prev = s.lastError?.message;
      s.lastError = { at: this.now(), message: reason };
      if (!s.failing || prev !== reason) hub.publish({ type: "sync.failed", repositoryId: repo, reason });
      s.failing = true;
      throw err;
    }
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const l of this.loops.values()) for (const w of l.waiting) w.reject(new AppError("CANCELLED", "Server shutting down"));
    this.loops.clear();
  }
}
