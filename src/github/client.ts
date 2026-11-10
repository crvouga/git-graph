// GitHub REST/GraphQL client used by the GitHub adapter, the server and the sync poller.
// - Conditional requests (ETag / If-None-Match) backed by a bounded LRU keyed by
//   (token identity, URL): 304s don't count against the rate limit.
// - Immutable objects (commits by full sha, trees, blobs, history pages for a full sha) are served
//   from the cache without revalidation.
// - In-flight de-duplication of identical GETs; per-caller AbortSignal support.
// - Rate-limit tracking from x-ratelimit-* headers, secondary-limit back-off.
// - Errors are mapped to AppError codes. Tokens are never logged or included in errors.

import { createHash } from "node:crypto";
import { AppError } from "../core/types.ts";

export const DEFAULT_API_URL = "https://api.github.com";
export const DEFAULT_WEB_URL = "https://github.com";

export interface GitHubClientOptions {
  apiUrl?: string;
  webUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Max cached responses (default 5000). */
  cacheMaxEntries?: number;
  /** Max total cached body size in bytes (default 64 MiB). */
  cacheMaxBytes?: number;
  /** Per-request timeout (default 30s). */
  timeoutMs?: number;
  now?: () => number;
  /** Called when GitHub rejects a token (401). Receives the token identity, never the token. */
  onUnauthorized?: (tokenId: string) => void;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  token?: string | null;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Response never changes for this URL (full-sha objects): serve from cache without revalidating. */
  immutable?: boolean;
  /** Serve a cached response younger than this without revalidating (default 0 = always revalidate). */
  freshMs?: number;
  /** Bypass the cache entirely (still updates rate-limit state). */
  noCache?: boolean;
  accept?: string;
}

export interface GhResponse<T> {
  status: number;
  data: T;
  /** Parsed Link header: rel → URL. */
  links: Record<string, string>;
  fromCache: boolean;
  notModified: boolean;
}

export interface RateBudget {
  limit: number;
  remaining: number;
  /** Unix ms when the window resets. */
  resetAt: number;
  used: number;
  updatedAt: number;
  /** Requests blocked until this time (secondary limit / exhausted budget). */
  blockedUntil?: number;
}

export interface ClientStats {
  requests: number;
  notModified: number;
  cacheHits: number;
  deduped: number;
  errors: number;
}

export function tokenIdentity(token: string | null | undefined): string {
  return token ? `t_${createHash("sha256").update(token).digest("hex").slice(0, 20)}` : "anon";
}

interface CacheEntry {
  etag?: string;
  lastModified?: string;
  status: number;
  body: unknown;
  links: Record<string, string>;
  storedAt: number;
  immutable: boolean;
  size: number;
}

/** Size-and-count bounded LRU (Map insertion order = recency). */
export class LruCache<V> {
  private readonly map = new Map<string, { v: V; size: number }>();
  private bytes = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;
  constructor(maxEntries: number, maxBytes = Infinity) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }
  peek(k: string): V | undefined {
    return this.map.get(k)?.v;
  }
  set(k: string, v: V, size = 1): void {
    const old = this.map.get(k);
    if (old) {
      this.bytes -= old.size;
      this.map.delete(k);
    }
    if (size > this.maxBytes) return;
    this.map.set(k, { v, size });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.delete(first.value);
    }
  }
  delete(k: string): boolean {
    const e = this.map.get(k);
    if (!e) return false;
    this.bytes -= e.size;
    return this.map.delete(k);
  }
  deleteWhere(pred: (k: string) => boolean): void {
    for (const k of [...this.map.keys()]) if (pred(k)) this.delete(k);
  }
  get size(): number {
    return this.map.size;
  }
  get totalBytes(): number {
    return this.bytes;
  }
  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

export function parseLinks(h: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (m) out[m[2]!] = m[1]!;
  }
  return out;
}

function raceSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AppError("CANCELLED", "Request was cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AppError("CANCELLED", "Request was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export class GitHubClient {
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly stats: ClientStats = { requests: 0, notModified: 0, cacheHits: 0, deduped: 0, errors: 0 };
  private readonly f: typeof fetch;
  private readonly cache: LruCache<CacheEntry>;
  private readonly inflight = new Map<string, Promise<GhResponse<unknown>>>();
  private readonly budgets = new Map<string, RateBudget>();
  private readonly ua: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onUnauthorized?: (tokenId: string) => void;

  constructor(opts: GitHubClientOptions = {}) {
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.webUrl = (opts.webUrl ?? DEFAULT_WEB_URL).replace(/\/+$/, "");
    this.f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.cache = new LruCache<CacheEntry>(opts.cacheMaxEntries ?? 5000, opts.cacheMaxBytes ?? 64 * 1024 * 1024);
    this.ua = opts.userAgent ?? "lanes-git-graph";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.onUnauthorized = opts.onUnauthorized;
  }

  /** Current rate-limit budget for a token (or anonymous). */
  budget(token: string | null | undefined): RateBudget | null {
    return this.budgets.get(tokenIdentity(token)) ?? null;
  }

  /** Rate-limit budget by token identity (see tokenIdentity). */
  budgetById(tid: string): RateBudget | null {
    return this.budgets.get(tid) ?? null;
  }

  cacheInfo(): { entries: number; bytes: number } {
    return { entries: this.cache.size, bytes: this.cache.totalBytes };
  }

  /** Drop cached responses for a repository (all token identities). */
  invalidateRepo(owner: string, name: string): void {
    const needle = `/repos/${owner}/${name}`.toLowerCase();
    this.cache.deleteWhere((k) => k.toLowerCase().includes(needle));
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(path.startsWith("http") ? path : this.apiUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    return u.toString();
  }

  async get<T>(path: string, opts: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return (await this.request<T>(path, opts)).data;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<GhResponse<T>> {
    const method = opts.method ?? "GET";
    const url = this.url(path, opts.query);
    const tid = tokenIdentity(opts.token);
    this.checkBlocked(tid);
    if (method !== "GET") return this.send<T>(method, url, opts, tid, undefined);

    const key = `${tid} ${opts.accept ?? ""} ${url}`;
    const cached = opts.noCache ? undefined : this.cache.get(key);
    if (cached && (cached.immutable || (opts.freshMs && this.now() - cached.storedAt < opts.freshMs))) {
      this.stats.cacheHits++;
      return { status: cached.status, data: cached.body as T, links: cached.links, fromCache: true, notModified: false };
    }
    const existing = this.inflight.get(key);
    if (existing) {
      this.stats.deduped++;
      return raceSignal(existing as Promise<GhResponse<T>>, opts.signal);
    }
    // The shared request is not tied to any single caller's signal; each caller races its own.
    const p = this.send<T>("GET", url, { ...opts, signal: undefined }, tid, opts.noCache ? undefined : key, cached);
    this.inflight.set(key, p as Promise<GhResponse<unknown>>);
    p.finally(() => this.inflight.delete(key)).catch(() => {});
    return raceSignal(p, opts.signal);
  }

  /** GET every page following Link rel="next" (bounded). */
  async paginate<T>(path: string, opts: Omit<RequestOptions, "method" | "body"> & { maxPages?: number } = {}): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    let query = { per_page: 100, ...(opts.query ?? {}) } as RequestOptions["query"];
    for (let i = 0; next && i < (opts.maxPages ?? 10); i++) {
      const r: GhResponse<T[]> = await this.request<T[]>(next, { ...opts, query });
      out.push(...(Array.isArray(r.data) ? r.data : []));
      next = r.links.next;
      query = undefined; // the next link carries the query
    }
    return out;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, opts: { token: string; signal?: AbortSignal }): Promise<T> {
    const r = await this.request<{ data?: T; errors?: { type?: string; message: string }[] }>("/graphql", {
      method: "POST",
      token: opts.token,
      signal: opts.signal,
      body: { query, variables },
    });
    if (r.data.errors?.length) {
      const e = r.data.errors[0]!;
      if (e.type === "NOT_FOUND") throw new AppError("NOT_FOUND", e.message);
      if (e.type === "FORBIDDEN") throw new AppError("FORBIDDEN", e.message);
      if (e.type === "RATE_LIMITED") throw new AppError("RATE_LIMITED", e.message);
      throw new AppError("UPSTREAM_ERROR", `GitHub GraphQL error: ${e.message}`);
    }
    return r.data.data as T;
  }

  private checkBlocked(tid: string) {
    const b = this.budgets.get(tid);
    if (b?.blockedUntil && b.blockedUntil > this.now()) {
      const retryAfter = Math.ceil((b.blockedUntil - this.now()) / 1000);
      throw new AppError("RATE_LIMITED", `GitHub rate limit reached; retry in ${retryAfter}s`, { retryAfter });
    }
  }

  private updateBudget(tid: string, h: Headers) {
    const limit = h.get("x-ratelimit-limit");
    const remaining = h.get("x-ratelimit-remaining");
    if (limit === null || remaining === null) return;
    const prev = this.budgets.get(tid);
    this.budgets.set(tid, {
      limit: Number(limit),
      remaining: Number(remaining),
      resetAt: Number(h.get("x-ratelimit-reset") ?? 0) * 1000,
      used: Number(h.get("x-ratelimit-used") ?? 0),
      updatedAt: this.now(),
      blockedUntil: prev?.blockedUntil,
    });
  }

  private async send<T>(method: string, url: string, opts: RequestOptions, tid: string, cacheKey: string | undefined, cached?: CacheEntry): Promise<GhResponse<T>> {
    const headers: Record<string, string> = {
      accept: opts.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": this.ua,
    };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    else if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    this.stats.requests++;
    try {
      res = await this.f(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal, redirect: "follow" });
    } catch (e) {
      this.stats.errors++;
      if (opts.signal?.aborted) throw new AppError("CANCELLED", "Request was cancelled");
      if (timeout.aborted) throw new AppError("TIMEOUT", "GitHub did not respond in time");
      throw new AppError("UPSTREAM_ERROR", `Cannot reach GitHub: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.updateBudget(tid, res.headers);

    if (res.status === 304 && cached && cacheKey) {
      this.stats.notModified++;
      cached.storedAt = this.now();
      return { status: cached.status, data: cached.body as T, links: cached.links, fromCache: true, notModified: true };
    }

    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      this.stats.errors++;
      throw this.mapError(res, body, tid);
    }
    const links = parseLinks(res.headers.get("link"));
    if (cacheKey && method === "GET") {
      const etag = res.headers.get("etag") ?? undefined;
      const lastModified = res.headers.get("last-modified") ?? undefined;
      if (etag || lastModified || opts.immutable) {
        this.cache.set(cacheKey, { etag, lastModified, status: res.status, body, links, storedAt: this.now(), immutable: !!opts.immutable, size: text.length + url.length + 64 }, text.length + url.length + 64);
      }
    }
    return { status: res.status, data: body as T, links, fromCache: false, notModified: false };
  }

  private mapError(res: Response, body: unknown, tid: string): AppError {
    const msg = (body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : "") || `HTTP ${res.status}`;
    const status = res.status;
    if (status === 401) {
      this.onUnauthorized?.(tid);
      return new AppError("UNAUTHENTICATED", "GitHub rejected the credentials; sign in again");
    }
    if (status === 403 || status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfterHdr = res.headers.get("retry-after");
      const secondary = /secondary rate limit|abuse/i.test(msg);
      if (status === 429 || remaining === "0" || retryAfterHdr || secondary || /rate limit/i.test(msg)) {
        let retryAfter: number;
        if (retryAfterHdr && Number.isFinite(Number(retryAfterHdr))) retryAfter = Number(retryAfterHdr);
        else if (remaining === "0" && res.headers.get("x-ratelimit-reset")) retryAfter = Math.max(1, Number(res.headers.get("x-ratelimit-reset")) - Math.floor(this.now() / 1000));
        else retryAfter = 60;
        const b = this.budgets.get(tid);
        const blockedUntil = this.now() + retryAfter * 1000;
        if (b) b.blockedUntil = blockedUntil;
        else this.budgets.set(tid, { limit: 0, remaining: 0, resetAt: blockedUntil, used: 0, updatedAt: this.now(), blockedUntil });
        return new AppError("RATE_LIMITED", secondary ? `GitHub secondary rate limit; retry in ${retryAfter}s` : `GitHub rate limit exhausted; retry in ${retryAfter}s`, {
          retryAfter,
          secondary,
        });
      }
      return new AppError("FORBIDDEN", `GitHub denied access: ${msg}`);
    }
    if (status === 404) return new AppError("NOT_FOUND", "Not found on GitHub (or you do not have access)");
    if (status === 409) return new AppError("CONFLICT", `GitHub: ${msg}`, { upstreamStatus: 409 });
    if (status === 422) return new AppError("BAD_REQUEST", `GitHub rejected the request: ${msg}`, { upstreamStatus: 422 });
    if (status >= 500) return new AppError("UPSTREAM_ERROR", `GitHub error (HTTP ${status})`, { upstreamStatus: status });
    return new AppError("UPSTREAM_ERROR", `GitHub: ${msg} (HTTP ${status})`, { upstreamStatus: status });
  }
}
