// RepositoryPort over the installed Git CLI, bound to one worktree (its toplevel path).
// All reads are side-effect free (GIT_OPTIONAL_LOCKS=0). Mutations are serialized per common git dir,
// enforce MutationPrecondition, never auto-retry, and report the exact invocations they ran.

import { realpathSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  AppError,
  capabilities as makeCapabilities,
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
  type HeadState,
  type HistoryPage,
  type HistoryQuery,
  type InProgressOperation,
  type MutationPrecondition,
  type MutationResult,
  type Ref,
  type RefsSnapshot,
  type Remote,
  type RepoInfo,
  type RepoRef,
  type RepositoryEvent,
  type WorkingTreeStatus,
  type Worktree,
  CAPABILITIES,
} from "../core/types.ts";
import type { DiffOptions, ReadOptions, RepositoryPort, SearchQuery } from "../core/port.ts";
import { LOG_FORMAT, parseLog } from "../core/git/log.ts";
import {
  FOR_EACH_REF_FORMAT,
  FOR_EACH_REF_FORMAT_CHEAP,
  STASH_LIST_FORMAT,
  hash64,
  headFrom,
  parseForEachRef,
  parseStashList,
  refsDigest,
} from "../core/git/refs.ts";
import { parseStatusV2 } from "../core/git/status.ts";
import { combineDiff, parsePatch, parseRawNumstat } from "../core/git/diff.ts";
import { parseWorktreeList } from "../core/git/worktree.ts";
import { parseBlamePorcelain } from "../core/git/blame.ts";
import { scrubText, scrubUrl, unquoteCPath } from "../core/git/text.ts";
import { git, gitFailure, gitVersion, requireGit, runGit, versionAtLeast, type RunOptions, type RunResult } from "./exec.ts";
import { HistoryCache, HistorySnapshot, formatHistoryCursor, parseHistoryCursor, snapshotId } from "./history.ts";

export interface LiteRefs {
  head: HeadState;
  refs: Ref[];
  version: string;
}

export interface AdapterHooks {
  /** Subscribe to repository events (wired to the companion's EventHub + watcher). */
  subscribe?: (key: string, listener: (e: RepositoryEvent) => void) => () => void;
  /** Called after every mutation so watchers can publish promptly. */
  onMutated?: (key: string) => void;
  /** Publish operation lifecycle events. */
  publish?: (e: RepositoryEvent) => void;
}

const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_COMMIT_FILES = 5000;
const MAX_UNTRACKED_DIFF_FILES = 200;
const MAX_UNTRACKED_DIFF_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Serializes mutations per common git dir, so concurrent requests never fight over index.lock. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function assertSafeArg(name: string, v: string) {
  if (!v || v.startsWith("-") || v.includes("\0")) throw new AppError("BAD_REQUEST", `Invalid ${name} "${v}"`);
}

export interface RepoLocation {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

/** Resolve toplevel / git dir / common dir of the worktree containing `path`, through git itself. */
export async function locateRepository(path: string): Promise<RepoLocation> {
  await requireGit();
  const cwd = resolve(path);
  const st = await stat(cwd).catch(() => null);
  if (!st) throw new AppError("NOT_FOUND", `Path does not exist: ${cwd}`);
  const dir = st.isDirectory() ? cwd : resolve(cwd, "..");
  const r = await runGit(["rev-parse", "--is-bare-repository", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], { cwd: dir, readOnly: true, cLocale: true });
  if (r.code !== 0) {
    if (/not a git repository/i.test(r.stderr)) throw new AppError("NOT_FOUND", `Not a Git repository: ${dir}`);
    throw gitFailure(r);
  }
  const lines = r.stdout.split("\n");
  if (lines[0] === "true") throw new AppError("UNSUPPORTED", `"${dir}" is a bare repository; open one of its worktrees instead.`);
  const [toplevel, gitDir, common] = [lines[1]!, lines[2]!, lines[3]!];
  if (!toplevel) throw new AppError("UNSUPPORTED", `"${dir}" is inside a git directory, not a worktree.`);
  return { toplevel: real(toplevel), gitDir: real(gitDir), commonDir: real(isAbsolute(common) ? common : resolve(dir, common)) };
}

export class CliGitAdapter implements RepositoryPort {
  readonly ref: RepoRef;
  readonly key: string;
  readonly toplevel: string;
  readonly gitDir: string;
  readonly commonDir: string;
  private readonly hooks: AdapterHooks;
  private readonly history_ = new HistoryCache(4);
  private rebaseScratch = new Set<string>();

  constructor(id: string, loc: RepoLocation, hooks: AdapterHooks = {}) {
    this.ref = { provider: "local", id };
    this.key = `local:${id}`;
    this.toplevel = loc.toplevel;
    this.gitDir = loc.gitDir;
    this.commonDir = loc.commonDir;
    this.hooks = hooks;
  }

  static async open(path: string, id: string, hooks?: AdapterHooks): Promise<CliGitAdapter> {
    return new CliGitAdapter(id, await locateRepository(path), hooks);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private run(args: string[], o: Omit<RunOptions, "cwd"> = {}): Promise<RunResult> {
    return runGit(args, { cwd: this.toplevel, ...o });
  }
  private read(args: string[], o: Omit<RunOptions, "cwd"> = {}): Promise<string> {
    return git(args, { cwd: this.toplevel, readOnly: true, ...o });
  }

  // -------------------------------------------------------------------------
  // capabilities / info
  // -------------------------------------------------------------------------

  async capabilities(): Promise<Capabilities> {
    const v = await gitVersion();
    if (!v.ok) return makeCapabilities([], () => v.problem ?? "Git is unavailable");
    const available = CAPABILITIES.filter((c) => c !== "clone" && c !== "init") as Capability[];
    return makeCapabilities(available, (c) =>
      c === "clone" || c === "init" ? `${c === "clone" ? "Cloning" : "Initializing"} creates a new repository: use the companion command local.${c}.` : "Unavailable",
    );
  }

  async info(): Promise<RepoInfo> {
    let defaultBranch: string | undefined;
    const r = await this.run(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { readOnly: true });
    if (r.code === 0 && r.stdout.trim()) defaultBranch = r.stdout.trim().replace(/^origin\//, "");
    if (!defaultBranch) {
      const h = await this.run(["symbolic-ref", "-q", "--short", "HEAD"], { readOnly: true });
      if (h.code === 0) defaultBranch = h.stdout.trim() || undefined;
    }
    return {
      ref: this.ref,
      key: this.key,
      name: basename(this.toplevel),
      visibility: "local",
      ...(defaultBranch ? { defaultBranch } : {}),
      worktreePath: this.toplevel,
      commonDir: this.commonDir,
    };
  }

  // -------------------------------------------------------------------------
  // refs
  // -------------------------------------------------------------------------

  private async head(): Promise<HeadState> {
    const [sym, rev] = await Promise.all([
      this.run(["symbolic-ref", "-q", "HEAD"], { readOnly: true }),
      this.run(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { readOnly: true }),
    ]);
    return headFrom(sym.code === 0 ? sym.stdout.trim() || null : null, rev.code === 0 ? rev.stdout.trim() || null : null);
  }

  private async stashes(): Promise<Ref[]> {
    const r = await this.run(["log", "-g", "-z", "--no-abbrev-commit", `--format=${STASH_LIST_FORMAT}`, "refs/stash", "--"], { readOnly: true });
    return r.code === 0 ? parseStashList(r.stdout) : [];
  }

  private async remoteNames(): Promise<string[]> {
    const r = await this.run(["remote"], { readOnly: true });
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  }

  /** Refs without ahead/behind (cheap). Same version digest as refs(). */
  async refsLite(opts?: ReadOptions): Promise<LiteRefs> {
    const [out, head] = await Promise.all([
      this.read(["for-each-ref", `--format=${FOR_EACH_REF_FORMAT_CHEAP}`, "refs/heads", "refs/remotes", "refs/tags", "refs/stash"], { signal: opts?.signal }),
      this.head(),
    ]);
    const refs = parseForEachRef(out);
    if (out.includes("refs/stash\0")) refs.push(...(await this.stashes()));
    return { head, refs, version: refsDigest(head, refs) };
  }

  async refs(opts?: ReadOptions): Promise<RefsSnapshot> {
    const [out, head, remotes] = await Promise.all([
      this.read(["for-each-ref", `--format=${FOR_EACH_REF_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags", "refs/stash"], { signal: opts?.signal }),
      this.head(),
      this.remoteNames(),
    ]);
    const refs = parseForEachRef(out, { remoteNames: remotes, withTrack: true });
    if (out.includes("refs/stash\0")) refs.push(...(await this.stashes()));
    return { head, refs, version: refsDigest(head, refs) };
  }

  // -------------------------------------------------------------------------
  // history
  // -------------------------------------------------------------------------

  private historyArgs(q: HistoryQuery, lite: LiteRefs): { args: string[]; stashes: Set<string> } | null {
    const order = q.order === "topo" ? "--topo-order" : q.order === "author-date" ? "--author-date-order" : "--date-order";
    const args = ["log", "--no-color", "-z", "--no-show-signature", `--format=${LOG_FORMAT}`, order];
    if (q.firstParent) args.push("--first-parent");
    const revs: string[] = [];
    const stashes = new Set<string>();
    if (q.refs.length) {
      for (const r of q.refs) {
        assertSafeArg("ref", r);
        revs.push(r);
      }
    } else {
      args.push("--branches");
      if (q.includeRemotes) args.push("--remotes");
      if (q.includeTags) args.push("--tags");
      if (lite.head.kind === "branch" || lite.head.kind === "detached") revs.push("HEAD");
      if (q.includeStashes) {
        for (const s of lite.refs) {
          if (s.kind === "stash") {
            stashes.add(s.commit);
            revs.push(s.commit);
          }
        }
      }
      const anyRef = revs.length > 0 || lite.refs.some((r) => r.kind === "head" || (q.includeRemotes && r.kind === "remote") || (q.includeTags && r.kind === "tag"));
      if (!anyRef) return null; // empty repository
    }
    args.push("--end-of-options", ...revs, "--");
    return { args, stashes };
  }

  async history(q: HistoryQuery, cursor: string | null, limit: number, opts?: ReadOptions): Promise<HistoryPage> {
    let snap: HistorySnapshot | undefined;
    let offset = 0;
    if (cursor) {
      const c = parseHistoryCursor(cursor);
      if (!c) throw new AppError("BAD_REQUEST", "Invalid history cursor");
      offset = c.offset;
      snap = this.history_.get(c.id);
      if (!snap) {
        const lite = await this.refsLite(opts);
        const id = snapshotId(this.toplevel, q, lite.version);
        if (id !== c.id) throw new AppError("STALE_STATE", "Refs changed since this history cursor was issued; reload from the first page.", { refsVersion: lite.version });
        snap = this.startSnapshot(q, lite, id);
      }
    } else {
      const lite = await this.refsLite(opts);
      const id = snapshotId(this.toplevel, q, lite.version);
      snap = this.history_.get(id) ?? this.startSnapshot(q, lite, id);
    }
    if (!snap) return { commits: [], cursor: null, refsVersion: (await this.refsLite()).version, total: 0 };
    await snap.waitFor(offset + limit + 1, opts?.signal);
    const commits = snap.commits.slice(offset, offset + limit);
    const end = offset + commits.length;
    const more = end < snap.commits.length || !snap.done;
    return {
      commits,
      cursor: more ? formatHistoryCursor(snap.id, end) : null,
      refsVersion: snap.refsVersion,
      ...(snap.done ? { total: snap.commits.length } : {}),
    };
  }

  private startSnapshot(q: HistoryQuery, lite: LiteRefs, id: string): HistorySnapshot | undefined {
    const plan = this.historyArgs(q, lite);
    if (!plan) return undefined;
    const s = new HistorySnapshot(id, lite.version, plan.args, this.toplevel, plan.stashes);
    this.history_.add(s);
    this.maybeWriteCommitGraph(s);
    return s;
  }

  /**
   * Opt-in (LANES_WRITE_COMMIT_GRAPH=1): without a commit-graph, `git log --date-order` must load the
   * whole graph before printing the first row (~250 ms per 100k commits). When that is observed,
   * write git's own commit-graph cache once (the same file `git gc` / `git maintenance` produce).
   * Never done implicitly: it writes into the user's object directory.
   */
  private commitGraphTried = false;
  private maybeWriteCommitGraph(s: HistorySnapshot) {
    if (process.env.LANES_WRITE_COMMIT_GRAPH !== "1" || this.commitGraphTried) return;
    void s.complete().then(
      async () => {
        if (this.commitGraphTried || s.firstRowsAt === null || s.firstRowsAt - s.startedAt < 150) return;
        const info = join(this.commonDir, "objects", "info");
        const has = (p: string) => stat(join(info, p)).then(() => true, () => false);
        if ((await has("commit-graph")) || (await has("commit-graphs"))) return;
        this.commitGraphTried = true;
        await this.run(["commit-graph", "write", "--reachable"]);
      },
      () => {},
    );
  }

  /** Test/perf hook: the snapshot behind a cursor-less query, once started. */
  historySnapshotFor(q: HistoryQuery, refsVersion: string): HistorySnapshot | undefined {
    return this.history_.get(snapshotId(this.toplevel, q, refsVersion));
  }

  // -------------------------------------------------------------------------
  // commits and diffs
  // -------------------------------------------------------------------------

  private async commitHeader(hash: string, signal?: AbortSignal): Promise<{ commit: Commit; body: string }> {
    assertSafeArg("commit", hash);
    const r = await this.run(["log", "-1", "--no-walk", "-z", "--no-show-signature", `--format=${LOG_FORMAT}%x00%b`, "--end-of-options", hash, "--"], {
      readOnly: true,
      signal,
    });
    if (r.code !== 0 || !r.stdout) throw new AppError("COMMIT_NOT_FOUND", `Commit ${hash} not found`, { stderr: r.stderr.trim() });
    const f = r.stdout.split("\0");
    const [commit] = parseLog(f.slice(0, 9).join("\0") + "\0");
    return { commit: commit!, body: (f[9] ?? "").replace(/\n+$/, "") };
  }

  private async rawChanges(a: string | null, b: string, paths: string[] | undefined, signal?: AbortSignal): Promise<FileChange[]> {
    const args = ["diff-tree", "-r", "-z", "-M", "--raw", "--numstat", "--no-commit-id", "--no-ext-diff", "--no-textconv"];
    if (a) args.push(a, b);
    else args.push("--root", b);
    args.push("--", ...(paths ?? []));
    return parseRawNumstat(await this.read(args, { signal, env: { GIT_LITERAL_PATHSPECS: "1" } }));
  }

  async commit(hash: string, opts?: ReadOptions): Promise<CommitDetails> {
    const { commit, body } = await this.commitHeader(hash, opts?.signal);
    let files = await this.rawChanges(commit.parents[0] ?? null, commit.hash, undefined, opts?.signal);
    let filesTruncated = false;
    if (files.length > MAX_COMMIT_FILES) {
      files = files.slice(0, MAX_COMMIT_FILES);
      filesTruncated = true;
    }
    return { ...commit, body, files, ...(filesTruncated ? { filesTruncated } : {}) };
  }

  private patchArgs(context: number): string[] {
    return ["--no-color", "--no-ext-diff", "--no-textconv", "-M", `-U${context}`, "--src-prefix=a/", "--dst-prefix=b/"];
  }

  private async treeDiff(a: string | null, b: string, opts?: DiffOptions): Promise<FileDiff[]> {
    let paths: string[] | undefined;
    if (opts?.path) {
      const all = await this.rawChanges(a, b, undefined, opts.signal);
      const hit = all.find((f) => f.path === opts.path || f.oldPath === opts.path);
      paths = hit ? [hit.path, ...(hit.oldPath ? [hit.oldPath] : [])] : [opts.path];
    }
    const files = await this.rawChanges(a, b, paths, opts?.signal);
    const args = ["diff-tree", "-r", "-p", ...this.patchArgs(opts?.context ?? 3)];
    if (a) args.push(a, b);
    else args.push("--root", b);
    args.push("--", ...(paths ?? []));
    return this.patchFor(files, args, opts?.signal);
  }

  private async patchFor(files: FileChange[], args: string[], signal?: AbortSignal): Promise<FileDiff[]> {
    if (!files.length) return [];
    const r = await this.run(args, { readOnly: true, signal, maxBytes: MAX_PATCH_BYTES, env: { GIT_LITERAL_PATHSPECS: "1" } });
    if (r.code !== 0 && !r.truncated) throw gitFailure(r);
    const sections = parsePatch(r.stdout);
    if (r.truncated) {
      // Keep fully received files; mark the cut file and everything after it as truncated.
      const complete = sections.slice(0, -1);
      let cut = false;
      return combineDiff(files, complete).map((f) => {
        if (cut || (!f.hunks.length && !f.binary)) {
          cut = true;
          return { ...f, hunks: [], truncated: true };
        }
        return f;
      });
    }
    const out = combineDiff(files, sections);
    // Binary-by-numstat files never carry hunks.
    for (const f of out) if (f.binary) f.hunks = [];
    return out;
  }

  async diff(spec: DiffSpec, opts?: DiffOptions): Promise<Diff> {
    if (spec.kind === "commit") {
      assertSafeArg("commit", spec.hash);
      const { commit } = await this.commitHeader(spec.hash, opts?.signal);
      return { spec, files: await this.treeDiff(commit.parents[0] ?? null, commit.hash, opts) };
    }
    if (spec.kind === "compare") {
      assertSafeArg("base", spec.base);
      assertSafeArg("head", spec.head);
      return { spec, files: await this.treeDiff(spec.base, spec.head, opts) };
    }
    return { spec, files: await this.workingDiff(spec.staged, opts) };
  }

  private async workingDiff(staged: boolean, opts?: DiffOptions): Promise<FileDiff[]> {
    const paths = opts?.path ? [opts.path] : [];
    const base = ["diff", ...(staged ? ["--cached"] : [])];
    const raw = await this.read([...base, "-z", "-M", "--raw", "--numstat", "--no-ext-diff", "--no-textconv", "--", ...paths], {
      signal: opts?.signal,
      env: { GIT_LITERAL_PATHSPECS: "1" },
    });
    const files = parseRawNumstat(raw);
    const diffs = await this.patchFor(files, [...base, ...this.patchArgs(opts?.context ?? 3), "--", ...paths], opts?.signal);
    if (!staged) {
      const ut = await this.read(["ls-files", "-z", "--others", "--exclude-standard", "--", ...paths], { signal: opts?.signal, env: { GIT_LITERAL_PATHSPECS: "1" } });
      const untracked = ut.split("\0").filter(Boolean);
      for (const [i, p] of untracked.entries()) diffs.push(await this.untrackedDiff(p, i >= MAX_UNTRACKED_DIFF_FILES));
    }
    return diffs;
  }

  private async untrackedDiff(path: string, skip: boolean): Promise<FileDiff> {
    const fd: FileDiff = { path, status: "A", binary: false, hunks: [] };
    if (skip) return { ...fd, truncated: true };
    const abs = join(this.toplevel, path);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return fd;
    fd.newSize = st.size;
    if (st.size > MAX_UNTRACKED_DIFF_BYTES) return { ...fd, truncated: true };
    const buf = await readFile(abs);
    if (isBinary(buf)) return { ...fd, binary: true };
    const text = buf.toString("utf8");
    if (!text) return fd;
    const noEol = !text.endsWith("\n");
    const lines = (noEol ? text : text.slice(0, -1)).split("\n");
    fd.hunks = [
      {
        header: `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: [
          ...lines.map((t, i) => ({ kind: "add" as const, text: t, newNo: i + 1 })),
          ...(noEol ? [{ kind: "meta" as const, text: "\\ No newline at end of file" }] : []),
        ],
      },
    ];
    return fd;
  }

  async fileHistory(path: string, cursor: string | null, limit: number, opts?: ReadOptions): Promise<HistoryPage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError("BAD_REQUEST", "Invalid file history cursor");
    const [lite, out] = await Promise.all([
      this.refsLite(opts),
      this.read(["log", "--follow", "-z", "--no-show-signature", `--format=${LOG_FORMAT}`, `--skip=${offset}`, `-n${limit + 1}`, "--end-of-options", "HEAD", "--", path], {
        signal: opts?.signal,
        env: { GIT_LITERAL_PATHSPECS: "1" },
      }).catch((e) => {
        if (AppError.from(e).message.match(/does not have any commits|bad default revision|unknown revision/)) return "";
        throw e;
      }),
    ]);
    const all = parseLog(out);
    const commits = all.slice(0, limit);
    return { commits, cursor: all.length > limit ? String(offset + limit) : null, refsVersion: lite.version };
  }

  async blame(path: string, rev: string, opts?: ReadOptions): Promise<BlameLine[]> {
    assertSafeArg("rev", rev);
    const r = await this.run(["blame", "--porcelain", rev, "--", path], { readOnly: true, signal: opts?.signal, env: { GIT_LITERAL_PATHSPECS: "1" } });
    if (r.code !== 0) {
      if (/no such path|no such ref|bad revision/i.test(r.stderr)) throw new AppError("NOT_FOUND", scrubText(r.stderr.trim()));
      throw gitFailure(r);
    }
    return parseBlamePorcelain(r.stdout);
  }

  async search(q: SearchQuery, opts?: ReadOptions): Promise<Commit[]> {
    const text = q.text.trim();
    if (!text) return [];
    const fields = new Set(q.fields ?? ["hash", "subject", "body", "author", "ref"]);
    const limit = q.limit ?? 50;
    const signal = opts?.signal;
    const base = ["log", "--all", "-z", "--no-show-signature", `--format=${LOG_FORMAT}`, `-n${limit}`, "-i", "-F"];
    const tasks: Promise<Commit[]>[] = [];
    const logged = (args: string[]) =>
      this.run(args, { readOnly: true, signal }).then((r) => (r.code === 0 ? parseLog(r.stdout) : []));
    if (fields.has("hash") && /^[0-9a-f]{4,64}$/i.test(text)) {
      tasks.push(
        (async () => {
          const r = await this.run(["rev-parse", `--disambiguate=${text.toLowerCase()}`], { readOnly: true, signal });
          const objs = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
          if (!objs.length) return [];
          const types = await this.run(["cat-file", "--batch-check=%(objecttype) %(objectname)"], { readOnly: true, signal, input: objs.join("\n") + "\n" });
          const commits = types.stdout
            .split("\n")
            .filter((l) => l.startsWith("commit "))
            .map((l) => l.slice(7))
            .slice(0, limit);
          return commits.length ? logged(["log", "--no-walk", "-z", "--no-show-signature", `--format=${LOG_FORMAT}`, ...commits, "--"]) : [];
        })(),
      );
    }
    if (fields.has("subject") || fields.has("body")) {
      tasks.push(
        logged([...base, `--grep=${text}`, "--"]).then((cs) => (fields.has("body") ? cs : cs.filter((c) => c.subject.toLowerCase().includes(text.toLowerCase())))),
      );
    }
    if (fields.has("author")) tasks.push(logged([...base, `--author=${text}`, "--"]));
    if (fields.has("ref")) {
      tasks.push(
        (async () => {
          const lite = await this.refsLite(opts);
          const t = text.toLowerCase();
          const hashes = [...new Set(lite.refs.filter((r) => r.short.toLowerCase().includes(t)).map((r) => r.commit))].slice(0, limit);
          return hashes.length ? logged(["log", "--no-walk", "-z", "--no-show-signature", `--format=${LOG_FORMAT}`, ...hashes, "--"]) : [];
        })(),
      );
    }
    const seen = new Set<string>();
    const merged: Commit[] = [];
    for (const list of await Promise.all(tasks)) {
      for (const c of list) {
        if (seen.has(c.hash)) continue;
        seen.add(c.hash);
        merged.push(c);
      }
    }
    merged.sort((a, b) => b.committer.date - a.committer.date);
    return merged.slice(0, limit);
  }

  async file(path: string, rev: string, opts?: ReadOptions): Promise<{ content: string; encoding: "utf8" | "base64"; size: number }> {
    assertSafeArg("rev", rev);
    if (path.includes("\0")) throw new AppError("BAD_REQUEST", "Invalid path");
    const spec = `${rev}:${path.replace(/^\/+/, "")}`;
    const sz = await this.run(["cat-file", "-s", spec], { readOnly: true, signal: opts?.signal });
    if (sz.code !== 0) throw new AppError("NOT_FOUND", `"${path}" does not exist at ${rev}`);
    const size = Number(sz.stdout.trim());
    if (size > MAX_FILE_BYTES) throw new AppError("UNSUPPORTED", `"${path}" is ${size} bytes; files larger than ${MAX_FILE_BYTES} bytes are not served.`);
    const r = await this.run(["cat-file", "blob", spec], { readOnly: true, signal: opts?.signal, binary: true });
    if (r.code !== 0) throw gitFailure(r);
    const buf = r.stdoutBytes!;
    return isBinary(buf) ? { content: buf.toString("base64"), encoding: "base64", size } : { content: buf.toString("utf8"), encoding: "utf8", size };
  }

  // -------------------------------------------------------------------------
  // working tree
  // -------------------------------------------------------------------------

  async operation(): Promise<InProgressOperation | null> {
    const g = this.gitDir;
    const readT = (p: string) => readFile(join(g, p), "utf8").then((s) => s.trim(), () => null);
    const exists = (p: string) => stat(join(g, p)).then(() => true, () => false);
    if (await exists("rebase-merge")) {
      const [interactive, step, total, onto, headName] = await Promise.all([
        exists("rebase-merge/interactive"),
        readT("rebase-merge/msgnum"),
        readT("rebase-merge/end"),
        readT("rebase-merge/onto"),
        readT("rebase-merge/head-name"),
      ]);
      return {
        kind: "rebase",
        interactive,
        ...(step ? { step: Number(step) } : {}),
        ...(total ? { total: Number(total) } : {}),
        ...(onto ? { onto } : {}),
        ...(headName && headName !== "detached HEAD" ? { headName } : {}),
      };
    }
    if (await exists("rebase-apply")) {
      if (await exists("rebase-apply/applying")) return { kind: "am" };
      const [step, total, onto, headName] = await Promise.all([readT("rebase-apply/next"), readT("rebase-apply/last"), readT("rebase-apply/onto"), readT("rebase-apply/head-name")]);
      return {
        kind: "rebase",
        interactive: false,
        ...(step ? { step: Number(step) } : {}),
        ...(total ? { total: Number(total) } : {}),
        ...(onto ? { onto } : {}),
        ...(headName && headName !== "detached HEAD" ? { headName } : {}),
      };
    }
    const mergeHead = await readT("MERGE_HEAD");
    if (mergeHead) {
      const msg = await readT("MERGE_MSG");
      return { kind: "merge", head: mergeHead.split("\n")[0], ...(msg ? { message: msg.split("\n")[0] } : {}) };
    }
    const cp = await readT("CHERRY_PICK_HEAD");
    if (cp) return { kind: "cherry-pick", head: cp };
    const rv = await readT("REVERT_HEAD");
    if (rv) return { kind: "revert", head: rv };
    // Multi-commit sequencer stopped without a *_HEAD (e.g. after resolving): still in progress.
    const todo = await readT("sequencer/todo");
    if (todo) {
      const first = todo.split("\n")[0] ?? "";
      if (first.startsWith("revert")) return { kind: "revert" };
      if (first.startsWith("pick")) return { kind: "cherry-pick" };
    }
    if (await exists("BISECT_LOG")) return { kind: "bisect" };
    return null;
  }

  async status(opts?: ReadOptions): Promise<WorkingTreeStatus> {
    const [out, operation] = await Promise.all([
      this.read(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"], { signal: opts?.signal }),
      this.operation(),
    ]);
    const p = parseStatusV2(out);
    return { staged: p.staged, unstaged: p.unstaged, untracked: p.untracked, conflicted: p.conflicted, operation, ...(p.branch ? { branch: p.branch } : {}) };
  }

  /** Cheap digest of the working-tree state for change detection. */
  async statusDigest(): Promise<string> {
    const [out, op] = await Promise.all([
      this.read(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]),
      this.operation(),
    ]);
    // Include file mtimes/sizes of modified files so editing an already-modified file is noticed.
    const p = parseStatusV2(out);
    const touched = [...p.unstaged.map((f) => f.path), ...p.untracked].slice(0, 2000);
    const stamps = await Promise.all(
      touched.map((f) =>
        stat(join(this.toplevel, f)).then(
          (s) => `${f}:${s.size}:${s.mtimeMs}`,
          () => `${f}:-`,
        ),
      ),
    );
    return hash64(`${out}\n${JSON.stringify(op)}\n${stamps.join("\n")}`);
  }

  async worktrees(opts?: ReadOptions): Promise<Worktree[]> {
    const v = await gitVersion();
    const z = versionAtLeast(v.version, [2, 36, 0]);
    const out = await this.read(["worktree", "list", "--porcelain", ...(z ? ["-z"] : [])], { signal: opts?.signal });
    const list = parseWorktreeList(out, z ? "\0" : "\n");
    for (const w of list) w.isCurrent = real(w.path) === this.toplevel;
    return list;
  }

  async remotes(opts?: ReadOptions): Promise<Remote[]> {
    const names = await this.remoteNames();
    return Promise.all(
      names.map(async (name) => {
        const [f, p] = await Promise.all([
          this.run(["remote", "get-url", "--", name], { readOnly: true, signal: opts?.signal }).catch(() => null),
          this.run(["remote", "get-url", "--push", "--", name], { readOnly: true, signal: opts?.signal }).catch(() => null),
        ]);
        const fetchUrl = scrubUrl(f?.code === 0 ? f.stdout.trim() : "");
        const pushUrl = scrubUrl(p?.code === 0 ? p.stdout.trim() : "") || fetchUrl;
        return { name, fetchUrl, pushUrl };
      }),
    );
  }

  async conflict(path: string, opts?: ReadOptions): Promise<ConflictFile> {
    const out = await this.read(["ls-files", "-u", "-z", "--", path], { signal: opts?.signal, env: { GIT_LITERAL_PATHSPECS: "1" } });
    const stages = new Map<number, string>();
    for (const rec of out.split("\0")) {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(rec);
      if (m && m[4] === path) stages.set(Number(m[3]), m[2]!);
    }
    if (!stages.size) throw new AppError("NOT_FOUND", `"${path}" is not conflicted`);
    const res: ConflictFile = { path, binary: false };
    const names = { 1: "base", 2: "ours", 3: "theirs" } as const;
    for (const [n, sha] of stages) {
      const r = await this.run(["cat-file", "blob", sha], { readOnly: true, binary: true, signal: opts?.signal });
      if (r.code !== 0) continue;
      if (isBinary(r.stdoutBytes!)) res.binary = true;
      else res[names[n as 1 | 2 | 3]] = r.stdoutBytes!.toString("utf8");
    }
    const w = await readFile(join(this.toplevel, path)).catch(() => null);
    if (w) {
      if (isBinary(w)) res.binary = true;
      else res.working = w.toString("utf8");
    }
    if (res.binary) {
      delete res.base;
      delete res.ours;
      delete res.theirs;
      delete res.working;
    }
    return res;
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  subscribe(listener: (e: RepositoryEvent) => void): () => void {
    return this.hooks.subscribe ? this.hooks.subscribe(this.key, listener) : () => {};
  }

  // -------------------------------------------------------------------------
  // mutations
  // -------------------------------------------------------------------------

  private async checkPrecondition(pre: MutationPrecondition | undefined) {
    if (!pre) return;
    if (pre.refsVersion) {
      const lite = await this.refsLite();
      if (lite.version !== pre.refsVersion) throw new AppError("STALE_STATE", "The repository changed since it was last read.", { expected: pre.refsVersion, actual: lite.version });
    }
    if (pre.ref) {
      assertSafeArg("ref", pre.ref.name);
      const r = await this.run(["rev-parse", "-q", "--verify", "--end-of-options", `${pre.ref.name}^{commit}`], { readOnly: true });
      const actual = r.code === 0 ? r.stdout.trim() : null;
      const want = pre.ref.commit.toLowerCase();
      if (!actual || !(actual === want || (want.length >= 4 && actual.startsWith(want)))) {
        throw new AppError("STALE_STATE", `"${pre.ref.name}" is no longer at ${want.slice(0, 8)}.`, { ref: pre.ref.name, expected: want, actual });
      }
    }
  }

  async mutate(m: GitMutation, precondition?: MutationPrecondition): Promise<MutationResult> {
    await requireGit();
    const operationId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.hooks.publish?.({ type: "operation.started", repositoryId: this.key, operationId, op: m.op });
    let ok = false;
    try {
      const res = await withLock(this.commonDir, async () => {
        await this.cleanupRebaseScratch();
        await this.checkPrecondition(precondition);
        return this.perform(m, precondition);
      });
      ok = true;
      return res;
    } finally {
      this.hooks.publish?.({ type: "operation.completed", repositoryId: this.key, operationId, op: m.op, ok });
      this.hooks.onMutated?.(this.key);
    }
  }

  private async perform(m: GitMutation, pre?: MutationPrecondition): Promise<MutationResult> {
    const log: RunResult[] = [];
    const editorEnv = { GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };
    /** Run one git step; throw GIT_FAILED (or CONFLICT when an operation is left in progress). */
    const step = async (args: string[], o: Omit<RunOptions, "cwd"> & { allowFail?: boolean; conflictAware?: boolean } = {}): Promise<RunResult> => {
      const r = await this.run(args, { ...o, env: { ...editorEnv, ...(o.env ?? {}) } });
      log.push(r);
      if (r.code !== 0 && !o.allowFail) {
        if (o.conflictAware) {
          const [op, st] = await Promise.all([this.operation(), this.status().catch(() => null)]);
          if (op || (st && st.conflicted.length)) {
            throw new AppError("CONFLICT", scrubText((r.stdout + r.stderr).trim() || "Conflicts must be resolved"), {
              operation: op,
              conflicted: st?.conflicted.map((c) => c.path) ?? [],
              ...(await this.resultDetails(log)),
            });
          }
        }
        if (/stale info|\(stale info\)/i.test(r.stderr)) {
          throw new AppError("STALE_STATE", scrubText(r.stderr.trim()), await this.resultDetails(log));
        }
        throw gitFailure(r, await this.resultDetails(log));
      }
      return r;
    };
    const lit = { GIT_LITERAL_PATHSPECS: "1" };
    let affected: string[] | undefined;
    let exitCode: number | undefined;

    switch (m.op) {
      case "checkout": {
        assertSafeArg("target", m.target);
        if (m.track) await step(["checkout", "--track", m.target]);
        else await step(["checkout", m.target, "--"]);
        break;
      }
      case "branch.create": {
        assertSafeArg("name", m.name);
        assertSafeArg("target", m.target);
        if (m.checkout) await step(["checkout", "-b", m.name, m.target, "--"]);
        else await step(["branch", m.name, m.target]);
        break;
      }
      case "branch.delete": {
        assertSafeArg("name", m.name);
        if (m.remote) {
          const remotes = await this.remoteNames();
          const remote = remotes.filter((r) => m.name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
          if (!remote) throw new AppError("REF_NOT_FOUND", `"${m.name}" does not name a branch of a configured remote`);
          const branch = m.name.slice(remote.length + 1);
          const lease = pre?.ref && (pre.ref.name === m.name || pre.ref.name === `refs/remotes/${m.name}`) ? [`--force-with-lease=refs/heads/${branch}:${pre.ref.commit}`] : [];
          await step(["push", ...lease, remote, "--delete", `refs/heads/${branch}`]);
        } else if (m.force && pre?.ref && (pre.ref.name === m.name || pre.ref.name === `refs/heads/${m.name}`) && /^[0-9a-f]{40,64}$/.test(pre.ref.commit)) {
          // Atomic compare-and-delete; refuses if checked out in any worktree first.
          const wts = await this.worktrees();
          if (wts.some((w) => w.branch === `refs/heads/${m.name}`)) throw new AppError("GIT_FAILED", `Cannot delete branch '${m.name}' checked out in a worktree`);
          await step(["update-ref", "-d", `refs/heads/${m.name}`, pre.ref.commit]);
          await step(["config", "--remove-section", `branch.${m.name}`], { allowFail: true });
        } else {
          await step(["branch", m.force ? "-D" : "-d", m.name]);
        }
        break;
      }
      case "branch.rename":
        assertSafeArg("from", m.from);
        assertSafeArg("to", m.to);
        await step(["branch", "-m", m.from, m.to]);
        break;
      case "tag.create": {
        assertSafeArg("name", m.name);
        assertSafeArg("target", m.target);
        if (m.message !== undefined || m.sign) await step(["tag", m.sign ? "-s" : "-a", "-F", "-", m.name, m.target], { input: m.message ?? "" });
        else await step(["tag", m.name, m.target]);
        break;
      }
      case "tag.delete":
        assertSafeArg("name", m.name);
        await step(["tag", "-d", m.name]);
        break;
      case "tag.push":
        assertSafeArg("name", m.name);
        assertSafeArg("remote", m.remote);
        await step(["push", m.remote, `refs/tags/${m.name}`]);
        break;
      case "merge": {
        assertSafeArg("ref", m.ref);
        const args = ["merge", "--no-edit"];
        if (m.noFastForward) args.push("--no-ff");
        if (m.squash) args.push("--squash");
        if (m.noCommit) args.push("--no-commit");
        await step([...args, m.ref], { conflictAware: true });
        break;
      }
      case "rebase": {
        assertSafeArg("onto", m.onto);
        if (!m.todo) {
          await step(["rebase", m.onto], { conflictAware: true });
          break;
        }
        const dir = await mkdtemp(join(tmpdir(), "lanes-rebase-"));
        this.rebaseScratch.add(dir);
        const lines: string[] = [];
        for (const [i, t] of m.todo.entries()) {
          if (!/^[0-9a-f]{4,64}$/i.test(t.hash)) throw new AppError("BAD_REQUEST", `Invalid hash in todo: ${t.hash}`);
          const custom = t.message !== undefined && (t.action === "reword" || t.action === "squash");
          lines.push(`${custom && t.action === "reword" ? "pick" : t.action} ${t.hash}`);
          if (custom) {
            const msgFile = join(dir, `msg-${i}.txt`);
            await writeFile(msgFile, t.message!, { mode: 0o600 });
            lines.push(`exec git commit --amend --allow-empty -F ${shQuote(msgFile)}`);
          }
        }
        const todo = join(dir, "todo");
        await writeFile(todo, lines.join("\n") + "\n", { mode: 0o600 });
        await step(["rebase", "-i", m.onto], { conflictAware: true, env: { GIT_SEQUENCE_EDITOR: sequenceEditor(todo) } });
        break;
      }
      case "cherry-pick": {
        const args = ["cherry-pick"];
        if (m.noCommit) args.push("--no-commit");
        if (m.recordOrigin) args.push("-x");
        if (m.mainline) args.push("-m", String(m.mainline));
        for (const h of m.hashes) assertSafeArg("hash", h);
        await step([...args, ...m.hashes], { conflictAware: true });
        break;
      }
      case "revert":
        assertSafeArg("hash", m.hash);
        await step(["revert", "--no-edit", ...(m.mainline ? ["-m", String(m.mainline)] : []), m.hash], { conflictAware: true });
        break;
      case "reset":
        assertSafeArg("target", m.target);
        await step(["reset", `--${m.mode}`, m.target, "--"]);
        break;
      case "operation.continue":
      case "operation.skip":
      case "operation.abort": {
        const op = await this.operation();
        if (!op) throw new AppError("BAD_REQUEST", "No merge, rebase, cherry-pick or revert is in progress");
        const verb = m.op === "operation.continue" ? "--continue" : m.op === "operation.skip" ? "--skip" : "--abort";
        if (op.kind === "bisect") {
          if (m.op !== "operation.abort") throw new AppError("UNSUPPORTED", "Bisect can only be reset (abort) from here; use `git-graph run -- bisect ...`.");
          await step(["bisect", "reset"]);
        } else if (op.kind === "merge" && m.op === "operation.skip") {
          throw new AppError("BAD_REQUEST", "A merge has no steps to skip");
        } else if (op.kind === "merge" && m.op === "operation.continue") {
          await step(["commit", "--no-edit"], { conflictAware: true });
        } else {
          await step([op.kind, verb], { conflictAware: m.op !== "operation.abort" });
        }
        break;
      }
      case "stage":
        await step(["add", "-A", "--", ...m.paths], { env: lit });
        break;
      case "unstage":
        await step(["reset", "-q", "--", ...m.paths], { env: lit });
        break;
      case "stage.patch":
        await step(["apply", "--cached", "--recount", ...(m.reverse ? ["--reverse"] : []), "-"], { input: ensureNl(m.patch) });
        break;
      case "discard.patch":
        await step(["apply", "--reverse", "--recount", "-"], { input: ensureNl(m.patch) });
        break;
      case "restore": {
        const args = ["restore"];
        if (m.source) {
          assertSafeArg("source", m.source);
          args.push(`--source=${m.source}`);
        }
        const worktree = m.worktree ?? true;
        if (m.staged) args.push("--staged");
        if (worktree) args.push("--worktree");
        if (!m.staged && !worktree) throw new AppError("BAD_REQUEST", "restore needs staged and/or worktree");
        await step([...args, "--", ...m.paths], { env: lit });
        break;
      }
      case "commit": {
        const args = ["commit", "-F", "-"];
        if (m.amend) args.push("--amend");
        if (m.signoff) args.push("--signoff");
        if (m.allowEmpty) args.push("--allow-empty");
        await step(args, { input: m.message });
        break;
      }
      case "stash.push": {
        const args = ["stash", "push"];
        if (m.message) args.push("-m", m.message);
        if (m.includeUntracked) args.push("--include-untracked");
        if (m.keepIndex) args.push("--keep-index");
        if (m.staged) args.push("--staged");
        // Per-path :(literal) magic instead of GIT_LITERAL_PATHSPECS: stash runs internal commands
        // with magic pathspecs (":/") that the env var would break.
        await step([...args, ...(m.paths?.length ? ["--", ...m.paths.map((p) => `:(literal)${p}`)] : [])]);
        break;
      }
      case "stash.apply":
      case "stash.pop":
        await step(["stash", m.op === "stash.apply" ? "apply" : "pop", ...(m.reinstateIndex ? ["--index"] : []), `stash@{${int(m.index)}}`], { conflictAware: true });
        break;
      case "stash.drop":
        await step(["stash", "drop", `stash@{${int(m.index)}}`]);
        break;
      case "stash.branch":
        assertSafeArg("name", m.name);
        await step(["stash", "branch", m.name, `stash@{${int(m.index)}}`], { conflictAware: true });
        break;
      case "fetch": {
        const args = ["fetch"];
        if (m.prune) args.push("--prune");
        if (m.pruneTags) args.push("--prune-tags");
        if (m.remote) {
          assertSafeArg("remote", m.remote);
          args.push(m.remote);
        } else args.push("--all");
        await step(args);
        break;
      }
      case "pull": {
        const args = ["pull", "--no-edit"];
        if (m.rebase === true) args.push("--rebase");
        if (m.rebase === false) args.push("--no-rebase");
        if (m.ffOnly) args.push("--ff-only");
        if (m.remote) {
          assertSafeArg("remote", m.remote);
          args.push(m.remote);
          if (m.branch) {
            assertSafeArg("branch", m.branch);
            args.push(m.branch);
          }
        }
        await step(args, { conflictAware: true });
        break;
      }
      case "push": {
        assertSafeArg("remote", m.remote);
        assertSafeArg("branch", m.branch);
        const b = m.branch.replace(/^refs\/heads\//, "");
        const args = ["push"];
        if (m.setUpstream) args.push("--set-upstream");
        if (m.forceWithLease) {
          if (m.forceWithLease.expect && !/^[0-9a-f]{40,64}$/i.test(m.forceWithLease.expect)) throw new AppError("BAD_REQUEST", "forceWithLease.expect must be a full object id");
          args.push(m.forceWithLease.expect ? `--force-with-lease=refs/heads/${b}:${m.forceWithLease.expect}` : `--force-with-lease=refs/heads/${b}`);
        }
        await step([...args, m.remote, `refs/heads/${b}:refs/heads/${b}`]);
        break;
      }
      case "remote.add":
        assertSafeArg("name", m.name);
        assertSafeArg("url", m.url);
        await step(["remote", "add", m.name, m.url]);
        break;
      case "remote.remove":
        assertSafeArg("name", m.name);
        await step(["remote", "remove", m.name]);
        break;
      case "remote.rename":
        assertSafeArg("from", m.from);
        assertSafeArg("to", m.to);
        await step(["remote", "rename", m.from, m.to]);
        break;
      case "remote.set-url":
        assertSafeArg("name", m.name);
        assertSafeArg("url", m.url);
        await step(["remote", "set-url", m.name, m.url]);
        break;
      case "upstream.set":
        assertSafeArg("branch", m.branch);
        if (m.upstream === null) await step(["branch", "--unset-upstream", m.branch]);
        else {
          assertSafeArg("upstream", m.upstream);
          await step(["branch", `--set-upstream-to=${m.upstream}`, m.branch]);
        }
        break;
      case "worktree.add": {
        const path = resolve(this.toplevel, m.path);
        const args = ["worktree", "add"];
        if (m.newBranch) {
          assertSafeArg("newBranch", m.newBranch);
          args.push("-b", m.newBranch);
        }
        args.push(path);
        const commitish = m.branch ?? m.commitish;
        if (commitish) {
          assertSafeArg("branch", commitish);
          args.push(commitish);
        }
        await step(args);
        break;
      }
      case "worktree.remove":
        await step(["worktree", "remove", ...(m.force ? ["--force"] : []), resolve(this.toplevel, m.path)]);
        break;
      case "worktree.lock":
        await step(["worktree", "lock", ...(m.reason ? ["--reason", m.reason] : []), resolve(this.toplevel, m.path)]);
        break;
      case "worktree.unlock":
        await step(["worktree", "unlock", resolve(this.toplevel, m.path)]);
        break;
      case "worktree.prune": {
        const r = await step(["worktree", "prune", "--verbose", ...(m.dryRun ? ["--dry-run"] : [])], { cLocale: true });
        affected = (r.stdout + r.stderr)
          .split("\n")
          .map((l) => /^Removing (.+?):/.exec(l)?.[1])
          .filter((x): x is string => !!x);
        break;
      }
      case "conflict.resolve": {
        const p = m.path;
        if (typeof m.resolution === "string") {
          await step(["checkout", m.resolution === "ours" ? "--ours" : "--theirs", "--", p], { env: lit });
        } else {
          const abs = resolve(this.toplevel, p);
          if (!abs.startsWith(this.toplevel + sep)) throw new AppError("BAD_REQUEST", "Path escapes the worktree");
          await writeFile(abs, m.resolution.content);
        }
        await step(["add", "--", p], { env: lit });
        break;
      }
      case "clean": {
        const flags = ["-n", ...(m.directories ? ["-d"] : [])];
        const preview = await step(["clean", ...flags, "--", ...m.paths], { env: lit, cLocale: true });
        affected = preview.stdout
          .split("\n")
          .map((l) => /^Would remove (.+)$/.exec(l)?.[1])
          .filter((x): x is string => !!x)
          .map(unquoteCPath);
        if (!m.dryRun && affected.length) {
          // Delete exactly the previewed paths, nothing else.
          await step(["clean", "-f", ...(m.directories ? ["-d"] : []), "--", ...affected], { env: lit, cLocale: true });
        }
        break;
      }
      case "git.run": {
        if (!m.args.length) throw new AppError("BAD_REQUEST", "args must not be empty");
        const r = await step(m.args, { allowFail: true });
        exitCode = r.code;
        break;
      }
      default: {
        const never: never = m;
        throw new AppError("UNSUPPORTED", `Unsupported mutation ${(never as { op: string }).op}`);
      }
    }
    const details = await this.resultDetails(log);
    return {
      op: m.op,
      output: details.output,
      invocations: details.invocations,
      exitCode: exitCode ?? log[log.length - 1]?.code ?? 0,
      refsVersion: details.refsVersion,
      ...(affected ? { affected } : {}),
    };
  }

  private async resultDetails(log: RunResult[]): Promise<{ output: string; invocations: string[]; refsVersion?: string }> {
    const refsVersion = await this.refsLite().then(
      (r) => r.version,
      () => undefined,
    );
    return {
      output: scrubText(log.map((r) => (r.stdout + r.stderr).trimEnd()).filter(Boolean).join("\n")),
      invocations: log.map((r) => r.invocation),
      ...(refsVersion ? { refsVersion } : {}),
    };
  }

  private async cleanupRebaseScratch() {
    if (!this.rebaseScratch.size) return;
    if (await this.operation()) return;
    for (const d of this.rebaseScratch) await rm(d, { recursive: true, force: true }).catch(() => {});
    this.rebaseScratch.clear();
  }

  /** Commits reachable from `next` refs but not from `prev` (bounded). */
  async newCommits(prev: readonly Ref[], next: readonly Ref[], max = 500): Promise<string[]> {
    const old = new Set(prev.map((r) => r.commit));
    const tips = [...new Set(next.map((r) => r.commit))].filter((c) => !old.has(c));
    if (!tips.length) return [];
    const input = [...tips, ...[...old].map((h) => `^${h}`)].join("\n") + "\n";
    const r = await this.run(["rev-list", `--max-count=${max}`, "--stdin"], { readOnly: true, input });
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  }

  /** Release cached history streams. */
  dispose() {
    this.history_.clear();
  }

  /** Names of files in a directory of the git dir (used by tests/diagnostics). */
  async gitDirEntries(): Promise<string[]> {
    return readdir(this.gitDir).catch(() => []);
  }
}

function int(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new AppError("BAD_REQUEST", "index must be a non-negative integer");
  return n;
}

function ensureNl(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/** POSIX single-quote a string for a shell command line git will run (sequence editor / exec). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * GIT_SEQUENCE_EDITOR value that replaces git's generated todo with ours. Git runs the editor through
 * the shell as `<editor> "$@"`, so the source path is quoted; safe with spaces in paths.
 */
export function sequenceEditor(todoPath: string): string {
  if (process.platform === "win32") {
    return `${shQuote(process.execPath.replace(/\\/g, "/"))} -e ${shQuote("require('fs').copyFileSync(process.argv[1], process.argv[2])")} ${shQuote(todoPath.replace(/\\/g, "/"))}`;
  }
  return `cp ${shQuote(todoPath)}`;
}
