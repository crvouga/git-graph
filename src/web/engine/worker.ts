/// <reference lib="webworker" />
// Graph engine worker: owns repository I/O, JSON parsing, graph layout, search indexing,
// the IndexedDB cache and real-time synchronization. The UI thread only renders.
//
// Every message carries a session number. Opening a repository aborts the previous session's
// requests, and results from stale sessions are dropped, so a slow refresh of repository A can
// never overwrite the view of repository B.

import { AppError, type Capabilities, type Commit, type DiffSpec, type HistoryQuery, type RefsSnapshot, type RepoInfo, type RepositoryEvent, type WorkingTreeStatus } from "../../core/types.ts";
import type { RepositoryPort } from "../../core/port.ts";
import { HttpApi, HttpRepository, subscribeEvents, type EventSubscription } from "../../core/api/client.ts";
import { GraphLayout, NODE_NORMAL, NODE_STASH, NODE_WORKING } from "../../core/graph/layout.ts";
import * as cache from "./cache.ts";
import type { CallMessage, CancelMessage, EngineEvent, LayoutChunk, OpenArgs, RowCommit, SourceConfig, SyncInfo } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

const PAGE = 300;
const BG_PAGE = 2000;

function post(ev: EngineEvent, transfer: Transferable[] = []) {
  self.postMessage(ev, transfer);
}

function chunkTransfer(l: LayoutChunk): Transferable[] {
  return [l.nodeLane.buffer, l.nodeColor.buffer, l.edgeStart.buffer, l.edges.buffer, l.tail.buffer] as Transferable[];
}

function queryKey(repoKey: string, q: HistoryQuery): string {
  return `${repoKey}|${q.refs.join(",")}|${+q.includeRemotes}${+q.includeTags}${+q.includeStashes}${+q.firstParent}|${q.order}`;
}

async function openFsRepository(handle: FileSystemDirectoryHandle, key: string): Promise<RepositoryPort> {
  const mod = (await import("../../browser-git/repo.ts")) as Record<string, unknown>;
  const id = key.split(":")[1]!;
  const factory = (mod.openBrowserGitRepository ?? mod.createBrowserGitRepository ?? mod.openRepository) as
    | ((h: FileSystemDirectoryHandle, id: string) => Promise<RepositoryPort> | RepositoryPort)
    | undefined;
  if (typeof factory === "function") return factory(handle, id);
  const Ctor = mod.BrowserGitRepository as (new (...a: unknown[]) => RepositoryPort) & { open?: (...a: unknown[]) => Promise<RepositoryPort> };
  if (Ctor?.open) return Ctor.open(handle, id);
  throw new AppError("UNSUPPORTED", "Browser repository reader is unavailable in this build");
}

let env = { visible: true, focused: true, online: true };

class Session {
  readonly id: number;
  readonly key: string;
  readonly source: SourceConfig;
  readonly query: HistoryQuery;
  readonly ctrl = new AbortController();
  port!: RepositoryPort;
  api: HttpApi | null = null;
  info: RepoInfo | null = null;
  caps: Capabilities | null = null;
  refs: RefsSnapshot | null = null;
  status: WorkingTreeStatus | null = null;
  statusDigest = "";
  /** Real commits in display order (no working row). */
  real: Commit[] = [];
  index = new Map<string, number>();
  rows: RowCommit[] = [];
  layout: GraphLayout;
  cursor: string | null = null;
  complete = false;
  hidden = new Set<string>();
  stashes = new Set<string>();
  haystack: string[] = [];
  sync: SyncInfo = { connection: "connecting", lastSuccessAt: null, lastError: null, stale: true, fromCache: false, refsVersion: null, pending: 0, leader: false };
  private loadChain: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private sub: EventSubscription | null = null;
  private bc: BroadcastChannel | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseLock: (() => void) | null = null;
  private pollDelay = 5000;
  lastRefreshAt = 0;
  closed = false;

  constructor(a: OpenArgs) {
    this.id = a.session;
    this.key = a.repoKey;
    this.source = a.source;
    this.query = a.query;
    this.layout = new GraphLayout({ firstParent: a.query.firstParent });
  }

  get alive() {
    return !this.closed && current === this;
  }

  emit(ev: EngineEvent, transfer?: Transferable[]) {
    if (this.alive) post(ev, transfer);
  }

  setSync(p: Partial<SyncInfo>) {
    this.sync = { ...this.sync, ...p };
    this.emit({ t: "sync", session: this.id, sync: this.sync });
  }

  /** Serialize history loads so pages are appended in order. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.loadChain.then(fn, fn);
    this.loadChain = p.catch(() => {});
    return p;
  }

  // ------------------------------------------------------------------ rows

  private ingest(commits: Commit[]): Commit[] {
    const out: Commit[] = [];
    for (const c of commits) {
      if (this.index.has(c.hash) || this.hidden.has(c.hash)) continue;
      if (this.stashes.has(c.hash)) for (const p of c.parents.slice(1)) this.hidden.add(p);
      this.index.set(c.hash, this.real.length);
      this.real.push(c);
      this.haystack.push(`${c.hash} ${c.subject} ${c.author.name} ${c.author.email}`.toLowerCase());
      out.push(c);
    }
    this.layout.hide(this.hidden);
    return out;
  }

  private toRow(c: Commit): RowCommit {
    return { ...c, kind: this.stashes.has(c.hash) ? NODE_STASH : NODE_NORMAL };
  }

  private workingRow(): RowCommit | null {
    const s = this.status;
    const h = this.refs?.head;
    if (!s || !h || h.kind === "none" || h.kind === "unborn") return null;
    const n = s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length;
    if (n === 0) return null;
    if (!this.index.has(h.commit)) {
      // Only show when HEAD is part of the displayed history (Git Graph behaviour with branch filters).
      if (this.query.refs.length || this.real.length === 0) return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const me = { name: "*", email: "", date: now };
    return { hash: "working", parents: [h.commit], author: me, committer: me, subject: `Uncommitted Changes (${n})`, kind: NODE_WORKING, changes: n };
  }

  private rebuildRows(): RowCommit[] {
    const w = this.workingRow();
    const rows = this.real.map((c) => this.toRow(c));
    return w ? [w, ...rows] : rows;
  }

  private chunk(from = 0): LayoutChunk {
    return this.layout.snapshotFrom(from);
  }

  emitReset(stale: boolean) {
    const t = performance.now();
    this.rows = this.rebuildRows();
    this.layout = new GraphLayout({ firstParent: this.query.firstParent });
    this.layout.hide(this.hidden);
    this.layout.append(this.rows);
    const layout = this.chunk(0);
    this.emit({ t: "metric", name: "layout.reset.ms", value: performance.now() - t, session: this.id });
    this.emit({ t: "rows", session: this.id, kind: "reset", commits: this.rows, layout, complete: this.complete, stale, refs: this.refs! }, chunkTransfer(layout));
  }

  private emitAppend(added: Commit[]) {
    if (!added.length) {
      this.emit({ t: "rows", session: this.id, kind: "append", commits: [], layout: this.chunk(this.rows.length), complete: this.complete });
      return;
    }
    const from = this.rows.length;
    const rows = added.map((c) => this.toRow(c));
    this.rows.push(...rows);
    this.layout.append(rows);
    const layout = this.chunk(from);
    this.emit({ t: "rows", session: this.id, kind: "append", commits: rows, layout, complete: this.complete }, chunkTransfer(layout));
  }

  // ------------------------------------------------------------------ loading

  async fetchPage(limit: number): Promise<Commit[]> {
    const t = performance.now();
    let page;
    try {
      if (this.cursor === null && this.real.length > 0) {
        // No cursor for rows we already hold (cache hit or spliced refresh): re-read through them.
        page = await this.port.history(this.query, null, this.real.length + limit, { signal: this.ctrl.signal });
        page = { ...page, commits: page.commits.slice(this.real.length) };
      } else page = await this.port.history(this.query, this.cursor, limit, { signal: this.ctrl.signal });
    } catch (e) {
      const err = AppError.from(e);
      if (err.code !== "STALE_STATE" || !this.cursor) throw err;
      // Cursor no longer valid (history snapshot evicted after refs changed): re-read up to our offset.
      page = await this.port.history(this.query, null, this.real.length + limit, { signal: this.ctrl.signal });
      page = { ...page, commits: page.commits.slice(this.real.length) };
    }
    this.emit({ t: "metric", name: "history.page.ms", value: performance.now() - t, session: this.id });
    this.cursor = page.cursor;
    this.complete = page.cursor === null;
    return page.commits;
  }

  loadMore(count: number): Promise<number> {
    return this.serial(async () => {
      let need = count;
      while (need > 0 && !this.complete && this.alive) {
        const got = this.ingest(await this.fetchPage(Math.min(Math.max(need, PAGE), BG_PAGE)));
        this.emitAppend(got);
        need -= Math.max(got.length, 1);
      }
      this.persist();
      return this.rows.length;
    });
  }

  async ensure(hash: string, maxRows = 250_000): Promise<number> {
    const find = () => {
      if (hash === "working") return this.rows[0]?.hash === "working" ? 0 : -1;
      const exact = this.index.get(hash);
      if (exact !== undefined) return exact + (this.rows[0]?.kind === NODE_WORKING ? 1 : 0);
      if (hash.length < 40) {
        for (let i = 0; i < this.real.length; i++) if (this.real[i]!.hash.startsWith(hash)) return i + (this.rows[0]?.kind === NODE_WORKING ? 1 : 0);
      }
      return -1;
    };
    let r = find();
    while (r < 0 && !this.complete && this.rows.length < maxRows && this.alive) {
      await this.loadMore(BG_PAGE * 2);
      r = find();
    }
    return r;
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  persist() {
    if (this.persistTimer || !this.refs) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.refs || this.source.kind === "fs") return;
      void cache.putHistory({ key: queryKey(this.key, this.query), repoKey: this.key, refs: this.refs, commits: this.real, complete: this.complete });
    }, 500);
  }

  private setRefs(refs: RefsSnapshot) {
    this.refs = refs;
    this.stashes = new Set(refs.refs.filter((r) => r.kind === "stash").map((r) => r.commit));
  }

  async start(a: OpenArgs) {
    const t0 = performance.now();
    if (this.source.kind === "fs") {
      this.port = await openFsRepository(this.source.handle, this.key);
    } else {
      const src = this.source;
      this.api = new HttpApi({
        baseUrl: src.baseUrl,
        credentials: src.kind === "server" ? "include" : "omit",
        headers: src.kind === "companion" ? () => ({ authorization: `Bearer ${src.token}` }) : undefined,
        client: "ui",
      });
      this.port = new HttpRepository(this.api, this.key);
    }

    // 1. Stale-while-revalidate: show cached rows immediately.
    const cached = this.source.kind === "fs" ? null : await cache.getHistory(queryKey(this.key, this.query));
    if (cached && this.alive) {
      this.setRefs(cached.refs);
      this.ingest(cached.commits);
      this.complete = cached.complete;
      this.cursor = null;
      this.sync.fromCache = true;
      this.emitReset(true);
      this.emit({ t: "metric", name: "firstRows.cache.ms", value: performance.now() - t0, session: this.id });
      const meta = await cache.getMeta<{ info: RepoInfo; caps: Capabilities }>(`repo:${this.key}`);
      if (meta) {
        this.info = meta.info;
        this.caps = meta.caps;
        this.emit({ t: "repo", session: this.id, info: meta.info, caps: meta.caps });
      }
    }

    // 2. Authoritative state.
    try {
      const [info, caps, refs] = await Promise.all([
        this.port.info({ signal: this.ctrl.signal }),
        this.port.capabilities({ signal: this.ctrl.signal }),
        this.port.refs({ signal: this.ctrl.signal }),
      ]);
      if (!this.alive) return;
      this.info = info;
      this.caps = caps;
      this.emit({ t: "repo", session: this.id, info, caps });
      void cache.putMeta(`repo:${this.key}`, { info, caps });
      if (caps.workingTree.available) await this.loadStatus();
      if (cached && cached.refs.version === refs.version) {
        // Cache is current: keep rows, continue paging from a fresh cursor aligned to our offset.
        this.setRefs(refs);
        this.cursor = null;
        this.complete = cached.complete;
        this.emitReset(false);
      } else if (cached) {
        this.setRefs(refs);
        await this.applyFreshHistory(refs);
      } else {
        this.setRefs(refs);
        const first = await this.fetchPage(Math.max(PAGE, Math.min(a.initial, BG_PAGE)));
        this.ingest(first);
        this.emitReset(false);
        this.emit({ t: "metric", name: "firstRows.network.ms", value: performance.now() - t0, session: this.id });
      }
      this.lastRefreshAt = Date.now();
      this.setSync({ lastSuccessAt: Date.now(), lastError: null, stale: false, refsVersion: refs.version });
      this.persist();
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === "CANCELLED") return;
      if (cached && (err.code === "OFFLINE" || err.code === "UPSTREAM_ERROR" || err.code === "TIMEOUT")) {
        this.setSync({ connection: "offline", lastError: err.message, stale: true });
      } else {
        this.emit({ t: "error", session: this.id, error: err.toJSON() });
        this.setSync({ lastError: err.message });
        throw err;
      }
    }
    this.startSync();
  }

  async loadStatus(): Promise<boolean> {
    try {
      const s = await this.port.status({ signal: this.ctrl.signal });
      const digest = JSON.stringify([s.staged, s.unstaged, s.untracked, s.conflicted, s.operation, s.branch]);
      const changed = digest !== this.statusDigest;
      this.status = s;
      this.statusDigest = digest;
      if (changed) this.emit({ t: "status", session: this.id, status: s });
      return changed;
    } catch (e) {
      if (AppError.from(e).code === "CANCELLED") throw e;
      return false;
    }
  }

  // ------------------------------------------------------------------ refresh / reconcile

  refresh(reason: string, force = false): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.refreshAgain = false;
          await this.serial(() => this.reconcile(reason, force));
        } while (this.refreshAgain && this.alive);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async reconcile(reason: string, force: boolean) {
    if (!this.alive) return;
    const t = performance.now();
    this.setSync({ pending: this.sync.pending + 1 });
    try {
      const refs = await this.port.refs({ signal: this.ctrl.signal });
      const statusChanged = this.caps?.workingTree.available ? await this.loadStatus() : false;
      if (!this.alive) return;
      if (!force && this.refs && refs.version === this.refs.version) {
        if (statusChanged) this.spliceWorkingOnly();
      } else {
        this.setRefs(refs);
        await this.applyFreshHistory(refs);
      }
      this.lastRefreshAt = Date.now();
      this.pollDelay = 5000;
      this.setSync({ lastSuccessAt: Date.now(), lastError: null, stale: false, refsVersion: refs.version, fromCache: false });
      this.emit({ t: "metric", name: `refresh.${reason}.ms`, value: performance.now() - t, session: this.id });
      this.persist();
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === "CANCELLED") return;
      this.setSync({ lastError: err.message, stale: true, connection: err.code === "OFFLINE" ? "offline" : this.sync.connection });
      if (err.code === "UNAUTHENTICATED" || err.code === "NOT_FOUND" || err.code === "FORBIDDEN") this.emit({ t: "error", session: this.id, error: err.toJSON() });
    } finally {
      this.setSync({ pending: Math.max(0, this.sync.pending - 1) });
    }
  }

  private spliceWorkingOnly() {
    const old = this.layout;
    const oldRows = this.rows;
    const hadW = oldRows[0]?.kind === NODE_WORKING;
    const w = this.workingRow();
    const prefix = w ? [w] : [];
    const { layout, reused } = GraphLayout.rebase(old, oldRows, prefix, hadW ? 1 : 0);
    this.layout = layout;
    this.rows = [...prefix, ...oldRows.slice(hadW ? 1 : 0)];
    const chunk = this.chunk(0);
    this.emit({ t: "rows", session: this.id, kind: "splice", removeTop: hadW ? 1 : 0, insert: prefix, layout: chunk, complete: this.complete, refs: this.refs!, reusedRows: reused }, chunkTransfer(chunk));
  }

  /**
   * Refs changed: fetch the first page and align it with the rows we already have. When the new
   * page is "new commits + our existing rows", only the new prefix is laid out and the old rows are
   * spliced back (no full reload, no scroll reset). Otherwise (force-push, deleted branch reordering
   * the top of history) re-read as many rows as were loaded and reset.
   */
  private async applyFreshHistory(refs: RefsSnapshot) {
    const page = await this.port.history(this.query, null, PAGE, { signal: this.ctrl.signal });
    if (!this.alive) return;
    const stashes = new Set(refs.refs.filter((r) => r.kind === "stash").map((r) => r.commit));
    const fresh = page.commits;
    let k = -1;
    let j = -1;
    for (let i = 0; i < fresh.length; i++) {
      const at = this.index.get(fresh[i]!.hash);
      if (at !== undefined) {
        k = i;
        j = at;
        break;
      }
    }
    let aligned = k >= 0;
    if (aligned) {
      for (let t = k; t < fresh.length; t++) {
        const o = this.real[j + t - k];
        if (!o) {
          aligned = !this.complete || page.cursor === null;
          break;
        }
        if (o.hash !== fresh[t]!.hash) {
          aligned = false;
          break;
        }
      }
      // A new-prefix commit that also appears further down means the order changed.
      for (let t = 0; t < k && aligned; t++) if (this.index.has(fresh[t]!.hash)) aligned = false;
      // Stash set changes alter hidden commits/kinds: fall back to a full re-layout.
      if (aligned && !sameSet(stashes, this.stashes)) aligned = false;
    } else if (fresh.length === 0) {
      aligned = false;
    }

    if (aligned) {
      const prefixReal = fresh.slice(0, k);
      const oldRows = this.rows;
      const hadW = oldRows[0]?.kind === NODE_WORKING;
      // Rebuild indexes: drop rows above j (no longer reachable), prepend the prefix.
      const tail = this.real.slice(j);
      this.real = [];
      this.index.clear();
      this.haystack = [];
      const keepHidden = this.hidden;
      this.hidden = new Set(keepHidden);
      this.ingest(prefixReal);
      for (const c of tail) {
        this.index.set(c.hash, this.real.length);
        this.real.push(c);
        this.haystack.push(`${c.hash} ${c.subject} ${c.author.name} ${c.author.email}`.toLowerCase());
      }
      const w = this.workingRow();
      const prefixRows = [...(w ? [w] : []), ...prefixReal.map((c) => this.toRow(c))];
      const skip = (hadW ? 1 : 0) + j;
      const { layout, reused } = GraphLayout.rebase(this.layout, oldRows, prefixRows, skip);
      this.layout = layout;
      this.rows = [...prefixRows, ...oldRows.slice(skip)];
      if (page.cursor === null && tail.length === 0) this.complete = true;
      const chunk = this.chunk(0);
      this.emit({ t: "metric", name: "refresh.reusedRows", value: reused, session: this.id });
      this.emit({ t: "rows", session: this.id, kind: "splice", removeTop: skip, insert: prefixRows, layout: chunk, complete: this.complete, refs, reusedRows: reused }, chunkTransfer(chunk));
      return;
    }

    // Not aligned: reload as many rows as the user had, then reset (UI preserves selection by hash).
    const want = Math.max(PAGE, Math.min(this.real.length, 20_000));
    let commits = fresh;
    let cursor = page.cursor;
    if (want > fresh.length && cursor) {
      const more = await this.port.history(this.query, null, want, { signal: this.ctrl.signal });
      commits = more.commits;
      cursor = more.cursor;
    }
    if (!this.alive) return;
    this.real = [];
    this.index.clear();
    this.haystack = [];
    this.hidden = new Set();
    this.cursor = cursor;
    this.complete = cursor === null;
    this.ingest(commits);
    this.emitReset(false);
  }

  // ------------------------------------------------------------------ real-time sync

  private onRepoEvent(e: RepositoryEvent, fromPeer = false) {
    if (!this.alive) return;
    if (!fromPeer) this.bc?.postMessage({ type: "event", event: e });
    this.emit({ t: "event", session: this.id, event: e });
    if (e.type === "access.revoked") {
      this.emit({ t: "error", session: this.id, error: { code: "FORBIDDEN", message: "Access to this repository was revoked" } });
      return;
    }
    if (e.type === "sync.ok" || e.type === "operation.started") return;
    if (e.type === "refs.changed" && this.refs?.version === e.version) return; // already current
    // Batch bursts of events into one reconciliation.
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      void this.refresh(`event`, e.type === "resync");
    }, 30);
  }

  startSync() {
    if (!this.alive) return;
    if (typeof BroadcastChannel !== "undefined") {
      this.bc = new BroadcastChannel(`lanes:${this.key}`);
      this.bc.onmessage = (m) => {
        const d = m.data as { type: string; event?: RepositoryEvent };
        if (d.type === "event" && d.event) this.onRepoEvent(d.event, true);
      };
    }
    if (this.source.kind === "fs" || !this.api) {
      this.setSync({ connection: "polling", leader: true });
      this.schedulePoll();
      return;
    }
    const startStream = () => {
      if (!this.alive) return;
      this.setSync({ leader: true });
      this.sub = subscribeEvents(this.api!, this.key, (env) => this.onRepoEvent(env.event), {
        onState: (s, info) => {
          if (s === "live") {
            this.setSync({ connection: "live" });
            // Reconnected: we may have missed events while disconnected → reconcile.
            if (Date.now() - this.lastRefreshAt > 1000) void this.refresh("reconnect");
          } else if (s === "backoff") this.setSync({ connection: env.online ? "polling" : "offline", lastError: info?.error ?? null });
        },
      });
      this.schedulePoll();
    };
    const locks = (self.navigator as Navigator & { locks?: LockManager }).locks;
    if (locks) {
      // One tab per repository holds the real-time stream; others receive events over BroadcastChannel.
      this.setSync({ connection: "live", leader: false });
      void locks.request(`lanes:sse:${this.key}`, { signal: this.ctrl.signal }, () => {
        startStream();
        return new Promise<void>((res) => (this.releaseLock = res));
      }).catch(() => {});
      this.schedulePoll();
    } else startStream();
  }

  /** Safety-net reconciliation: slow when live, faster when polling, paused offline/hidden-long. */
  schedulePoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (!this.alive) return;
    const live = this.sync.connection === "live";
    let delay = live ? 60_000 : this.source.kind === "fs" ? 3000 : this.pollDelay;
    if (!env.visible) delay *= 6;
    if (!env.online) delay = 30_000;
    delay = Math.round(delay * (0.85 + Math.random() * 0.3));
    this.pollTimer = setTimeout(async () => {
      if (env.online) {
        const before = this.sync.refsVersion;
        await this.refresh("poll");
        // Back off while nothing changes; reset when activity is seen.
        this.pollDelay = this.sync.refsVersion === before ? Math.min(this.pollDelay * 1.5, 120_000) : 5000;
      }
      this.schedulePoll();
    }, delay);
  }

  close() {
    this.closed = true;
    this.ctrl.abort();
    this.sub?.close();
    this.bc?.close();
    this.releaseLock?.();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
  }

  // ------------------------------------------------------------------ search

  search(text: string, limit = 5000): number[] {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const off = this.rows[0]?.kind === NODE_WORKING ? 1 : 0;
    const refNames = new Map<string, string>();
    for (const r of this.refs?.refs ?? []) refNames.set(r.commit, `${refNames.get(r.commit) ?? ""} ${r.short.toLowerCase()}`);
    const out: number[] = [];
    for (let i = 0; i < this.haystack.length && out.length < limit; i++) {
      if (this.haystack[i]!.includes(q) || refNames.get(this.real[i]!.hash)?.includes(q)) out.push(i + off);
    }
    return out;
  }
}

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

let current: Session | null = null;
const inflight = new Map<number, AbortController>();

const PORT_METHODS = new Set(["info", "capabilities", "refs", "commit", "diff", "fileHistory", "blame", "search", "file", "status", "worktrees", "remotes", "conflict"]);

async function portCall(s: Session, name: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
  if (!PORT_METHODS.has(name)) throw new AppError("BAD_REQUEST", `Unknown method ${name}`);
  // Immutable results are cached by object id.
  let cacheKey: string | null = null;
  if (name === "commit" && typeof params[0] === "string" && /^[0-9a-f]{40,64}$/.test(params[0])) cacheKey = `${s.key}|commit|${params[0]}`;
  if (name === "diff") {
    const spec = params[0] as DiffSpec;
    const o = (params[1] ?? {}) as { path?: string; context?: number };
    if (spec.kind === "commit" && spec.hash.length >= 40) cacheKey = `${s.key}|diff|${spec.hash}|${o.path ?? ""}|${o.context ?? 3}`;
    if (spec.kind === "compare" && spec.base.length >= 40 && spec.head.length >= 40) cacheKey = `${s.key}|cmp|${spec.base}|${spec.head}|${o.path ?? ""}|${o.context ?? 3}`;
  }
  if (cacheKey) {
    const hit = await cache.getObject(cacheKey);
    if (hit) return hit;
  }
  const fn = (s.port as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!;
  const args = [...params];
  // Append/merge the abort signal into the options argument.
  const optIndex = name === "diff" ? 1 : name === "history" ? 3 : name === "fileHistory" ? 3 : name === "blame" || name === "file" ? 2 : name === "commit" || name === "conflict" || name === "search" ? 1 : 0;
  args[optIndex] = { ...((args[optIndex] as object) ?? {}), signal };
  const value = await fn.apply(s.port, args);
  if (cacheKey) void cache.putObject(cacheKey, value);
  return value;
}

async function handle(msg: CallMessage, signal: AbortSignal): Promise<unknown> {
  switch (msg.method) {
    case "open": {
      current?.close();
      const s = new Session(msg.args);
      current = s;
      await s.start(msg.args);
      if (msg.args.ensure && s.alive) return { row: await s.ensure(msg.args.ensure) };
      return { row: -1 };
    }
    case "close": {
      if (current?.id === msg.args.session) {
        current.close();
        current = null;
      }
      return null;
    }
    case "visibility": {
      const wasHidden = !env.visible || !env.focused || !env.online;
      env = msg.args;
      if (current && env.online && env.visible && (wasHidden || Date.now() - current.lastRefreshAt > 2000)) void current.refresh("focus");
      current?.schedulePoll();
      return null;
    }
  }
  const s = current;
  if (!s || s.id !== msg.args.session) throw new AppError("CANCELLED", "Session closed");
  switch (msg.method) {
    case "loadMore":
      return s.loadMore(msg.args.count);
    case "ensure":
      return s.ensure(msg.args.hash, msg.args.maxRows);
    case "refresh":
      await s.refresh(msg.args.reason, msg.args.force);
      return null;
    case "search": {
      const t = performance.now();
      const rows = s.search(msg.args.text, msg.args.limit);
      post({ t: "metric", name: "search.ms", value: performance.now() - t, session: s.id });
      return rows;
    }
    case "port":
      return portCall(s, msg.args.name, msg.args.params, signal);
    case "execute": {
      if (!s.api) throw new AppError("UNSUPPORTED", "This repository was opened read-only through browser file access. Run `git-graph open .` to use the local companion for Git operations.");
      const params = { ...(msg.args.params as object), repo: s.key };
      try {
        const r = await s.api.post<{ ok: boolean; result: unknown }>("/commands/execute", { command: msg.args.command, args: params, confirm: msg.args.confirm });
        return r.result;
      } finally {
        // Reconcile with authoritative state after every mutation attempt (success or failure).
        if (msg.args.command.startsWith("git.")) void s.refresh("mutation", true);
      }
    }
  }
}

self.onmessage = async (ev: MessageEvent<CallMessage | CancelMessage>) => {
  const msg = ev.data;
  if (msg.t === "cancel") {
    inflight.get(msg.id)?.abort();
    return;
  }
  const ctrl = new AbortController();
  inflight.set(msg.id, ctrl);
  try {
    const value = await handle(msg, ctrl.signal);
    self.postMessage({ t: "result", id: msg.id, ok: true, value });
  } catch (e) {
    self.postMessage({ t: "result", id: msg.id, ok: false, error: AppError.from(e).toJSON() });
  } finally {
    inflight.delete(msg.id);
  }
};
