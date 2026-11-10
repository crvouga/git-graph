// RepositoryPort over the GitHub API. Read-mostly: history, refs, commits, diffs, compare,
// file history, blame (GraphQL, signed in), search, file contents. Mutations only where GitHub has
// a real API (branches, tags) and only with write permission. Everything that needs a working tree
// throws UNSUPPORTED with the same reason capabilities() reports.

import { createHash } from "node:crypto";
import {
  AppError,
  capabilities,
  repoKey,
  type BlameLine,
  type Capabilities,
  type Capability,
  type Commit,
  type CommitDetails,
  type ConflictFile,
  type Diff,
  type DiffSpec,
  type GitMutation,
  type HistoryPage,
  type HistoryQuery,
  type MutationPrecondition,
  type MutationResult,
  type Person,
  type Ref,
  type RefsSnapshot,
  type Remote,
  type RepoInfo,
  type RepoRef,
  type RepositoryEvent,
  type WorkingTreeStatus,
  type Worktree,
} from "../core/types.ts";
import type { DiffOptions, ReadOptions, RepositoryPort, SearchQuery } from "../core/port.ts";
import type { EventHub } from "../core/sync/hub.ts";
import { isValidRefName } from "../core/url/state.ts";
import { tokenIdentity, type GitHubClient, type RequestOptions } from "./client.ts";
import { decodeCursor, encodeCursor, HistoryMerge, HistoryStateCache, type StreamSpec } from "./history.ts";
import { toFileChange, toFileDiff, type GhFile } from "./patch.ts";

export const LOCAL_ONLY_REASON =
  "GitHub repositories have no working tree, index or worktrees. Use the git-graph CLI companion for local repositories.";
export const SIGN_IN_WRITE_REASON = "Sign in to GitHub to create, rename and delete branches and tags";
export const SIGN_IN_BLAME_REASON = "Sign in to GitHub to use blame";

const SPECIFIC_REASONS: Partial<Record<Capability, string>> = {
  merge: "GitHub has no checked-out branch; merge via a pull request or use the CLI companion",
  rebase: "GitHub has no checked-out branch; rebase locally with the CLI companion",
  interactiveRebase: "Interactive rebase needs a local repository; use the CLI companion",
  cherryPick: "Cherry-pick needs a working tree; use the CLI companion",
  revert: "Revert needs a working tree; use the CLI companion (or revert a pull request on GitHub)",
  reset: "GitHub has no checked-out branch to reset; use the CLI companion",
  commitWrite: "Committing needs a working tree; use the CLI companion",
  push: "The hosted app reads GitHub directly, so there is nothing to push; use the CLI companion",
  fetch: "The hosted app always reads GitHub directly, so there is nothing to fetch",
  pull: "The hosted app always reads GitHub directly, so there is nothing to pull",
  clone: "Clone with the CLI companion to work on a local copy",
  runGit: "Arbitrary git commands need a local repository; use the CLI companion",
  watch: "File watching applies to local repositories; GitHub repositories update through webhooks and polling",
};

const OP_REASONS: Partial<Record<GitMutation["op"], string>> = {
  merge: SPECIFIC_REASONS.merge,
  rebase: SPECIFIC_REASONS.rebase,
  "cherry-pick": SPECIFIC_REASONS.cherryPick,
  revert: SPECIFIC_REASONS.revert,
  reset: SPECIFIC_REASONS.reset,
  commit: SPECIFIC_REASONS.commitWrite,
  push: SPECIFIC_REASONS.push,
  "tag.push": "Tags created here already live on GitHub; there is nothing to push",
  fetch: SPECIFIC_REASONS.fetch,
  pull: SPECIFIC_REASONS.pull,
  checkout: "GitHub has no checked-out branch; use the CLI companion to check out locally",
  "git.run": SPECIFIC_REASONS.runGit,
};

// ---------------------------------------------------------------------------
// GitHub wire types (subset)
// ---------------------------------------------------------------------------

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  visibility?: "public" | "private" | "internal";
  default_branch: string;
  description?: string | null;
  html_url: string;
  archived?: boolean;
  pushed_at?: string;
  updated_at?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

interface GhPerson {
  name?: string;
  email?: string;
  date?: string;
}

export interface GhCommit {
  sha: string;
  parents: { sha: string }[];
  commit: { author: GhPerson | null; committer: GhPerson | null; message: string; verification?: { verified: boolean; reason: string } };
  files?: GhFile[];
}

interface GhRef {
  ref: string;
  object: { sha: string; type: "commit" | "tag" | "tree" | "blob" };
}

function person(p: GhPerson | null | undefined): Person {
  return { name: p?.name ?? "", email: p?.email ?? "", date: p?.date ? Math.floor(Date.parse(p.date) / 1000) : 0 };
}

export function toCommit(c: GhCommit): Commit {
  const msg = c.commit.message ?? "";
  const nl = msg.indexOf("\n");
  return {
    hash: c.sha,
    parents: c.parents.map((p) => p.sha),
    author: person(c.commit.author),
    committer: person(c.commit.committer),
    subject: nl >= 0 ? msg.slice(0, nl) : msg,
  };
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const PERMISSION_RANK = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 } as const;

function permissionOf(r: GhRepo): RepoInfo["permission"] | undefined {
  const p = r.permissions;
  if (!p) return undefined;
  if (p.admin) return "admin";
  if (p.maintain) return "maintain";
  if (p.push) return "write";
  if (p.triage) return "triage";
  if (p.pull) return "read";
  return "none";
}

function encPath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** Shared, short-lived memo of "this repository is public" checks for server-token reads. */
export class PublicityCache {
  private readonly m = new Map<string, { isPublic: boolean; at: number }>();
  readonly ttlMs: number;
  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }
  get(key: string, now = Date.now()): boolean | undefined {
    const e = this.m.get(key);
    if (!e || now - e.at > this.ttlMs) return undefined;
    return e.isPublic;
  }
  set(key: string, isPublic: boolean, now = Date.now()) {
    this.m.set(key, { isPublic, at: now });
    if (this.m.size > 10_000) this.m.delete(this.m.keys().next().value!);
  }
  invalidate(key: string) {
    this.m.delete(key);
  }
  clear() {
    this.m.clear();
  }
}

export interface GitHubAdapterOptions {
  owner: string;
  name: string;
  /** User access token, or the server's public token when `requirePublic` is set. Null = anonymous. */
  token?: string | null;
  api: GitHubClient;
  /** True when `token` is a server-side token used for an anonymous caller: only public repos are served. */
  requirePublic?: boolean;
  publicity?: PublicityCache;
  hub?: EventHub;
  historyCache?: HistoryStateCache;
  /** Commits per GitHub page (max 100). */
  pageSize?: number;
  /** Max branches merged into the default history view. */
  branchCap?: number;
  /** Serve repo metadata from cache for this long without revalidation (default 5s). */
  infoFreshMs?: number;
  /** Called after a successful mutation (e.g. to reconcile refs and notify subscribers). */
  onMutated?: (key: string) => void;
}

export class GitHubAdapter implements RepositoryPort {
  readonly ref: RepoRef;
  readonly key: string;
  readonly owner: string;
  readonly name: string;
  private readonly token: string | null;
  private readonly api: GitHubClient;
  private readonly opts: GitHubAdapterOptions;
  private readonly tid: string;
  private infoMemo: Promise<{ info: RepoInfo; raw: GhRepo }> | null = null;
  private readonly historyCache: HistoryStateCache;

  constructor(opts: GitHubAdapterOptions) {
    this.owner = opts.owner;
    this.name = opts.name;
    this.ref = { provider: "github", owner: opts.owner, name: opts.name };
    this.key = repoKey(this.ref);
    this.token = opts.token ?? null;
    this.api = opts.api;
    this.opts = opts;
    this.tid = tokenIdentity(this.token);
    this.historyCache = opts.historyCache ?? new HistoryStateCache(8);
  }

  /** Identity of the token used for GitHub calls (never the token itself). */
  get tokenId(): string {
    return this.tid;
  }

  /** True when acting for a signed-in user (not anonymous, not the server's public token). */
  get userAuthenticated(): boolean {
    return !!this.token && !this.opts.requirePublic;
  }

  private get base(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}`;
  }

  private req<T>(path: string, o: RequestOptions = {}) {
    return this.api.request<T>(path.startsWith("/") ? path : `${this.base}/${path}`, { token: this.token, ...o });
  }

  private async get<T>(path: string, o: RequestOptions = {}): Promise<T> {
    await this.guard(o.signal);
    return (await this.req<T>(path, o)).data;
  }

  /**
   * Every read first proves the caller can see the repository (memoized per adapter instance, and
   * served from a short freshness window / ETag revalidation). Cached immutable objects are thus
   * never served to a caller who lost access. With the server's public token, anything not
   * verifiably public is refused as NOT_FOUND.
   */
  private async guard(signal?: AbortSignal): Promise<void> {
    if (this.opts.requirePublic && this.opts.publicity?.get(this.key) === false) {
      throw new AppError("NOT_FOUND", "Not found on GitHub (or you do not have access)");
    }
    await this.loadInfo(signal);
  }

  private loadInfo(signal?: AbortSignal): Promise<{ info: RepoInfo; raw: GhRepo }> {
    if (!this.infoMemo) {
      this.infoMemo = (async () => {
        const raw = (await this.req<GhRepo>(this.base, { signal, freshMs: this.opts.infoFreshMs ?? 5000 })).data;
        if (this.opts.requirePublic) {
          const isPublic = raw.private === false && (raw.visibility === undefined || raw.visibility === "public");
          this.opts.publicity?.set(this.key, isPublic);
          if (!isPublic) throw new AppError("NOT_FOUND", "Not found on GitHub (or you do not have access)");
        }
        const info: RepoInfo = {
          ref: this.ref,
          key: this.key,
          name: raw.full_name ?? `${this.owner}/${this.name}`,
          description: raw.description ?? undefined,
          defaultBranch: raw.default_branch,
          visibility: raw.visibility ?? (raw.private ? "private" : "public"),
          permission: this.userAuthenticated ? (permissionOf(raw) ?? "read") : "read",
          htmlUrl: raw.html_url,
        };
        return { info, raw };
      })();
      this.infoMemo.catch(() => (this.infoMemo = null));
    }
    return this.infoMemo;
  }

  async info(opts?: ReadOptions): Promise<RepoInfo> {
    return (await this.loadInfo(opts?.signal)).info;
  }

  async capabilities(opts?: ReadOptions): Promise<Capabilities> {
    const info = await this.info(opts);
    const canWrite = this.userAuthenticated && PERMISSION_RANK[info.permission ?? "none"] >= PERMISSION_RANK.write;
    const available: Capability[] = ["history", "refs", "commit", "diff", "compare", "fileHistory", "search"];
    if (this.token) available.push("blame");
    if (canWrite) available.push("branchWrite", "tagWrite");
    return capabilities(available, (c) => {
      if (c === "blame") return SIGN_IN_BLAME_REASON;
      if (c === "branchWrite" || c === "tagWrite") return this.userAuthenticated ? `You need write access to ${this.owner}/${this.name}` : SIGN_IN_WRITE_REASON;
      return SPECIFIC_REASONS[c] ?? LOCAL_ONLY_REASON;
    });
  }

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  private async matchingRefs(prefix: "heads" | "tags", signal?: AbortSignal): Promise<GhRef[]> {
    try {
      return await this.api.paginate<GhRef>(`${this.base}/git/matching-refs/${prefix}`, { token: this.token, signal, maxPages: 20 });
    } catch (e) {
      if (AppError.from(e).code === "CONFLICT") return []; // empty repository
      throw e;
    }
  }

  async refs(opts?: ReadOptions): Promise<RefsSnapshot> {
    const signal = opts?.signal;
    // The access check runs alongside the ref reads (one round-trip less); if it fails, nothing is
    // returned. With the server's public token the check must pass before anything is requested.
    if (this.opts.requirePublic) await this.guard(signal);
    const [{ info }, heads, tagRefs] = await Promise.all([this.loadInfo(signal), this.matchingRefs("heads", signal), this.matchingRefs("tags", signal)]);
    const refs: Ref[] = [];
    for (const h of heads) {
      if (h.object.type !== "commit") continue;
      refs.push({ name: h.ref, kind: "head", short: h.ref.slice("refs/heads/".length), target: h.object.sha, commit: h.object.sha });
    }
    const annotated = tagRefs.filter((t) => t.object.type === "tag");
    const peeled = new Map<string, string>();
    if (annotated.length) {
      // One paginated call gives every tag's peeled commit; fall back to the tag object if missing.
      const tags = await this.api.paginate<{ name: string; commit: { sha: string } }>(`${this.base}/tags`, { token: this.token, signal, maxPages: 10 });
      for (const t of tags) peeled.set(`refs/tags/${t.name}`, t.commit.sha);
    }
    for (const t of tagRefs) {
      let commit = t.object.sha;
      let message: string | undefined;
      if (t.object.type === "tag") {
        const p = peeled.get(t.ref);
        if (p) commit = p;
        else {
          const obj = await this.api.get<{ object: { sha: string; type: string }; message?: string }>(`${this.base}/git/tags/${t.object.sha}`, {
            token: this.token,
            signal,
            immutable: true,
          });
          commit = obj.object.sha;
          message = obj.message;
        }
      } else if (t.object.type !== "commit") continue;
      refs.push({ name: t.ref, kind: "tag", short: t.ref.slice("refs/tags/".length), target: t.object.sha, commit, ...(message ? { message } : {}) });
    }
    refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const def = info.defaultBranch ? refs.find((r) => r.name === `refs/heads/${info.defaultBranch}`) : undefined;
    const head: RefsSnapshot["head"] = def
      ? { kind: "branch", ref: def.name, commit: def.commit }
      : info.defaultBranch
        ? { kind: "unborn", ref: `refs/heads/${info.defaultBranch}` }
        : { kind: "none" };
    return { head, refs, version: refsVersion(head, refs) };
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  private pageSize(): number {
    return Math.max(1, Math.min(100, this.opts.pageSize ?? 100));
  }

  private loader() {
    const per = this.pageSize();
    return async (tip: string, page: number, signal?: AbortSignal) => {
      try {
        const r = await this.req<GhCommit[]>(`${this.base}/commits`, { query: { sha: tip, per_page: per, page }, immutable: true, signal });
        const list = Array.isArray(r.data) ? r.data : [];
        return { commits: list.map(toCommit), last: !r.links.next || list.length < per };
      } catch (e) {
        if (AppError.from(e).code === "CONFLICT") return { commits: [], last: true };
        throw e;
      }
    };
  }

  private async resolveCommitish(rev: string, snap: RefsSnapshot | null, signal?: AbortSignal): Promise<string> {
    if (FULL_SHA.test(rev)) return rev;
    const r = snap?.refs.find((x) => x.name === rev || x.short === rev || x.name === `refs/heads/${rev}` || x.name === `refs/tags/${rev}`);
    if (r) return r.commit;
    if (rev === "HEAD" && snap?.head.kind === "branch") return snap.head.commit;
    try {
      const c = await this.get<GhCommit>(`commits/${encodeURIComponent(rev)}`, { signal, accept: "application/vnd.github+json", freshMs: 5000 });
      return c.sha;
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST" || err.code === "CONFLICT") throw new AppError("REF_NOT_FOUND", `Unknown revision "${rev}"`);
      throw err;
    }
  }

  private async streamSpecs(query: HistoryQuery, snap: RefsSnapshot, signal?: AbortSignal): Promise<StreamSpec[]> {
    if (query.refs.length) {
      const out: StreamSpec[] = [];
      for (const r of query.refs) out.push({ id: r, tip: await this.resolveCommitish(r, snap, signal) });
      return out;
    }
    const heads = snap.refs.filter((r) => r.kind === "head");
    const head = snap.head;
    const def = head.kind === "branch" ? heads.find((h) => h.name === head.ref) : undefined;
    const cap = this.opts.branchCap ?? (this.token ? 50 : 10);
    // Without commit dates in the refs listing, prefer conventional long-lived names, then alphabetical.
    // Repos with more branches than the cap show a subset; request specific refs to see others.
    const rank = (s: string) => (/^(main|master|develop|dev|trunk)$/.test(s) ? 0 : /^(release|hotfix)\//.test(s) ? 1 : 2);
    const others = heads.filter((h) => h !== def).sort((a, b) => rank(a.short) - rank(b.short) || (a.short < b.short ? -1 : 1));
    const chosen = [...(def ? [def] : []), ...others].slice(0, cap);
    return chosen.map((h) => ({ id: h.name, tip: h.commit }));
  }

  async history(query: HistoryQuery, cursor: string | null, limit: number, opts?: ReadOptions): Promise<HistoryPage> {
    const signal = opts?.signal;
    await this.guard(signal);
    limit = Math.max(1, Math.min(5000, Math.floor(limit)));
    let merge: HistoryMerge | undefined;
    let specs: StreamSpec[];
    let rv: string;
    let fp: boolean;
    if (cursor) {
      const c = decodeCursor(cursor);
      specs = c.t;
      rv = c.rv;
      fp = !!c.fp;
      merge = this.historyCache.take(`${this.tid}|${this.key}|${cursor}`);
      if (!merge) {
        // Rebuild deterministically: immutable pages come from the response cache.
        merge = new HistoryMerge(specs, this.loader(), { firstParent: fp });
        await merge.next(c.n, signal, 0);
      }
    } else {
      const snap = await this.refs(opts);
      specs = await this.streamSpecs(query, snap, signal);
      rv = snap.version;
      fp = query.firstParent;
      merge = new HistoryMerge(specs, this.loader(), { firstParent: fp });
    }
    const commits = await merge.next(limit, signal);
    const finished = commits.length < limit || merge.done();
    let next: string | null = null;
    if (!finished) {
      next = encodeCursor({ v: 1, t: specs, n: merge.emittedCount, rv, ...(fp ? { fp: 1 as const } : {}), p: merge.streams.map((s) => s.pagesLoaded) });
      this.historyCache.put(`${this.tid}|${this.key}|${next}`, merge);
    }
    return { commits, cursor: next, refsVersion: rv };
  }

  // -------------------------------------------------------------------------
  // Commits, diffs, files
  // -------------------------------------------------------------------------

  private async ghCommit(hash: string, signal?: AbortSignal): Promise<{ c: GhCommit; truncated: boolean }> {
    await this.guard(signal);
    try {
      const r = await this.req<GhCommit>(`commits/${encodeURIComponent(hash)}`, { signal, immutable: FULL_SHA.test(hash), freshMs: 5000 });
      return { c: r.data, truncated: !!r.links.next };
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST") throw new AppError("COMMIT_NOT_FOUND", `Commit ${hash} not found`);
      throw err;
    }
  }

  async commit(hash: string, opts?: ReadOptions): Promise<CommitDetails> {
    const { c, truncated } = await this.ghCommit(hash, opts?.signal);
    const msg = c.commit.message ?? "";
    const nl = msg.indexOf("\n");
    const v = c.commit.verification;
    return {
      ...toCommit(c),
      body: nl >= 0 ? msg.slice(nl + 1).replace(/^\n/, "") : "",
      files: (c.files ?? []).map(toFileChange),
      ...(truncated || (c.files?.length ?? 0) >= 3000 ? { filesTruncated: true } : {}),
      signature: !v ? { status: "none" } : v.verified ? { status: "good" } : v.reason === "unsigned" ? { status: "none" } : { status: v.reason === "bad_signature" ? "bad" : "unknown" },
    };
  }

  async diff(spec: DiffSpec, opts?: DiffOptions): Promise<Diff> {
    let files: GhFile[];
    let truncated = false;
    if (spec.kind === "commit") {
      const r = await this.ghCommit(spec.hash, opts?.signal);
      files = r.c.files ?? [];
      truncated = r.truncated;
    } else if (spec.kind === "compare") {
      try {
        const r = await this.get<{ files?: GhFile[] }>(`compare/${encodeURIComponent(spec.base)}...${encodeURIComponent(spec.head)}`, {
          signal: opts?.signal,
          immutable: FULL_SHA.test(spec.base) && FULL_SHA.test(spec.head),
        });
        files = r.files ?? [];
        truncated = files.length >= 300;
      } catch (e) {
        const err = AppError.from(e);
        if (err.code === "NOT_FOUND") throw new AppError("COMMIT_NOT_FOUND", `Cannot compare ${spec.base}...${spec.head}`);
        throw err;
      }
    } else {
      throw new AppError("UNSUPPORTED", LOCAL_ONLY_REASON, { capability: "workingTree" });
    }
    let out = files.map(toFileDiff);
    if (opts?.path) out = out.filter((f) => f.path === opts.path || f.oldPath === opts.path);
    if (truncated && out.length) out[out.length - 1] = { ...out[out.length - 1]!, truncated: true };
    return { spec, files: out };
  }

  async fileHistory(path: string, cursor: string | null, limit: number, opts?: ReadOptions): Promise<HistoryPage> {
    const per = Math.max(1, Math.min(100, Math.floor(limit)));
    let page = 1;
    let tip: string;
    let rv: string;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { page: number; tip: string; rv: string; per: number };
        if (!Number.isSafeInteger(c.page) || !FULL_SHA.test(c.tip)) throw new Error();
        page = c.page;
        tip = c.tip;
        rv = c.rv;
      } catch {
        throw new AppError("BAD_REQUEST", "Invalid file history cursor");
      }
    } else {
      const snap = await this.refs(opts);
      if (snap.head.kind !== "branch") return { commits: [], cursor: null, refsVersion: snap.version };
      tip = snap.head.commit;
      rv = snap.version;
    }
    await this.guard(opts?.signal);
    const r = await this.req<GhCommit[]>(`commits`, { query: { sha: tip, path, per_page: per, page }, immutable: true, signal: opts?.signal });
    const commits = (r.data ?? []).map(toCommit);
    const more = !!r.links.next && commits.length === per;
    return {
      commits,
      cursor: more ? Buffer.from(JSON.stringify({ page: page + 1, tip, rv, per })).toString("base64url") : null,
      refsVersion: rv,
    };
  }

  async blame(path: string, rev: string, opts?: ReadOptions): Promise<BlameLine[]> {
    if (!this.token) throw new AppError("UNSUPPORTED", SIGN_IN_BLAME_REASON, { capability: "blame" });
    await this.guard(opts?.signal);
    const snap = FULL_SHA.test(rev) ? null : await this.refs(opts);
    const sha = await this.resolveCommitish(rev, snap, opts?.signal);
    const q = `query($owner:String!,$name:String!,$expr:String!,$path:String!){repository(owner:$owner,name:$name){object(expression:$expr){... on Commit{blame(path:$path){ranges{startingLine endingLine commit{oid committedDate author{name date}}}}}}}}`;
    const [data, file] = await Promise.all([
      this.api.graphql<{
        repository: { object: { blame: { ranges: { startingLine: number; endingLine: number; commit: { oid: string; committedDate: string; author: { name: string; date: string } | null } }[] } } | null } | null;
      }>(q, { owner: this.owner, name: this.name, expr: sha, path }, { token: this.token, signal: opts?.signal }),
      this.file(path, sha, opts),
    ]);
    const ranges = data.repository?.object?.blame?.ranges;
    if (!ranges) throw new AppError("NOT_FOUND", `No blame for ${path} at ${rev}`);
    const text = file.encoding === "utf8" ? file.content.split("\n") : [];
    if (text.length && text[text.length - 1] === "") text.pop();
    const out: BlameLine[] = [];
    for (const r of ranges) {
      for (let l = r.startingLine; l <= r.endingLine; l++) {
        out.push({
          line: l,
          hash: r.commit.oid,
          author: r.commit.author?.name ?? "",
          date: Math.floor(Date.parse(r.commit.author?.date ?? r.commit.committedDate) / 1000),
          text: text[l - 1] ?? "",
        });
      }
    }
    return out;
  }

  async search(q: SearchQuery, opts?: ReadOptions): Promise<Commit[]> {
    const limit = Math.max(1, Math.min(500, q.limit ?? 50));
    const text = q.text.trim();
    const out = new Map<string, Commit>();
    const fields = q.fields;
    if (/^[0-9a-fA-F]{4,40}$/.test(text) && (!fields || fields.includes("hash"))) {
      try {
        const { c } = await this.ghCommit(text.toLowerCase(), opts?.signal);
        out.set(c.sha, toCommit(c));
      } catch (e) {
        if (AppError.from(e).code !== "COMMIT_NOT_FOUND") throw e;
      }
    }
    if (out.size >= limit) return [...out.values()].slice(0, limit);
    if (this.userAuthenticated) {
      try {
        const r = await this.get<{ items: GhCommit[] }>(`/search/commits`, {
          query: { q: `${text} repo:${this.owner}/${this.name}`, per_page: Math.min(100, limit), sort: "committer-date", order: "desc" },
          signal: opts?.signal,
          freshMs: 30_000,
        });
        for (const it of r.items ?? []) if (!out.has(it.sha)) out.set(it.sha, toCommit(it));
        return [...out.values()].slice(0, limit);
      } catch (e) {
        const err = AppError.from(e);
        if (err.code !== "BAD_REQUEST" && err.code !== "FORBIDDEN" && err.code !== "NOT_FOUND") throw err;
      }
    }
    // Anonymous: search over (cached) recent history.
    const needle = text.toLowerCase();
    // Bounded: anonymous callers have a tiny rate budget (and pages are cached immutably).
    const page = await this.history({ refs: [], includeRemotes: false, includeTags: false, includeStashes: false, firstParent: false, order: "date" }, null, this.token ? 1000 : 300, opts);
    for (const c of page.commits) {
      if (out.size >= limit) break;
      const hit =
        ((!fields || fields.includes("subject")) && c.subject.toLowerCase().includes(needle)) ||
        ((!fields || fields.includes("author")) && (c.author.name.toLowerCase().includes(needle) || c.author.email.toLowerCase().includes(needle))) ||
        ((!fields || fields.includes("hash")) && c.hash.startsWith(needle));
      if (hit) out.set(c.hash, c);
    }
    return [...out.values()].slice(0, limit);
  }

  async file(path: string, rev: string, opts?: ReadOptions): Promise<{ content: string; encoding: "utf8" | "base64"; size: number }> {
    const r = await this.get<{ type?: string; content?: string; encoding?: string; size: number; sha: string } | unknown[]>(`contents/${encPath(path)}`, {
      query: { ref: rev },
      signal: opts?.signal,
      immutable: FULL_SHA.test(rev),
      freshMs: 5000,
    });
    if (Array.isArray(r) || (r as { type?: string }).type !== "file") throw new AppError("BAD_REQUEST", `"${path}" is not a file`);
    const f = r as { content?: string; encoding?: string; size: number; sha: string };
    let b64 = f.content ?? "";
    if (f.encoding !== "base64" || (!b64 && f.size > 0)) {
      const blob = await this.get<{ content: string; encoding: string; size: number }>(`git/blobs/${f.sha}`, { signal: opts?.signal, immutable: true });
      b64 = blob.content;
    }
    const buf = Buffer.from(b64.replace(/\n/g, ""), "base64");
    if (!buf.includes(0)) {
      try {
        return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf8", size: buf.length };
      } catch {
        /* not utf8 */
      }
    }
    return { content: buf.toString("base64"), encoding: "base64", size: buf.length };
  }

  // -------------------------------------------------------------------------
  // Local-only
  // -------------------------------------------------------------------------

  status(): Promise<WorkingTreeStatus> {
    return Promise.reject(new AppError("UNSUPPORTED", LOCAL_ONLY_REASON, { capability: "workingTree" }));
  }
  worktrees(): Promise<Worktree[]> {
    return Promise.reject(new AppError("UNSUPPORTED", LOCAL_ONLY_REASON, { capability: "worktrees" }));
  }
  remotes(): Promise<Remote[]> {
    return Promise.reject(new AppError("UNSUPPORTED", LOCAL_ONLY_REASON, { capability: "remotes" }));
  }
  conflict(_path?: string): Promise<ConflictFile> {
    return Promise.reject(new AppError("UNSUPPORTED", LOCAL_ONLY_REASON, { capability: "conflicts" }));
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  private async requireWrite(): Promise<RepoInfo> {
    if (!this.userAuthenticated) throw new AppError("UNSUPPORTED", SIGN_IN_WRITE_REASON, { capability: "branchWrite" });
    const info = await this.info();
    if (PERMISSION_RANK[info.permission ?? "none"] < PERMISSION_RANK.write) {
      throw new AppError("FORBIDDEN", `You need write access to ${this.owner}/${this.name}`);
    }
    return info;
  }

  private async readRef(name: string): Promise<{ sha: string; type: string } | null> {
    const full = name.startsWith("refs/") ? name : null;
    const candidates = full ? [full] : [`refs/heads/${name}`, `refs/tags/${name}`];
    for (const c of candidates) {
      try {
        const r = await this.req<GhRef | GhRef[]>(`git/ref/${encPath(c.slice(5))}`, { noCache: true });
        const ref = Array.isArray(r.data) ? r.data.find((x) => x.ref === c) : r.data;
        if (ref && ref.ref === c) {
          if (ref.object.type === "tag") {
            const t = await this.api.get<{ object: { sha: string } }>(`${this.base}/git/tags/${ref.object.sha}`, { token: this.token, immutable: true });
            return { sha: t.object.sha, type: "tag" };
          }
          return { sha: ref.object.sha, type: ref.object.type };
        }
      } catch (e) {
        if (AppError.from(e).code !== "NOT_FOUND") throw e;
      }
    }
    return null;
  }

  private async checkPrecondition(pre: MutationPrecondition | undefined, invocations: string[]) {
    if (!pre) return;
    if (pre.ref) {
      invocations.push(`GET ${this.base}/git/ref/${pre.ref.name.replace(/^refs\//, "")}`);
      const cur = await this.readRef(pre.ref.name);
      if (!cur || cur.sha !== pre.ref.commit.toLowerCase()) {
        throw new AppError("STALE_STATE", `"${pre.ref.name}" is now at ${cur ? cur.sha.slice(0, 8) : "nothing"}, not ${pre.ref.commit.slice(0, 8)}; reload and try again`, {
          expected: pre.ref.commit,
          actual: cur?.sha ?? null,
        });
      }
    }
    if (pre.refsVersion) {
      const snap = await this.refs();
      if (snap.version !== pre.refsVersion) throw new AppError("STALE_STATE", "The repository's refs changed; reload and try again", { expected: pre.refsVersion, actual: snap.version });
    }
  }

  private async write<T>(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown, invocations: string[]): Promise<T> {
    const full = `${this.base}/${path}`;
    invocations.push(`${method} ${full}`);
    try {
      return (await this.api.request<T>(full, { method, token: this.token, body })).data;
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === "BAD_REQUEST" && /already exists/i.test(err.message)) throw new AppError("CONFLICT", err.message);
      if (err.code === "BAD_REQUEST" && /does not exist|not found/i.test(err.message)) throw new AppError("REF_NOT_FOUND", err.message);
      throw err;
    }
  }

  async mutate(m: GitMutation, precondition?: MutationPrecondition): Promise<MutationResult> {
    const supported = ["branch.create", "branch.delete", "branch.rename", "tag.create", "tag.delete"];
    if (!supported.includes(m.op)) throw new AppError("UNSUPPORTED", OP_REASONS[m.op] ?? LOCAL_ONLY_REASON, { op: m.op });
    const info = await this.requireWrite();
    const invocations: string[] = [];
    await this.checkPrecondition(precondition, invocations);
    const checkName = (n: string) => {
      if (!isValidRefName(n)) throw new AppError("BAD_REQUEST", `Invalid ref name "${n}"`);
    };
    let output = "";
    switch (m.op) {
      case "branch.create": {
        checkName(m.name);
        const sha = await this.resolveCommitish(m.target, FULL_SHA.test(m.target) ? null : await this.refs());
        await this.write("POST", "git/refs", { ref: `refs/heads/${m.name}`, sha }, invocations);
        output = `Created branch ${m.name} at ${sha.slice(0, 8)}${m.checkout ? " (GitHub has no checkout; nothing was checked out)" : ""}`;
        break;
      }
      case "branch.delete": {
        checkName(m.name);
        if (m.name === info.defaultBranch) throw new AppError("FORBIDDEN", `"${m.name}" is the default branch of ${this.owner}/${this.name}; change the default branch on GitHub first`);
        if (!m.force && info.defaultBranch) {
          invocations.push(`GET ${this.base}/compare/${info.defaultBranch}...${m.name}`);
          const cmp = await this.req<{ ahead_by: number }>(`compare/${encodeURIComponent(info.defaultBranch)}...${encodeURIComponent(m.name)}`, { noCache: true }).catch((e) => {
            if (AppError.from(e).code === "NOT_FOUND") throw new AppError("REF_NOT_FOUND", `Branch "${m.name}" does not exist`);
            throw e;
          });
          if (cmp.data.ahead_by > 0) {
            throw new AppError("CONFLICT", `Branch "${m.name}" has ${cmp.data.ahead_by} commit(s) not merged into ${info.defaultBranch}; delete with force to discard them`, {
              aheadBy: cmp.data.ahead_by,
            });
          }
        }
        await this.write("DELETE", `git/refs/heads/${encPath(m.name)}`, undefined, invocations);
        output = `Deleted branch ${m.name}`;
        break;
      }
      case "branch.rename": {
        checkName(m.from);
        checkName(m.to);
        await this.write("POST", `branches/${encPath(m.from)}/rename`, { new_name: m.to }, invocations);
        output = `Renamed branch ${m.from} to ${m.to}`;
        break;
      }
      case "tag.create": {
        checkName(m.name);
        if (m.sign) throw new AppError("UNSUPPORTED", "GitHub's API cannot create signed tags; use the CLI companion");
        const sha = await this.resolveCommitish(m.target, FULL_SHA.test(m.target) ? null : await this.refs());
        if (m.message) {
          const tag = await this.write<{ sha: string }>("POST", "git/tags", { tag: m.name, message: m.message, object: sha, type: "commit" }, invocations);
          await this.write("POST", "git/refs", { ref: `refs/tags/${m.name}`, sha: tag.sha }, invocations);
          output = `Created annotated tag ${m.name} on ${sha.slice(0, 8)}`;
        } else {
          await this.write("POST", "git/refs", { ref: `refs/tags/${m.name}`, sha }, invocations);
          output = `Created tag ${m.name} on ${sha.slice(0, 8)}`;
        }
        break;
      }
      case "tag.delete": {
        checkName(m.name);
        await this.write("DELETE", `git/refs/tags/${encPath(m.name)}`, undefined, invocations);
        output = `Deleted tag ${m.name}`;
        break;
      }
    }
    let version: string | undefined;
    try {
      version = (await this.refs()).version;
    } catch {
      /* the mutation succeeded; the version is best-effort */
    }
    this.opts.onMutated?.(this.key);
    return { op: m.op, output, invocations, exitCode: 0, ...(version ? { refsVersion: version } : {}) };
  }

  subscribe(listener: (e: RepositoryEvent) => void): () => void {
    if (!this.opts.hub) return () => {};
    return this.opts.hub.subscribe(this.key, (env) => listener(env.event));
  }
}

export function refsVersion(head: RefsSnapshot["head"], refs: Ref[]): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(head));
  for (const r of refs) h.update(`\n${r.name}\0${r.target}\0${r.commit}`);
  return h.digest("hex").slice(0, 24);
}
