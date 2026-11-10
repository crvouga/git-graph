// RepositoryPort over a repository read directly from disk through a DirSource (File System Access API
// in the browser). Read-only. Runs inside a Web Worker (see worker.ts / client.ts).
//
// subscribe(): this adapter has no file watcher. It returns a no-op unsubscribe; the UI keeps the view
// fresh by polling refs() (cheap: a handful of small file reads) and reloading history when
// RefsSnapshot.version changes.

import type { DiffOptions, ReadOptions, RepositoryPort, SearchQuery } from "../core/port.ts";
import {
  AppError,
  capabilities as makeCapabilities,
  DEFAULT_HISTORY_QUERY,
  repoKey,
  type BlameLine,
  type Capabilities,
  type Capability,
  type Commit,
  type CommitDetails,
  type ConflictFile,
  type Diff,
  type DiffSpec,
  type FileChange,
  type FileDiff,
  type GitMutation,
  type HistoryPage,
  type HistoryQuery,
  type MutationResult,
  type RefsSnapshot,
  type Remote,
  type RepoInfo,
  type RepoRef,
  type RepositoryEvent,
  type WorkingTreeStatus,
  type Worktree,
} from "../core/types.ts";
import { CommitStore, indexOf, orderCommits, Ticker, walkCommits, type CommitNode, type Ordering } from "./history.ts";
import { isFullHash, isHashPrefix } from "./hex.ts";
import { READ_ONLY_REASON, resolveGitLayout, type GitLayout } from "./layout.ts";
import { Lru } from "./lru.ts";
import { countChanges, isBinary, lineDiff, splitLines } from "./myers.ts";
import { ObjectDatabase, type ObjectDatabaseOptions } from "./objects.ts";
import { parseCommit, parseTag, parseTree, splitMessage, isTreeMode } from "./parse.ts";
import { readRefs, type RefsResult } from "./refs.ts";
import { joinPath, type DirSource } from "./source.ts";
import { detectRenames, diffTrees, type RawChange } from "./treediff.ts";

export const AVAILABLE: readonly Capability[] = ["history", "refs", "commit", "diff", "compare", "search", "fileHistory"];

export interface BrowserRepositoryOptions extends ObjectDatabaseOptions {
  /** Display name (the picked folder's name). */
  name?: string;
  /** Max files whose additions/deletions are counted in commit(). Default 300. */
  maxCountedFiles?: number;
  /** Max files listed in commit(). Default 3000. */
  maxFiles?: number;
  /** Max diff lines returned by diff() across all files. Default 20000. */
  maxDiffLines?: number;
  /** Blobs larger than this are not line-diffed (reported truncated). Default 4 MiB. */
  maxDiffBlobBytes?: number;
}

interface FileHistoryState {
  pos: number;
  matches: number[];
  /** Commits still to visit (reached through followed parent edges) → path tracked there. */
  reach: Map<number, string>;
  done: boolean;
}

const unsupported = (what: string) => new AppError("UNSUPPORTED", READ_ONLY_REASON, { capability: what });

function cancelled(): AppError {
  return new AppError("CANCELLED", "Request was cancelled");
}

/** Joins waiters onto one computation; the computation is aborted only when every waiter is gone. */
class Shared<T> {
  private readonly inflight = new Map<string, { p: Promise<T>; ctrl: AbortController; waiters: number }>();
  run(key: string, signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let e = this.inflight.get(key);
    if (!e) {
      const ctrl = new AbortController();
      const entry = { p: null as unknown as Promise<T>, ctrl, waiters: 0 };
      entry.p = fn(ctrl.signal).finally(() => {
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
      entry.p.catch(() => {});
      this.inflight.set(key, entry);
      e = entry;
    }
    const entry = e;
    entry.waiters++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        if (--entry.waiters === 0) {
          entry.ctrl.abort();
          if (this.inflight.get(key) === entry) this.inflight.delete(key);
        }
        reject(cancelled());
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.p.then(
        (v) => {
          if (done) return;
          done = true;
          entry.waiters--;
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (err) => {
          if (done) return;
          done = true;
          entry.waiters--;
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }
}

export class BrowserGitRepository implements RepositoryPort {
  readonly ref: RepoRef;
  readonly key: string;
  private readonly id: string;
  private readonly src: DirSource;
  private readonly opts: BrowserRepositoryOptions;
  private initP: Promise<void> | null = null;
  private layout!: GitLayout;
  private odb!: ObjectDatabase;
  private store!: CommitStore;
  private lastRefs: RefsResult | null = null;
  private readonly refsByVersion = new Lru<string, RefsResult>(4);
  private readonly orderings = new Lru<string, Ordering>(4);
  private readonly sharedOrderings = new Shared<Ordering>();
  private readonly fileHistories = new Lru<string, FileHistoryState>(8);
  private readonly pathCache = new Lru<string, string | null>(200_000);

  constructor(src: DirSource, id: string, opts: BrowserRepositoryOptions = {}) {
    this.src = src;
    this.id = id;
    this.ref = { provider: "browser", id };
    this.key = repoKey(this.ref);
    this.opts = opts;
  }

  /** Opens and validates the repository (throws AppError for non-repos / unsupported layouts). */
  static async open(src: DirSource, id: string, opts: BrowserRepositoryOptions = {}): Promise<BrowserGitRepository> {
    const r = new BrowserGitRepository(src, id, opts);
    await r.init();
    return r;
  }

  private init(): Promise<void> {
    if (!this.initP) {
      this.initP = (async () => {
        this.layout = await resolveGitLayout(this.src);
        this.odb = new ObjectDatabase(this.src, joinPath(this.layout.commonDir, "objects")!, this.opts);
        await this.odb.init();
        const shallowText = await this.src.readText(joinPath(this.layout.commonDir, "shallow")!);
        const shallow = new Set((shallowText ?? "").split("\n").map((s) => s.trim()).filter(isFullHash));
        this.store = new CommitStore(this.odb, shallow);
      })();
      this.initP.catch(() => {
        this.initP = null;
      });
    }
    return this.initP;
  }

  /** Diagnostics for tests / perf reports. */
  stats(): { commits: number; cacheBytes: number; packs: number } {
    return { commits: this.store?.size ?? 0, cacheBytes: this.odb?.cacheBytes ?? 0, packs: this.odb?.packCount ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Basics
  // -------------------------------------------------------------------------

  async capabilities(): Promise<Capabilities> {
    return makeCapabilities(AVAILABLE, () => READ_ONLY_REASON);
  }

  async info(opts?: ReadOptions): Promise<RepoInfo> {
    const refs = await this.refs(opts);
    const head = refs.head;
    let defaultBranch: string | undefined;
    const originHead = refs.refs.find((r) => r.kind === "remote" && r.short.endsWith("/HEAD") && r.symbolicTarget);
    if (originHead?.symbolicTarget) defaultBranch = originHead.symbolicTarget.replace(/^refs\/remotes\/[^/]+\//, "");
    else if (head.kind === "branch" || head.kind === "unborn") defaultBranch = head.ref.replace(/^refs\/heads\//, "");
    return { ref: this.ref, key: this.key, name: this.opts.name ?? this.id, visibility: "local", ...(defaultBranch ? { defaultBranch } : {}) };
  }

  async refs(opts?: ReadOptions): Promise<RefsSnapshot> {
    return (await this.readRefsFresh(opts)).snapshot;
  }

  private async readRefsFresh(opts?: ReadOptions): Promise<RefsResult> {
    await this.init();
    if (opts?.signal?.aborted) throw cancelled();
    const r = await readRefs(this.src, this.layout, this.odb);
    if (this.lastRefs && this.lastRefs.snapshot.version !== r.snapshot.version) await this.odb.refresh();
    const prev = this.refsByVersion.get(r.snapshot.version);
    const result = prev ?? r;
    if (!prev) this.refsByVersion.set(r.snapshot.version, r);
    this.lastRefs = result;
    return result;
  }

  private async currentRefs(opts?: ReadOptions): Promise<RefsResult> {
    return this.lastRefs ?? this.readRefsFresh(opts);
  }

  // -------------------------------------------------------------------------
  // Revisions
  // -------------------------------------------------------------------------

  /** Resolves a revision (HEAD, ref name, full/abbreviated hash, with ^N / ~N suffixes) to a commit hash. */
  async resolveRev(rev: string, refs?: RefsResult): Promise<string> {
    await this.init();
    const m = /^(.*?)((?:[~^]\d*)*)$/.exec(rev.trim())!;
    let base = m[1]!;
    const suffix = m[2]!;
    if (!base) throw new AppError("BAD_REQUEST", `Invalid revision "${rev}"`);
    refs ??= await this.currentRefs();
    let hash = await this.resolveBase(base, refs);
    if (!hash) throw new AppError("REF_NOT_FOUND", `Unknown revision "${base}"`);
    hash = await this.peelToCommit(hash);
    for (const op of suffix.match(/[~^]\d*/g) ?? []) {
      const n = op.length > 1 ? Number(op.slice(1)) : 1;
      if (op[0] === "^") {
        if (n === 0) continue;
        const c = await this.store.require(hash);
        const p = c.parents[n - 1];
        if (!p) throw new AppError("REF_NOT_FOUND", `Revision "${rev}" has no parent ${n}`);
        hash = p;
      } else {
        for (let i = 0; i < n; i++) {
          const c = await this.store.require(hash);
          if (!c.parents[0]) throw new AppError("REF_NOT_FOUND", `Revision "${rev}" goes past the root commit`);
          hash = c.parents[0];
        }
      }
    }
    return hash;
  }

  private async resolveBase(base: string, refs: RefsResult): Promise<string | null> {
    const snap = refs.snapshot;
    if (base === "HEAD" || base === "@") {
      if (snap.head.kind === "branch" || snap.head.kind === "detached") return snap.head.commit;
      throw new AppError("REF_NOT_FOUND", "HEAD does not point to a commit");
    }
    if (isFullHash(base)) return base;
    const stash = snap.refs.find((r) => r.kind === "stash" && (r.short === base || r.name === base));
    if (stash) return stash.target;
    for (const full of [base, `refs/${base}`, `refs/tags/${base}`, `refs/heads/${base}`, `refs/remotes/${base}`, `refs/remotes/${base}/HEAD`]) {
      const h = refs.all.get(full);
      if (h) return h;
    }
    if (isHashPrefix(base.toLowerCase())) {
      const found = await this.odb.resolvePrefix(base, 2);
      if (found.length > 1) throw new AppError("BAD_REQUEST", `Abbreviated hash "${base}" is ambiguous`);
      if (found.length === 1) return found[0]!;
    }
    return null;
  }

  private async peelToCommit(hash: string): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const o = await this.odb.read(hash);
      if (!o) throw new AppError("COMMIT_NOT_FOUND", `Object ${hash} not found`);
      if (o.type === "commit") return hash;
      if (o.type !== "tag") throw new AppError("BAD_REQUEST", `${hash} is a ${o.type}, not a commit`);
      hash = parseTag(o.data).object;
    }
    throw new AppError("BAD_REQUEST", "Tag chain too long");
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  private async tipsFor(query: HistoryQuery, refs: RefsResult): Promise<string[]> {
    const snap = refs.snapshot;
    const tips: string[] = [];
    if (query.refs.length) {
      for (const r of query.refs) tips.push(await this.resolveRev(r, refs));
      return tips;
    }
    if (snap.head.kind === "branch" || snap.head.kind === "detached") tips.push(snap.head.commit);
    for (const r of snap.refs) {
      if (r.kind === "head") tips.push(r.commit);
      else if (r.kind === "remote" && query.includeRemotes) tips.push(r.commit);
      else if (r.kind === "tag" && query.includeTags) tips.push(r.commit);
      else if (r.kind === "stash" && query.includeStashes) tips.push(r.commit);
    }
    return tips;
  }

  private queryKey(query: HistoryQuery): string {
    return JSON.stringify([query.refs, query.includeRemotes, query.includeTags, query.includeStashes, query.firstParent, query.order]);
  }

  private async ordering(query: HistoryQuery, refs: RefsResult, signal?: AbortSignal): Promise<Ordering> {
    const key = `${refs.snapshot.version}|${this.queryKey(query)}`;
    const hit = this.orderings.get(key);
    if (hit) return hit;
    return this.sharedOrderings.run(key, signal, async (sig) => {
      const ticker = new Ticker(sig);
      const tips = await this.tipsFor(query, refs);
      const nodes = await walkCommits(this.store, tips, query.firstParent, ticker);
      await ticker.tick();
      const order = orderCommits(nodes, tips, query.order, query.firstParent);
      const o: Ordering = { nodes, order, firstParent: query.firstParent, tips };
      this.orderings.set(key, o);
      return o;
    });
  }

  private toCommit(n: CommitNode, firstParent: boolean): Commit {
    return {
      hash: n.hash,
      parents: firstParent ? n.parents.slice(0, 1) : n.parents.slice(),
      author: { name: n.author.name, email: n.author.email, date: n.author.date },
      committer: { name: n.committer.name, email: n.committer.email, date: n.committer.date },
      subject: n.subject,
    };
  }

  /** Cursor = "<refsVersion>:<offset>". Pages are served from a cached ordering for that version. */
  async history(query: HistoryQuery, cursor: string | null, limit: number, opts?: ReadOptions): Promise<HistoryPage> {
    await this.init();
    query = { ...DEFAULT_HISTORY_QUERY, ...query };
    let offset = 0;
    let refs: RefsResult;
    if (cursor) {
      const i = cursor.lastIndexOf(":");
      offset = Number(cursor.slice(i + 1));
      if (i < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new AppError("BAD_REQUEST", "Invalid history cursor");
      // Serve the ref state the cursor was issued for when we still have it; else the current state.
      refs = this.refsByVersion.get(cursor.slice(0, i)) ?? (await this.currentRefs(opts));
    } else {
      refs = await this.readRefsFresh(opts);
    }
    const ord = await this.ordering(query, refs, opts?.signal);
    limit = Math.max(1, Math.min(limit || 100, 10_000));
    const end = Math.min(ord.order.length, offset + limit);
    const commits: Commit[] = [];
    for (let k = offset; k < end; k++) commits.push(this.toCommit(ord.nodes[ord.order[k]!]!, ord.firstParent));
    return {
      commits,
      cursor: end < ord.order.length ? `${refs.snapshot.version}:${end}` : null,
      refsVersion: refs.snapshot.version,
      total: ord.order.length,
    };
  }

  // -------------------------------------------------------------------------
  // Commits and diffs
  // -------------------------------------------------------------------------

  async commit(hash: string, opts?: ReadOptions): Promise<CommitDetails> {
    await this.init();
    const full = await this.resolveRev(hash);
    const data = await this.odb.readType(full, "commit");
    const c = parseCommit(data);
    const parents = this.store.shallow.has(full) ? [] : c.parents;
    const { subject, body } = splitMessage(c.message);
    if (opts?.signal?.aborted) throw cancelled();
    const parentTree = parents[0] ? (await this.store.require(parents[0])).tree : null;
    let changes = await detectRenames(this.odb, await diffTrees(this.odb, parentTree, c.tree));
    const maxFiles = this.opts.maxFiles ?? 3000;
    const filesTruncated = changes.length > maxFiles;
    if (filesTruncated) changes = changes.slice(0, maxFiles);
    const maxCounted = this.opts.maxCountedFiles ?? 300;
    const files: FileChange[] = [];
    const ticker = new Ticker(opts?.signal);
    for (let i = 0; i < changes.length; i++) {
      const ch = changes[i]!;
      const f: FileChange = { path: ch.path, status: ch.status };
      if (ch.oldPath) f.oldPath = ch.oldPath;
      if (i < maxCounted) {
        await ticker.tick();
        const counted = await this.countFile(ch);
        if (counted) Object.assign(f, counted);
      }
      files.push(f);
    }
    return {
      hash: full,
      parents: parents.slice(),
      author: { name: c.author.name, email: c.author.email, date: c.author.date },
      committer: { name: c.committer.name, email: c.committer.email, date: c.committer.date },
      subject,
      body,
      files,
      ...(filesTruncated ? { filesTruncated } : {}),
      signature: c.signed ? { status: "unknown" } : { status: "none" },
    };
  }

  private async blob(hash: string | undefined): Promise<Uint8Array> {
    if (!hash) return new Uint8Array(0);
    return this.odb.readType(hash, "blob");
  }

  private async countFile(ch: RawChange): Promise<{ additions?: number; deletions?: number; binary?: boolean } | null> {
    if ((ch.oldMode ?? "").startsWith("160") || (ch.newMode ?? "").startsWith("160")) return null;
    const [a, b] = await Promise.all([this.blob(ch.oldHash), this.blob(ch.newHash)]);
    if (isBinary(a) || isBinary(b)) return { binary: true };
    if (a.length + b.length > 2 * 1024 * 1024) return null;
    if (ch.oldHash === ch.newHash) return { additions: 0, deletions: 0 };
    return countChanges(splitLines(a), splitLines(b));
  }

  async diff(spec: DiffSpec, opts?: DiffOptions): Promise<Diff> {
    await this.init();
    let oldTree: string | null;
    let newTree: string;
    if (spec.kind === "commit") {
      const c = await this.store.require(await this.resolveRev(spec.hash));
      newTree = c.tree;
      oldTree = c.parents[0] ? (await this.store.require(c.parents[0])).tree : null;
    } else if (spec.kind === "compare") {
      const [b, h] = await Promise.all([this.resolveRev(spec.base), this.resolveRev(spec.head)]);
      oldTree = (await this.store.require(b)).tree;
      newTree = (await this.store.require(h)).tree;
    } else {
      throw unsupported("workingTree");
    }
    let changes = await detectRenames(this.odb, await diffTrees(this.odb, oldTree, newTree));
    if (opts?.path) {
      const p = opts.path.replace(/^\/+|\/+$/g, "");
      changes = changes.filter((c) => c.path === p || c.oldPath === p || c.path.startsWith(p + "/") || (c.oldPath ?? "").startsWith(p + "/"));
    }
    const context = opts?.context ?? 3;
    const maxLines = this.opts.maxDiffLines ?? 20_000;
    const maxBlob = this.opts.maxDiffBlobBytes ?? 4 * 1024 * 1024;
    const ticker = new Ticker(opts?.signal);
    let budget = maxLines;
    const files: FileDiff[] = [];
    for (const ch of changes) {
      await ticker.tick();
      const fd: FileDiff = { path: ch.path, status: ch.status, binary: false, hunks: [] };
      if (ch.oldPath) fd.oldPath = ch.oldPath;
      const gitlink = (ch.oldMode ?? "").startsWith("160") || (ch.newMode ?? "").startsWith("160");
      if (gitlink) {
        const text = (h?: string) => (h ? [`Subproject commit ${h}`] : []);
        if (budget > 0) {
          const r = lineDiff({ lines: text(ch.oldHash), noEol: false }, { lines: text(ch.newHash), noEol: false }, context);
          fd.hunks = r.hunks;
        } else fd.truncated = true;
        files.push(fd);
        continue;
      }
      if (budget <= 0) {
        // Diff output budget spent: list the remaining files without content.
        fd.truncated = true;
        files.push(fd);
        continue;
      }
      const [a, b] = await Promise.all([this.blob(ch.oldHash), this.blob(ch.newHash)]);
      fd.oldSize = a.length;
      fd.newSize = b.length;
      if (isBinary(a) || isBinary(b)) {
        fd.binary = true;
      } else if (a.length > maxBlob || b.length > maxBlob) {
        fd.truncated = true;
      } else if (ch.oldHash !== ch.newHash) {
        const r = lineDiff(splitLines(a), splitLines(b), context, budget);
        fd.hunks = r.hunks;
        if (r.truncated) fd.truncated = true;
        budget -= r.hunks.reduce((s, h) => s + h.lines.length, 0);
      }
      files.push(fd);
    }
    return { spec, files };
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  /** Entry (hash + mode) at `path` inside `tree`, cached per (tree, path). */
  private async entryAt(tree: string, path: string): Promise<string | null> {
    const key = `${tree}\u0000${path}`;
    const hit = this.pathCache.get(key);
    if (hit !== undefined) return hit;
    const slash = path.indexOf("/");
    const name = slash < 0 ? path : path.slice(0, slash);
    const o = await this.odb.read(tree);
    let result: string | null = null;
    if (o && o.type === "tree") {
      const e = parseTree(o.data).find((x) => x.name === name);
      if (e) {
        if (slash < 0) result = `${e.hash} ${e.mode}`;
        else if (isTreeMode(e.mode)) result = await this.entryAt(e.hash, path.slice(slash + 1));
      }
    }
    this.pathCache.set(key, result);
    return result;
  }

  async file(path: string, rev: string, opts?: ReadOptions): Promise<{ content: string; encoding: "utf8" | "base64"; size: number }> {
    await this.init();
    const c = await this.store.require(await this.resolveRev(rev));
    if (opts?.signal?.aborted) throw cancelled();
    const e = await this.entryAt(c.tree, path.replace(/^\/+/, ""));
    if (!e) throw new AppError("NOT_FOUND", `${path} does not exist at ${rev}`);
    const [hash, mode] = e.split(" ");
    if (isTreeMode(mode!)) throw new AppError("BAD_REQUEST", `${path} is a directory`);
    if (mode!.startsWith("160")) return { content: `Subproject commit ${hash}\n`, encoding: "utf8", size: 0 };
    const data = await this.blob(hash);
    if (!isBinary(data)) {
      try {
        return { content: new TextDecoder("utf-8", { fatal: true }).decode(data), encoding: "utf8", size: data.length };
      } catch {
        // not valid UTF-8: fall through to base64
      }
    }
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { content: btoa(bin), encoding: "base64", size: data.length };
  }

  /**
   * Commits (over all refs, date order) where the blob at `path` differs from every parent's
   * (merges identical to one parent are skipped, like git's history simplification). Exact renames
   * are followed: when the path appears in a commit, the parent continues with the old path.
   */
  async fileHistory(path: string, cursor: string | null, limit: number, opts?: ReadOptions): Promise<HistoryPage> {
    await this.init();
    path = path.replace(/^\/+|\/+$/g, "");
    let offset = 0;
    let refs: RefsResult;
    if (cursor) {
      const i = cursor.lastIndexOf(":");
      offset = Number(cursor.slice(i + 1));
      if (i < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new AppError("BAD_REQUEST", "Invalid history cursor");
      refs = this.refsByVersion.get(cursor.slice(0, i)) ?? (await this.currentRefs(opts));
    } else refs = await this.readRefsFresh(opts);
    limit = Math.max(1, Math.min(limit || 100, 10_000));
    const ord = await this.ordering(DEFAULT_HISTORY_QUERY, refs, opts?.signal);
    const key = `${refs.snapshot.version}|${path}`;
    let st = this.fileHistories.get(key);
    if (!st) {
      st = { pos: 0, matches: [], reach: new Map(), done: false };
      for (const t of ord.tips) {
        const i = indexOf(ord, t);
        if (i !== undefined) st.reach.set(i, path);
      }
      this.fileHistories.set(key, st);
    }
    const ticker = new Ticker(opts?.signal);
    const hashOf = (e: string | null) => (e ? e.slice(0, 40) : null);
    while (!st.done && st.matches.length < offset + limit + 1) {
      if (st.pos >= ord.order.length) {
        st.done = true;
        break;
      }
      await ticker.tick();
      const ni = ord.order[st.pos++]!;
      const p = st.reach.get(ni);
      if (p === undefined) continue; // pruned by history simplification
      st.reach.delete(ni);
      const node = ord.nodes[ni]!;
      const mine = await this.entryAt(node.tree, p);
      const myHash = hashOf(mine);
      const parents: { pi: number | undefined; tree: string; hash: string | null }[] = [];
      for (const ph of node.parents) {
        const parent = await this.store.get(ph);
        if (!parent) continue;
        parents.push({ pi: indexOf(ord, ph), tree: parent.tree, hash: hashOf(await this.entryAt(parent.tree, p)) });
      }
      const follow = (pi: number | undefined, nextPath: string) => {
        if (pi === undefined) return;
        const cur = st.reach.get(pi);
        // A followed rename wins over reaching the same commit with the original path.
        if (cur === undefined || (cur === path && nextPath !== path)) st.reach.set(pi, nextPath);
      };
      // git's default history simplification: a commit TREESAME to a parent is not shown and only
      // that parent is followed; otherwise it is shown and every parent is followed.
      const same = parents.find((x) => x.hash === myHash);
      if (!parents.length) {
        if (myHash !== null) st.matches.push(ni);
      } else if (same) {
        follow(same.pi, p);
      } else {
        st.matches.push(ni);
        for (const x of parents) {
          let nextPath = p;
          if (myHash && !x.hash && !isTreeMode(mine!.slice(41))) {
            // Exact rename: a path deleted relative to this parent that had the same blob.
            const changes = await diffTrees(this.odb, x.tree, node.tree);
            const src = changes.find((c) => c.status === "D" && c.oldHash === myHash);
            if (src) nextPath = src.path;
          }
          follow(x.pi, nextPath);
        }
      }
    }
    const end = Math.min(st.matches.length, offset + limit);
    const commits = st.matches.slice(offset, end).map((ni) => this.toCommit(ord.nodes[ni]!, false));
    const more = end < st.matches.length || !st.done;
    return { commits, cursor: more ? `${refs.snapshot.version}:${end}` : null, refsVersion: refs.snapshot.version, ...(st.done ? { total: st.matches.length } : {}) };
  }

  async search(q: SearchQuery, opts?: ReadOptions): Promise<Commit[]> {
    await this.init();
    const refs = await this.currentRefs(opts);
    const ord = await this.ordering(DEFAULT_HISTORY_QUERY, refs, opts?.signal);
    const text = q.text.trim().toLowerCase();
    if (!text) return [];
    const fields = new Set(q.fields ?? ["hash", "subject", "author", "ref"]);
    const limit = q.limit ?? 100;
    const refHits = new Set<string>();
    if (fields.has("ref")) for (const r of refs.snapshot.refs) if (r.short.toLowerCase().includes(text) || r.name.toLowerCase().includes(text)) refHits.add(r.commit);
    const hashSearch = fields.has("hash") && /^[0-9a-f]{4,40}$/.test(text);
    const out: Commit[] = [];
    const ticker = new Ticker(opts?.signal);
    for (let k = 0; k < ord.order.length && out.length < limit; k++) {
      if ((k & 1023) === 0) await ticker.tick();
      const n = ord.nodes[ord.order[k]!]!;
      let hit =
        (hashSearch && n.hash.startsWith(text)) ||
        refHits.has(n.hash) ||
        (fields.has("subject") && n.subject.toLowerCase().includes(text)) ||
        (fields.has("author") && (n.author.name.toLowerCase().includes(text) || n.author.email.toLowerCase().includes(text)));
      if (!hit && fields.has("body")) {
        const o = await this.odb.read(n.hash);
        if (o) hit = splitMessage(parseCommit(o.data).message).body.toLowerCase().includes(text);
      }
      if (hit) out.push(this.toCommit(n, false));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Unsupported in browser mode
  // -------------------------------------------------------------------------

  async blame(_path: string, _rev: string): Promise<BlameLine[]> {
    throw unsupported("blame");
  }
  async status(): Promise<WorkingTreeStatus> {
    throw unsupported("workingTree");
  }
  async worktrees(): Promise<Worktree[]> {
    throw unsupported("worktrees");
  }
  async remotes(): Promise<Remote[]> {
    throw unsupported("remotes");
  }
  async conflict(_path: string): Promise<ConflictFile> {
    throw unsupported("conflicts");
  }
  async mutate(m: GitMutation): Promise<MutationResult> {
    throw new AppError("UNSUPPORTED", READ_ONLY_REASON, { op: m.op });
  }
  /** No watcher in browser mode: the UI polls refs(). */
  subscribe(_listener: (e: RepositoryEvent) => void): () => void {
    return () => {};
  }
}
