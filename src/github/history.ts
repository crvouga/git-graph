// Multi-branch history for GitHub, Git-Graph style.
//
// GitHub only offers one commit stream per starting point (`GET /commits?sha=<tip>`), each in
// committer-date order. We k-way merge those streams by committer date, de-duplicate by sha and
// enforce graph order over what is loaded:
//
//  - a commit is emitted only when no loaded-but-unemitted child exists (children first), and
//  - only when every still-active stream has advanced past its date (or has loaded it itself),
//    so a child arriving in a later page from another stream cannot appear after its parent.
//
// Streams that only re-walk history another stream is already covering are retired early: once
// every parent a stream still needs is known, the other streams are responsible for those
// ancestors. With many branches sharing `main`'s history this avoids paging the same commits once
// per branch, and branch tips already contained in loaded history cost no request at all.
//
// The cursor is opaque: it encodes the stream tips (full shas, so every page is immutable and
// cacheable) and the number of commits emitted. A live merge state is kept in a bounded cache keyed
// by cursor; when it is evicted, the state is rebuilt deterministically by replaying the merge
// over cached immutable pages.

import { AppError, type Commit } from "../core/types.ts";
import { LruCache } from "./client.ts";

export interface StreamSpec {
  /** Display id (e.g. "refs/heads/main"); informational. */
  id: string;
  /** Full commit sha the stream starts from. */
  tip: string;
}

export interface PageLoad {
  commits: Commit[];
  /** True when there are no further pages. */
  last: boolean;
}

export type PageLoader = (tip: string, page: number, signal?: AbortSignal) => Promise<PageLoad>;

interface Stream {
  id: string;
  tip: string;
  pagesLoaded: number;
  exhausted: boolean;
  retired: boolean;
  /** Committer date of the last loaded commit; +Infinity before the first page. */
  frontier: number;
  idx: number;
  /** Parents of this stream's loaded commits that are not known yet. */
  dangling: Set<string>;
}

interface PoolEntry {
  commit: Commit;
  /** Streams that loaded this commit. */
  by: Set<number>;
}

export interface MergeStats {
  pagesLoaded: number;
  /** Commits whose child arrived after the commit was already emitted (should be 0). */
  lateChildren: number;
}

export class HistoryMerge {
  readonly streams: Stream[];
  readonly firstParent: boolean;
  emittedCount = 0;
  readonly stats: MergeStats = { pagesLoaded: 0, lateChildren: 0 };
  private readonly pool = new Map<string, PoolEntry>();
  private readonly emitted = new Set<string>();
  /** parent sha → number of unemitted pool children. */
  private readonly pendingChildren = new Map<string, number>();
  /** First-parent mode: shas on a first-parent chain from a tip. */
  private readonly fp = new Set<string>();
  private readonly load: PageLoader;
  private readonly concurrency: number;

  constructor(specs: StreamSpec[], load: PageLoader, opts: { firstParent?: boolean; concurrency?: number } = {}) {
    const seen = new Set<string>();
    this.streams = [];
    for (const s of specs) {
      if (seen.has(s.tip)) continue; // two refs on one commit share a stream
      seen.add(s.tip);
      this.streams.push({ idx: this.streams.length, id: s.id, tip: s.tip, pagesLoaded: 0, exhausted: false, retired: false, frontier: Infinity, dangling: new Set([s.tip]) });
      if (opts.firstParent) this.fp.add(s.tip);
    }
    this.load = load;
    this.firstParent = !!opts.firstParent;
    this.concurrency = opts.concurrency ?? 6;
  }

  /** Approximate memory weight, for cache bounding. */
  weight(): number {
    return this.emitted.size + this.pool.size * 4 + 1;
  }

  done(): boolean {
    return this.pool.size === 0 && this.streams.every((s) => s.exhausted || s.retired);
  }

  private known(sha: string): boolean {
    return this.pool.has(sha) || this.emitted.has(sha);
  }

  private active(): Stream[] {
    return this.streams.filter((s) => !s.exhausted && !s.retired);
  }

  private refreshRetirement() {
    for (const s of this.streams) {
      if (s.exhausted || s.retired) continue;
      for (const d of s.dangling) if (this.known(d)) s.dangling.delete(d);
      if (s.dangling.size === 0) s.retired = true;
    }
  }

  private ingest(idx: number, page: PageLoad) {
    const s = this.streams[idx]!;
    s.pagesLoaded++;
    this.stats.pagesLoaded++;
    for (const c of page.commits) {
      s.dangling.delete(c.hash);
      if (!this.known(c.hash)) {
        this.pool.set(c.hash, { commit: c, by: new Set([idx]) });
        for (const p of c.parents) {
          if (this.emitted.has(p)) this.stats.lateChildren++;
          else this.pendingChildren.set(p, (this.pendingChildren.get(p) ?? 0) + 1);
        }
      } else {
        this.pool.get(c.hash)?.by.add(idx);
      }
      for (const p of c.parents) if (!this.known(p)) s.dangling.add(p);
      s.frontier = c.committer.date;
    }
    if (page.last || page.commits.length === 0) s.exhausted = true;
  }

  /** Streams that may still produce a commit newer than (or a child of) `e`. */
  private blockers(e: PoolEntry, actives: Stream[]): Stream[] {
    const d = e.commit.committer.date;
    return actives.filter((s) => !e.by.has(s.idx) && !(s.frontier < d));
  }

  private best(): { entry: PoolEntry | null; blocking: Stream[] } {
    const actives = this.active();
    let top: PoolEntry | null = null; // newest commit without unemitted children
    for (const e of this.pool.values()) {
      if ((this.pendingChildren.get(e.commit.hash) ?? 0) > 0) continue;
      if (!top || cmp(e.commit, top.commit) < 0) top = e;
    }
    if (!top) return { entry: null, blocking: actives };
    const blocking = this.blockers(top, actives);
    return blocking.length ? { entry: null, blocking } : { entry: top, blocking };
  }

  private async loadStreams(list: Stream[], signal?: AbortSignal) {
    // The default stream (index 0) loads alone first so branch tips it already contains retire for free.
    if (this.streams[0] && list.includes(this.streams[0]) && this.streams[0].pagesLoaded === 0 && list.length > 1) list = [this.streams[0]];
    list = list.slice(0, this.concurrency);
    const results = await Promise.all(list.map((s) => this.load(s.tip, s.pagesLoaded + 1, signal)));
    // Ingest in stream order so the merge stays deterministic regardless of network timing.
    list.forEach((s, i) => this.ingest(s.idx, results[i]!));
    this.refreshRetirement();
  }

  private take(e: PoolEntry): Commit | null {
    const c = e.commit;
    this.pool.delete(c.hash);
    this.emitted.add(c.hash);
    for (const p of c.parents) {
      const n = (this.pendingChildren.get(p) ?? 0) - 1;
      if (n > 0) this.pendingChildren.set(p, n);
      else this.pendingChildren.delete(p);
    }
    this.pendingChildren.delete(c.hash);
    if (!this.firstParent) return c;
    if (!this.fp.has(c.hash)) return null;
    this.fp.delete(c.hash);
    if (c.parents[0]) this.fp.add(c.parents[0]);
    return { ...c, parents: c.parents.slice(0, 1) };
  }

  /** Emit up to `limit` more commits; `skip` discards the first N (cursor replay). */
  async next(limit: number, signal?: AbortSignal, skip = 0): Promise<Commit[]> {
    const out: Commit[] = [];
    let skipped = 0;
    let guard = 0;
    this.refreshRetirement();
    while (out.length < limit) {
      if (signal?.aborted) throw new AppError("CANCELLED", "Request was cancelled");
      const { entry, blocking } = this.best();
      if (entry) {
        const c = this.take(entry);
        if (!c) continue;
        this.emittedCount++;
        if (skipped < skip) {
          skipped++;
          continue;
        }
        out.push(c);
        continue;
      }
      if (!blocking.length) break; // exhausted
      await this.loadStreams(blocking, signal);
      if (++guard > 100_000) throw new AppError("INTERNAL", "History merge did not converge");
    }
    return out;
  }
}

/** Newest first; ties broken by sha for determinism. */
function cmp(a: Commit, b: Commit): number {
  if (a.committer.date !== b.committer.date) return b.committer.date - a.committer.date;
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Cursor + state cache
// ---------------------------------------------------------------------------

export interface HistoryCursor {
  v: 1;
  /** Stream tips. */
  t: StreamSpec[];
  /** Commits emitted so far. */
  n: number;
  /** Refs version the tips came from. */
  rv: string;
  fp?: 1;
  /** Pages loaded per stream at the boundary (informational). */
  p?: number[];
}

export function encodeCursor(c: HistoryCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(s: string): HistoryCursor {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as HistoryCursor;
    if (c.v !== 1 || !Array.isArray(c.t) || !Number.isSafeInteger(c.n) || c.n < 0 || typeof c.rv !== "string") throw new Error("shape");
    for (const t of c.t) if (typeof t.tip !== "string" || !/^[0-9a-f]{40}$/.test(t.tip) || typeof t.id !== "string") throw new Error("tip");
    if (c.t.length > 200) throw new Error("too many tips");
    return c;
  } catch {
    throw new AppError("BAD_REQUEST", "Invalid history cursor");
  }
}

/** Bounded cache of live merge states keyed by (token identity, cursor). */
export class HistoryStateCache {
  private readonly lru: LruCache<HistoryMerge>;
  constructor(maxStates = 64, maxWeight = 400_000) {
    this.lru = new LruCache<HistoryMerge>(maxStates, maxWeight);
  }
  take(key: string): HistoryMerge | undefined {
    const m = this.lru.peek(key);
    if (m) this.lru.delete(key);
    return m;
  }
  put(key: string, m: HistoryMerge): void {
    this.lru.set(key, m, m.weight());
  }
  clear(): void {
    this.lru.clear();
  }
  get size(): number {
    return this.lru.size;
  }
}
