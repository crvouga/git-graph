// RepositoryPort over the /api/v1 HTTP API. Used by the browser (against the hosted server or the
// local companion), by the CLI and by the MCP server. Includes a fetch-based SSE reader with
// exponential backoff + jitter and Last-Event-ID resume (EventSource cannot send auth headers).

import {
  AppError,
  parseRepoKey,
  type Capabilities,
  type Commit,
  type CommitDetails,
  type ConflictFile,
  type Diff,
  type DiffSpec,
  type EventEnvelope,
  type GitMutation,
  type HistoryPage,
  type HistoryQuery,
  type MutationPrecondition,
  type MutationResult,
  type RefsSnapshot,
  type Remote,
  type RepoInfo,
  type RepoRef,
  type RepositoryEvent,
  type WorkingTreeStatus,
  type Worktree,
  type BlameLine,
} from "../types.ts";
import type { DiffOptions, ReadOptions, RepositoryPort, RepositoryResolver, SearchQuery } from "../port.ts";

export interface HttpClientOptions {
  /** e.g. "https://app.example.com/api/v1" or "http://127.0.0.1:7420/api/v1" */
  baseUrl: string;
  /** Extra headers (companion bearer token). Never put credentials in URLs. */
  headers?: () => Record<string, string>;
  /** "include" to send session cookies to the hosted server. */
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  client?: "ui" | "cli" | "mcp";
  /** Called when the server answers 401 (session expired). */
  onUnauthenticated?: () => void;
}

export class HttpApi {
  readonly opts: HttpClientOptions;
  /** De-duplicates identical concurrent GETs. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(opts: HttpClientOptions) {
    this.opts = opts;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { accept: "application/json", "x-client": this.opts.client ?? "ui", ...(this.opts.headers?.() ?? {}), ...(extra ?? {}) };
  }

  async request<T>(method: string, path: string, body?: unknown, opts?: ReadOptions & { headers?: Record<string, string> }): Promise<{ status: number; data: T; headers: Headers }> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(this.opts.baseUrl + path, {
        method,
        headers: this.headers({ ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(opts?.headers ?? {}) }),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: this.opts.credentials,
        signal: opts?.signal,
      });
    } catch (e) {
      if (opts?.signal?.aborted) throw new AppError("CANCELLED", "Request was cancelled");
      throw new AppError("OFFLINE", `Cannot reach ${new URL(this.opts.baseUrl, "http://x").host}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 304) return { status: 304, data: undefined as T, headers: res.headers };
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw new AppError("UPSTREAM_ERROR", `Invalid JSON from server (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const err = (data as { error?: unknown })?.error ?? data;
      const e = AppError.from(err ?? { code: "UPSTREAM_ERROR", message: `HTTP ${res.status}` });
      if (e.code === "INTERNAL" && !(err && typeof err === "object")) throw new AppError("UPSTREAM_ERROR", `HTTP ${res.status}`);
      if (e.code === "UNAUTHENTICATED") this.opts.onUnauthenticated?.();
      throw e;
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  get<T>(path: string, opts?: ReadOptions): Promise<T> {
    // Dedupe only un-cancellable reads: a shared promise must not be aborted by one caller.
    if (opts?.signal) return this.request<T>("GET", path, undefined, opts).then((r) => r.data);
    const hit = this.inflight.get(path);
    if (hit) return hit as Promise<T>;
    const p = this.request<T>("GET", path).then((r) => r.data);
    this.inflight.set(path, p);
    p.finally(() => this.inflight.delete(path)).catch(() => {});
    return p;
  }

  post<T>(path: string, body: unknown, opts?: ReadOptions): Promise<T> {
    return this.request<T>("POST", path, body, opts).then((r) => r.data);
  }
}

function qs(params: Record<string, string | number | boolean | undefined | null | string[]>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) for (const x of v) u.append(k, x);
    else u.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

export class HttpRepository implements RepositoryPort {
  readonly ref: RepoRef;
  readonly key: string;
  private readonly api: HttpApi;
  private readonly base: string;
  private refsCache: RefsSnapshot | null = null;

  constructor(api: HttpApi, key: string) {
    const ref = parseRepoKey(key);
    if (!ref) throw new AppError("BAD_REQUEST", `Invalid repository key "${key}"`);
    this.ref = ref;
    this.key = key;
    this.api = api;
    this.base = `/repositories/${encodeURIComponent(key)}`;
  }

  capabilities(o?: ReadOptions) {
    return this.api.get<Capabilities>(`${this.base}/capabilities`, o);
  }
  info(o?: ReadOptions) {
    return this.api.get<RepoInfo>(this.base, o);
  }
  async refs(o?: ReadOptions): Promise<RefsSnapshot> {
    // Conditional request: unchanged refs cost a 304 and no parsing.
    const etag = this.refsCache ? `"${this.refsCache.version}"` : undefined;
    const r = await this.api.request<RefsSnapshot>("GET", `${this.base}/refs`, undefined, { ...o, headers: etag ? { "if-none-match": etag } : undefined });
    if (r.status === 304 && this.refsCache) return this.refsCache;
    this.refsCache = r.data;
    return r.data;
  }
  history(q: HistoryQuery, cursor: string | null, limit: number, o?: ReadOptions) {
    return this.api.get<HistoryPage>(
      `${this.base}/commits${qs({ ref: q.refs, remotes: q.includeRemotes, tags: q.includeTags, stashes: q.includeStashes, "first-parent": q.firstParent, order: q.order, cursor, limit })}`,
      o,
    );
  }
  commit(hash: string, o?: ReadOptions) {
    return this.api.get<CommitDetails>(`${this.base}/commits/${hash}`, o);
  }
  diff(spec: DiffSpec, o?: DiffOptions) {
    const p =
      spec.kind === "commit"
        ? { hash: spec.hash }
        : spec.kind === "compare"
          ? { base: spec.base, head: spec.head }
          : { working: spec.staged ? "staged" : "unstaged" };
    return this.api.get<Diff>(`${this.base}/diff${qs({ ...p, path: o?.path, context: o?.context })}`, o);
  }
  fileHistory(path: string, cursor: string | null, limit: number, o?: ReadOptions) {
    return this.api.get<HistoryPage>(`${this.base}/file-history${qs({ path, cursor, limit })}`, o);
  }
  blame(path: string, rev: string, o?: ReadOptions) {
    return this.api.get<BlameLine[]>(`${this.base}/blame${qs({ path, rev })}`, o);
  }
  search(q: SearchQuery, o?: ReadOptions) {
    return this.api.get<Commit[]>(`${this.base}/search${qs({ text: q.text, limit: q.limit })}`, o);
  }
  file(path: string, rev: string, o?: ReadOptions) {
    return this.api.get<{ content: string; encoding: "utf8" | "base64"; size: number }>(`${this.base}/file${qs({ path, rev })}`, o);
  }
  status(o?: ReadOptions) {
    return this.api.get<WorkingTreeStatus>(`${this.base}/status`, o);
  }
  worktrees(o?: ReadOptions) {
    return this.api.get<Worktree[]>(`${this.base}/worktrees`, o);
  }
  remotes(o?: ReadOptions) {
    return this.api.get<Remote[]>(`${this.base}/remotes`, o);
  }
  conflict(path: string, o?: ReadOptions) {
    return this.api.get<ConflictFile>(`${this.base}/conflict${qs({ path })}`, o);
  }
  mutate(m: GitMutation, precondition?: MutationPrecondition, confirm?: string): Promise<MutationResult> {
    return this.api.post<MutationResult>(`${this.base}/mutations`, { mutation: m, precondition, confirm });
  }

  subscribe(listener: (e: RepositoryEvent) => void): () => void {
    const sub = subscribeEvents(this.api, this.key, (env) => listener(env.event));
    return () => sub.close();
  }
}

export class HttpResolver implements RepositoryResolver {
  private readonly api: HttpApi;
  private readonly cache = new Map<string, HttpRepository>();
  constructor(api: HttpApi) {
    this.api = api;
  }
  async resolve(key: string) {
    let r = this.cache.get(key);
    if (!r) {
      r = new HttpRepository(this.api, key);
      this.cache.set(key, r);
    }
    return r;
  }
  list(opts?: { query?: string; limit?: number }) {
    return this.api.get<RepoInfo[]>(`/repositories${qs({ query: opts?.query, limit: opts?.limit })}`);
  }
}

// ---------------------------------------------------------------------------
// SSE over fetch
// ---------------------------------------------------------------------------

export interface EventSubscription {
  close(): void;
  readonly state: () => "connecting" | "live" | "backoff" | "closed";
}

export interface SubscribeOptions {
  /** Called on connection state changes. */
  onState?: (s: "connecting" | "live" | "backoff" | "closed", info?: { error?: string; retryInMs?: number }) => void;
  initialCursor?: string | null;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export function subscribeEvents(api: HttpApi, key: string, onEvent: (env: EventEnvelope) => void, opts: SubscribeOptions = {}): EventSubscription {
  let closed = false;
  let state: "connecting" | "live" | "backoff" | "closed" = "connecting";
  let cursor: string | null = opts.initialCursor ?? null;
  let attempt = 0;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const minB = opts.minBackoffMs ?? 500;
  const maxB = opts.maxBackoffMs ?? 30_000;
  const setState = (s: typeof state, info?: { error?: string; retryInMs?: number }) => {
    state = s;
    opts.onState?.(s, info);
  };

  const connect = async () => {
    if (closed) return;
    setState("connecting");
    ctrl = new AbortController();
    const f = api.opts.fetch ?? fetch;
    try {
      const res = await f(`${api.opts.baseUrl}/repositories/${encodeURIComponent(key)}/events`, {
        headers: { accept: "text/event-stream", "x-client": api.opts.client ?? "ui", ...(api.opts.headers?.() ?? {}), ...(cursor ? { "last-event-id": cursor } : {}) },
        credentials: api.opts.credentials,
        signal: ctrl.signal,
      });
      if (res.status === 401) api.opts.onUnauthenticated?.();
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      attempt = 0;
      setState("live");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let id: string | null = null;
          let data = "";
          let ev = "message";
          for (const line of frame.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
            else if (line.startsWith("event:")) ev = line.slice(6).trim();
          }
          if (!data) continue;
          try {
            const env = JSON.parse(data) as EventEnvelope;
            const prev = cursor;
            if (id) cursor = id;
            // A hello from a different epoch than our cursor means the server restarted: reconcile.
            if (ev === "hello" && prev && !prev.startsWith(`${env.epoch}:`)) {
              onEvent({ ...env, event: { type: "resync", repositoryId: key, reason: "server restarted" } });
              continue;
            }
            onEvent(env);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
      throw new Error("stream ended");
    } catch (e) {
      if (closed) return;
      attempt++;
      const base = Math.min(maxB, minB * 2 ** Math.min(attempt, 10));
      const delay = Math.round(base / 2 + Math.random() * (base / 2));
      setState("backoff", { error: e instanceof Error ? e.message : String(e), retryInMs: delay });
      timer = setTimeout(connect, delay);
    }
  };
  void connect();
  return {
    close() {
      closed = true;
      ctrl?.abort();
      if (timer) clearTimeout(timer);
      setState("closed");
    },
    state: () => state,
  };
}
