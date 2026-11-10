// Adapter contract tests against real git, on disposable fixtures in a temp dir.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, makeBasic, type BasicFixture } from "../fixtures/make-fixtures.ts";
import { CliGitAdapter } from "../../src/companion/git-adapter.ts";
import { LocalRepos } from "../../src/companion/local-repos.ts";
import { createCompanionRegistry } from "../../src/companion/commands.ts";
import { executeCommand } from "../../src/core/commands/registry.ts";
import { hunkPatch } from "../../src/core/git/diff.ts";
import { AppError, DEFAULT_HISTORY_QUERY, type Commit, type HistoryQuery } from "../../src/core/types.ts";

// ---------------------------------------------------------------------------
// isolation helpers
// ---------------------------------------------------------------------------

function isolate(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lanes-companion-")));
  const cfg = join(root, "user.gitconfig");
  writeFileSync(cfg, "[user]\n\tname = Lanes Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n");
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.LANES_CONFIG_DIR = join(root, "cfg");
  // makeBasic() reads the fixture identity config from .fixtures/.gitconfig.
  if (!existsSync(join(ROOT, ".gitconfig"))) {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(join(ROOT, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n");
  }
  return root;
}

function g(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

async function expectCode(p: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    const err = AppError.from(e);
    expect(err.code, err.message).toBe(code);
    return err;
  }
  throw new Error(`expected ${code}`);
}

async function allPages(a: CliGitAdapter, q: HistoryQuery, limit: number): Promise<Commit[]> {
  const out: Commit[] = [];
  let cursor: string | null = null;
  do {
    const p = await a.history(q, cursor, limit);
    out.push(...p.commits);
    cursor = p.cursor;
  } while (cursor);
  return out;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fixture(): { root: string; fx: BasicFixture } {
  const root = isolate();
  roots.push(root);
  return { root, fx: makeBasic(root) };
}

// ---------------------------------------------------------------------------
// read side
// ---------------------------------------------------------------------------

describe("CliGitAdapter reads", () => {
  let fx: BasicFixture;
  let a: CliGitAdapter;
  beforeAll(async () => {
    fx = fixture().fx;
    a = await CliGitAdapter.open(fx.repo, "basic");
  });

  it("resolves toplevel / git dir / common dir through git", async () => {
    expect(a.toplevel).toBe(realpathSync(fx.repo));
    expect(a.commonDir).toBe(realpathSync(join(fx.repo, ".git")));
    const wt = await CliGitAdapter.open(join(fx.worktreeFeature, "src"), "wt");
    expect(wt.toplevel).toBe(realpathSync(fx.worktreeFeature));
    expect(wt.commonDir).toBe(a.commonDir);
    expect(wt.gitDir).not.toBe(a.gitDir);
  });

  it("refs: multiple refs on one commit, upstream ahead/behind, worktree checkout, symrefs, stash", async () => {
    const snap = await a.refs();
    const by = (s: string) => snap.refs.find((r) => r.short === s)!;
    const c3 = g(fx.repo, ["rev-parse", "v1.0^{commit}"]).trim();
    expect(by("v1.0").commit).toBe(c3);
    expect(by("v1.0").target).not.toBe(c3); // annotated tag object
    expect(by("v1.0-lw").commit).toBe(c3);
    expect(by("release/1.0").commit).toBe(c3);
    expect(by("main")).toMatchObject({ kind: "head", upstream: "refs/remotes/origin/main", ahead: 1, behind: 0, checkedOutAt: realpathSync(fx.repo) });
    expect(realpathSync(by("feature/auth").checkedOutAt!)).toBe(realpathSync(fx.worktreeFeature));
    expect(by("origin/HEAD").symbolicTarget).toBe("refs/remotes/origin/main");
    expect(by("origin/hotfix/urgent")).toMatchObject({ kind: "remote", remote: "origin" });
    expect(by("stash@{0}")).toMatchObject({ kind: "stash", message: "On main: WIP: experiment with util" });
    expect(snap.head).toEqual({ kind: "branch", ref: "refs/heads/main", commit: g(fx.repo, ["rev-parse", "HEAD"]).trim() });
    expect((await a.refsLite()).version).toBe(snap.version);
  });

  it("history: concatenated pages equal git log --date-order (set and order)", async () => {
    const q: HistoryQuery = { ...DEFAULT_HISTORY_QUERY, includeStashes: false };
    const expected = g(fx.repo, ["log", "--date-order", "--format=%H", "--branches", "--remotes", "--tags", "HEAD"]).trim().split("\n");
    for (const limit of [1, 3, 7, 1000]) {
      const got = await allPages(a, q, limit);
      expect(got.map((c) => c.hash)).toEqual(expected);
    }
    const page = await a.history(q, null, 1000);
    expect(page.total).toBe(expected.length);
    expect(page.cursor).toBeNull();
  });

  it("history: stashes are single rows; their helper commits are hidden", async () => {
    const got = await allPages(a, DEFAULT_HISTORY_QUERY, 4);
    const all = g(fx.repo, ["log", "--date-order", "--format=%H %P", "--all"]).trim().split("\n");
    const stash = g(fx.repo, ["rev-parse", "refs/stash"]).trim();
    const stashParents = all.find((l) => l.startsWith(stash))!.split(" ").slice(1);
    const expected = all.map((l) => l.split(" ")[0]!).filter((h) => !stashParents.slice(1).includes(h));
    expect(got.map((c) => c.hash)).toEqual(expected);
    expect(got.find((c) => c.hash === stash)!.parents).toEqual([stashParents[0]]);
  });

  it("history: filters, topo order, first-parent, unknown ref", async () => {
    const q: HistoryQuery = { ...DEFAULT_HISTORY_QUERY, refs: ["develop"], order: "topo", firstParent: true };
    const got = await allPages(a, q, 2);
    expect(got.map((c) => c.hash)).toEqual(g(fx.repo, ["log", "--topo-order", "--first-parent", "--format=%H", "develop"]).trim().split("\n"));
    await expectCode(a.history({ ...q, refs: ["does-not-exist"] }, null, 10), "REF_NOT_FOUND");
    await expectCode(a.history({ ...q, refs: ["--all"] }, null, 10), "BAD_REQUEST");
  });

  it("history: cursors survive snapshot eviction, and fail STALE_STATE after refs moved", async () => {
    const q: HistoryQuery = { ...DEFAULT_HISTORY_QUERY, includeStashes: false };
    const p1 = await a.history(q, null, 5);
    const fresh = await CliGitAdapter.open(fx.repo, "basic"); // empty snapshot cache
    const p2 = await fresh.history(q, p1.cursor, 5);
    const expected = g(fx.repo, ["log", "--date-order", "--format=%H", "--branches", "--remotes", "--tags", "HEAD"]).trim().split("\n");
    expect(p2.commits.map((c) => c.hash)).toEqual(expected.slice(5, 10));
    g(fx.repo, ["branch", "tmp-moved", "HEAD~1"]);
    try {
      // The original adapter still has the snapshot cached: consistent pages from the old snapshot.
      const p3 = await a.history(q, p1.cursor, 5);
      expect(p3.refsVersion).toBe(p1.refsVersion);
      const other = await CliGitAdapter.open(fx.repo, "basic");
      await expectCode(other.history(q, p1.cursor, 5), "STALE_STATE");
    } finally {
      g(fx.repo, ["branch", "-D", "tmp-moved"]);
    }
  });

  it("commit details: rename, delete, binary, root and merge", async () => {
    const hashOf = (s: string) => g(fx.repo, ["log", "--all", "--format=%H", "-F", `--grep=${s}`, "-1"]).trim();
    const ren = await a.commit(hashOf("Rename app.ts"));
    expect(ren.files).toEqual([{ path: "src/main.ts", oldPath: "src/app.ts", status: "R", additions: 0, deletions: 0 }]);
    const del = await a.commit(hashOf("Remove old docs"));
    expect(del.files).toEqual([
      { path: "assets/logo.bin", status: "M", binary: true },
      { path: "docs/old.md", status: "D", additions: 0, deletions: 1 },
    ]);
    const root = await a.commit(hashOf("Initial commit"));
    expect(root.parents).toEqual([]);
    expect(root.files.map((f) => f.path).sort()).toEqual(["README.md", "assets/logo.bin", "conflict.txt", "docs/my file.md", "docs/old.md", "src/app.ts"]);
    const merge = await a.commit(hashOf("Merge branch 'feature/auth'"));
    expect(merge.parents).toHaveLength(2);
    expect(merge.files.map((f) => f.path)).toEqual(["src/auth.ts"]); // vs first parent
    await expectCode(a.commit("deadbeefdeadbeef"), "COMMIT_NOT_FOUND");
  });

  it("diffs: commit vs parent, root vs empty tree, compare, path filter following renames", async () => {
    const hashOf = (s: string) => g(fx.repo, ["log", "--all", "--format=%H", "-F", `--grep=${s}`, "-1"]).trim();
    const usage = await a.diff({ kind: "commit", hash: hashOf("Document usage") });
    expect(usage.files).toHaveLength(1);
    expect(usage.files[0]!.hunks[0]!.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["", "## Usage", "", "Run it."]);
    const root = await a.diff({ kind: "commit", hash: hashOf("Initial commit") });
    expect(root.files.find((f) => f.path === "assets/logo.bin")!.binary).toBe(true);
    expect(root.files.find((f) => f.path === "docs/my file.md")!.hunks[0]!.lines[0]!.text).toBe("A file with a space in its name");
    const base = hashOf("Add util module");
    const head = g(fx.repo, ["rev-parse", "main"]).trim();
    const cmp = await a.diff({ kind: "compare", base, head }, { path: "src/main.ts" });
    expect(cmp.files.map((f) => [f.path, f.oldPath, f.status])).toEqual([["src/main.ts", "src/app.ts", "R"]]);
    const ctx0 = await a.diff({ kind: "commit", hash: hashOf("Document usage") }, { context: 0 });
    expect(ctx0.files[0]!.hunks[0]!.lines.every((l) => l.kind !== "context")).toBe(true);
  });

  it("working-tree diff: staged, unstaged (2 hunks) and untracked as added", async () => {
    const staged = await a.diff({ kind: "working", staged: true });
    expect(staged.files.map((f) => f.path)).toEqual(["README.md"]);
    const unstaged = await a.diff({ kind: "working", staged: false });
    expect(unstaged.files.map((f) => [f.path, f.status])).toEqual([
      ["src/main.ts", "M"],
      ["-dash.txt", "A"],
      ["notes with space.txt", "A"],
      ["ünïcødé.txt", "A"],
    ]);
    expect(unstaged.files[0]!.hunks).toHaveLength(2);
    expect(unstaged.files[2]!.hunks[0]!.lines).toEqual([{ kind: "add", text: "untracked", newNo: 1 }]);
    const only = await a.diff({ kind: "working", staged: false }, { path: "-dash.txt" });
    expect(only.files.map((f) => f.path)).toEqual(["-dash.txt"]);
  });

  it("status: staged/unstaged/untracked with unicode, dash and space names", async () => {
    const st = await a.status();
    expect(st.staged).toEqual([{ path: "README.md", status: "M" }]);
    expect(st.unstaged).toEqual([{ path: "src/main.ts", status: "M" }]);
    expect(st.untracked).toEqual(["-dash.txt", "notes with space.txt", "ünïcødé.txt"]);
    expect(st.operation).toBeNull();
    expect(st.branch).toEqual({ name: "main", upstream: "origin/main", ahead: 1, behind: 0 });
  });

  it("fileHistory follows renames; blame; search; file contents; remotes; worktrees; info", async () => {
    const fh = await a.fileHistory("src/main.ts", null, 2);
    expect(fh.commits.map((c) => c.subject)).toEqual(["Rename app.ts to main.ts", "Initial commit"]);
    expect(fh.cursor).toBeNull();
    const bl = await a.blame("README.md", "HEAD");
    expect(bl[0]).toMatchObject({ line: 1, text: "# Fixture", author: "Ada Lovelace" });
    expect((await a.search({ text: "logout" })).map((c) => c.subject)).toContain("Add logout");
    expect((await a.search({ text: "grace", fields: ["author"] })).length).toBeGreaterThan(0);
    const h = g(fx.repo, ["rev-parse", "HEAD"]).trim();
    expect((await a.search({ text: h.slice(0, 8), fields: ["hash"] }))[0]!.hash).toBe(h);
    expect((await a.search({ text: "hotfix", fields: ["ref"] }))[0]!.subject).toBe("Urgent hotfix");
    const bin = await a.file("assets/logo.bin", "HEAD");
    expect(bin.encoding).toBe("base64");
    expect(Buffer.from(bin.content, "base64").length).toBe(bin.size);
    expect(await a.file("docs/my file.md", "HEAD")).toEqual({ content: "A file with a space in its name\n", encoding: "utf8", size: 32 });
    await expectCode(a.file("nope.txt", "HEAD"), "NOT_FOUND");
    expect(await a.remotes()).toEqual([{ name: "origin", fetchUrl: fx.remote, pushUrl: fx.remote }]);
    const wts = await a.worktrees();
    expect(wts.map((w) => [realpathSync(w.path), w.branch, w.isMain, w.isCurrent])).toEqual([
      [realpathSync(fx.repo), "refs/heads/main", true, true],
      [realpathSync(fx.worktreeFeature), "refs/heads/feature/auth", false, false],
      [realpathSync(fx.worktreeTwo), "refs/heads/wt-two", false, false],
    ]);
    expect(await a.info()).toMatchObject({ name: "basic", defaultBranch: "main", worktreePath: realpathSync(fx.repo), visibility: "local" });
    const caps = await a.capabilities();
    expect(caps.history.available).toBe(true);
    expect(caps.clone).toMatchObject({ available: false });
  });

  it("remotes strip credentials", async () => {
    g(fx.repo, ["remote", "add", "secret", "https://user:ghp_token123@example.com/o/r.git"]);
    try {
      const r = (await a.remotes()).find((x) => x.name === "secret")!;
      expect(r.fetchUrl).toBe("https://example.com/o/r.git");
      expect(JSON.stringify(r)).not.toContain("ghp_token123");
    } finally {
      g(fx.repo, ["remote", "remove", "secret"]);
    }
  });
});

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

describe("CliGitAdapter mutations", () => {
  let fx: BasicFixture;
  let root: string;
  let a: CliGitAdapter;
  beforeAll(async () => {
    ({ fx, root } = fixture());
    a = await CliGitAdapter.open(fx.repo, "basic");
  });

  it("stage one hunk, then commit — verified with independent git commands", async () => {
    const d = await a.diff({ kind: "working", staged: false }, { path: "src/main.ts" });
    const f = d.files[0]!;
    expect(f.hunks).toHaveLength(2);
    const r = await a.mutate({ op: "stage.patch", patch: hunkPatch(f, f.hunks[0]!) });
    expect(r.invocations[0]).toMatch(/^git apply --cached --recount -$/);
    const cached = g(fx.repo, ["diff", "--cached", "--", "src/main.ts"]);
    expect(cached).toContain("+export const line2 = 'two';");
    expect(cached).not.toContain("thirty-five");
    const rest = g(fx.repo, ["diff", "--", "src/main.ts"]);
    expect(rest).toContain("+export const line35 = 'thirty-five';");
    expect(rest).not.toContain("line2 = 'two'");
    // unstage the same hunk and stage it again
    await a.mutate({ op: "stage.patch", patch: hunkPatch(f, f.hunks[0]!), reverse: true });
    expect(g(fx.repo, ["diff", "--cached", "--", "src/main.ts"])).toBe("");
    await a.mutate({ op: "stage.patch", patch: hunkPatch(f, f.hunks[0]!) });
    const before = g(fx.repo, ["rev-parse", "HEAD"]).trim();
    const c = await a.mutate({ op: "commit", message: "Stage one hunk\n\nBody line with 'quotes' and $HOME" });
    expect(c.invocations).toEqual(["git commit -F -"]);
    expect(g(fx.repo, ["log", "-1", "--format=%B"]).trim()).toBe("Stage one hunk\n\nBody line with 'quotes' and $HOME");
    expect(g(fx.repo, ["rev-parse", "HEAD^"]).trim()).toBe(before);
    expect(g(fx.repo, ["show", "--format=", "--name-only", "HEAD"]).trim().split("\n").sort()).toEqual(["README.md", "src/main.ts"]);
    expect(g(fx.repo, ["diff", "--", "src/main.ts"])).toContain("thirty-five");
    expect(c.refsVersion).toBe((await a.refsLite()).version);
  });

  it("discard hunk, stage/unstage/restore paths with tricky names", async () => {
    const d = await a.diff({ kind: "working", staged: false }, { path: "src/main.ts" });
    await a.mutate({ op: "discard.patch", patch: hunkPatch(d.files[0]!, d.files[0]!.hunks[0]!) });
    expect(g(fx.repo, ["diff", "--", "src/main.ts"])).toBe("");
    await a.mutate({ op: "stage", paths: ["-dash.txt", "notes with space.txt", "ünïcødé.txt"] });
    expect((await a.status()).staged.map((f) => f.path).sort()).toEqual(["-dash.txt", "notes with space.txt", "ünïcødé.txt"]);
    await a.mutate({ op: "unstage", paths: ["-dash.txt"] });
    const st = await a.status();
    expect(st.untracked).toEqual(["-dash.txt"]);
    writeFileSync(join(fx.repo, "README.md"), "changed\n");
    await a.mutate({ op: "restore", paths: ["README.md"] });
    expect(readFileSync(join(fx.repo, "README.md"), "utf8")).toContain("# Fixture");
    // a pathspec-magic-looking name is treated literally
    writeFileSync(join(fx.repo, ":(glob)*.txt"), "x\n");
    await a.mutate({ op: "stage", paths: [":(glob)*.txt"] });
    expect((await a.status()).staged.map((f) => f.path)).toContain(":(glob)*.txt");
    expect((await a.status()).untracked).toEqual(["-dash.txt"]);
    await a.mutate({ op: "commit", message: "Add tricky files" });
  });

  it("branches, tags, checkout, rename, upstream; preconditions give STALE_STATE", async () => {
    const head = g(fx.repo, ["rev-parse", "HEAD"]).trim();
    const { version } = await a.refsLite();
    await expectCode(a.mutate({ op: "branch.create", name: "x", target: "HEAD" }, { refsVersion: "0000000000000000" }), "STALE_STATE");
    await expectCode(a.mutate({ op: "branch.create", name: "x", target: "HEAD" }, { ref: { name: "main", commit: "0000000" } }), "STALE_STATE");
    await a.mutate({ op: "branch.create", name: "topic/one", target: "HEAD" }, { refsVersion: version, ref: { name: "refs/heads/main", commit: head } });
    expect(g(fx.repo, ["rev-parse", "topic/one"]).trim()).toBe(head);
    await a.mutate({ op: "branch.rename", from: "topic/one", to: "topic/two" });
    await a.mutate({ op: "tag.create", name: "v2.0", target: "topic/two", message: "Release 2.0\nwith body" });
    expect(g(fx.repo, ["cat-file", "-t", "v2.0"]).trim()).toBe("tag");
    expect(g(fx.repo, ["tag", "-l", "--format=%(contents)", "v2.0"]).trim()).toBe("Release 2.0\nwith body");
    await a.mutate({ op: "tag.delete", name: "v2.0" });
    await a.mutate({ op: "upstream.set", branch: "topic/two", upstream: "origin/main" });
    expect(g(fx.repo, ["rev-parse", "--abbrev-ref", "topic/two@{upstream}"]).trim()).toBe("origin/main");
    await a.mutate({ op: "upstream.set", branch: "topic/two", upstream: null });
    // atomic compare-and-delete with a full-hash precondition
    await expectCode(a.mutate({ op: "branch.delete", name: "topic/two", force: true }, { ref: { name: "topic/two", commit: "1".repeat(40) } }), "STALE_STATE");
    await a.mutate({ op: "branch.delete", name: "topic/two", force: true }, { ref: { name: "topic/two", commit: head } });
    expect(g(fx.repo, ["branch", "--list", "topic/two"]).trim()).toBe("");
    // git refuses to delete a branch checked out in another worktree
    await expectCode(a.mutate({ op: "branch.delete", name: "feature/auth", force: true }), "GIT_FAILED");
    // checkout with --track creates a local tracking branch
    await a.mutate({ op: "stash.push", message: "park", includeUntracked: true });
    await a.mutate({ op: "checkout", target: "origin/hotfix/urgent", track: true });
    expect(g(fx.repo, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe("hotfix/urgent");
    await a.mutate({ op: "checkout", target: "main" });
    await a.mutate({ op: "stash.pop", index: 0 });
    expect((await a.status()).untracked).toEqual(["-dash.txt"]);
  });

  it("push to the bare remote, then force-with-lease rejection when the remote moved", async () => {
    const local = g(fx.repo, ["rev-parse", "main"]).trim();
    const r = await a.mutate({ op: "push", remote: "origin", branch: "main" });
    expect(r.invocations).toEqual(["git push origin refs/heads/main:refs/heads/main"]);
    expect(g(fx.remote, ["rev-parse", "main"]).trim()).toBe(local);
    // Someone else pushes to the remote.
    const other = join(root, "other-clone");
    g(root, ["clone", "-q", fx.remote, other]);
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    g(other, ["add", "."]);
    g(other, ["commit", "-qm", "Their change"]);
    g(other, ["push", "-q", "origin", "main"]);
    const theirs = g(fx.remote, ["rev-parse", "main"]).trim();
    // We rewrite our main and force-push with a lease on what we last saw.
    await a.mutate({ op: "commit", message: "Amended locally", amend: true });
    const e = await expectCode(a.mutate({ op: "push", remote: "origin", branch: "main", forceWithLease: { expect: local } }), "STALE_STATE");
    expect(e.message).toMatch(/stale info/);
    expect(g(fx.remote, ["rev-parse", "main"]).trim()).toBe(theirs);
    // With the right expectation the lease holds.
    await a.mutate({ op: "push", remote: "origin", branch: "main", forceWithLease: { expect: theirs } });
    expect(g(fx.remote, ["rev-parse", "main"]).trim()).toBe(g(fx.repo, ["rev-parse", "main"]).trim());
    // fetch / pull / tag push / remote branch delete
    await a.mutate({ op: "fetch", remote: "origin", prune: true });
    await a.mutate({ op: "tag.push", name: "v1.0-lw", remote: "origin" });
    expect(g(fx.remote, ["rev-parse", "v1.0-lw"]).trim()).toBe(g(fx.repo, ["rev-parse", "v1.0-lw"]).trim());
    await a.mutate({ op: "branch.delete", name: "origin/hotfix/urgent", remote: true });
    expect(() => g(fx.remote, ["rev-parse", "--verify", "-q", "refs/heads/hotfix/urgent"])).toThrow();
  });

  it("merge conflict: status, conflict stages, resolve + continue; and the abort path", async () => {
    // A clean linked worktree on conflict-b.
    const wtPath = join(root, "conflict wt");
    await a.mutate({ op: "worktree.add", path: wtPath, branch: "conflict-b" });
    const w = await CliGitAdapter.open(wtPath, "cwt");
    const e = await expectCode(w.mutate({ op: "merge", ref: "conflict-a" }), "CONFLICT");
    expect(e.details?.conflicted).toEqual(["conflict.txt"]);
    const st = await w.status();
    expect(st.operation?.kind).toBe("merge");
    expect(st.conflicted).toEqual([{ path: "conflict.txt", status: "U" }]);
    const c = await w.conflict("conflict.txt");
    expect(c).toMatchObject({ base: "line 1\nshared line\nline 3\n", ours: "line 1\nchanged by B\nline 3\n", theirs: "line 1\nchanged by A\nline 3\n", binary: false });
    expect(c.working).toContain("<<<<<<<");
    await w.mutate({ op: "conflict.resolve", path: "conflict.txt", resolution: { content: "line 1\nchanged by A and B\nline 3\n" } });
    await w.mutate({ op: "operation.continue" });
    expect((await w.status()).operation).toBeNull();
    expect(g(wtPath, ["log", "-1", "--format=%P"]).trim().split(" ")).toHaveLength(2);
    expect(readFileSync(join(wtPath, "conflict.txt"), "utf8")).toBe("line 1\nchanged by A and B\nline 3\n");
    // abort path
    g(wtPath, ["reset", "-q", "--hard", "HEAD~1"]);
    await expectCode(w.mutate({ op: "merge", ref: "conflict-a" }), "CONFLICT");
    await w.mutate({ op: "operation.abort" });
    expect((await w.status()).operation).toBeNull();
    expect(existsSync(join(w.gitDir, "MERGE_HEAD"))).toBe(false);
    // ours/theirs resolution
    await expectCode(w.mutate({ op: "cherry-pick", hashes: [g(fx.repo, ["rev-parse", "conflict-a"]).trim()] }), "CONFLICT");
    expect((await w.status()).operation?.kind).toBe("cherry-pick");
    await w.mutate({ op: "conflict.resolve", path: "conflict.txt", resolution: "theirs" });
    await w.mutate({ op: "operation.continue" });
    expect(readFileSync(join(wtPath, "conflict.txt"), "utf8")).toBe("line 1\nchanged by A\nline 3\n");
  });

  it("interactive rebase with a supplied todo (drop + reword with message), paths with spaces", async () => {
    const wtPath = join(root, "rebase wt");
    await a.mutate({ op: "worktree.add", path: wtPath, newBranch: "rb", commitish: "feature/auth" });
    const w = await CliGitAdapter.open(wtPath, "rwt");
    const [logout, login] = g(wtPath, ["log", "--format=%H", "-2"]).trim().split("\n") as [string, string];
    const base = g(wtPath, ["merge-base", "HEAD", "release/1.0"]).trim();
    await w.mutate({
      op: "rebase",
      onto: base,
      todo: [
        { action: "reword", hash: login, message: "Login stub (reworded)\n\nwith a body" },
        { action: "drop", hash: logout },
      ],
    });
    expect(g(wtPath, ["log", "--format=%s", "-2"]).trim().split("\n")).toEqual(["Login stub (reworded)", "Add util module"]);
    expect(g(wtPath, ["log", "-1", "--format=%b"]).trim()).toBe("with a body");
    expect((await w.status()).operation).toBeNull();
    // edit stops and leaves the rebase in progress
    await w.mutate({ op: "rebase", onto: base, todo: [{ action: "edit", hash: g(wtPath, ["rev-parse", "HEAD"]).trim() }] });
    const op = (await w.status()).operation;
    expect(op).toMatchObject({ kind: "rebase", interactive: true });
    await w.mutate({ op: "operation.continue" });
    expect((await w.status()).operation).toBeNull();
  });

  it("worktree add/lock/unlock/remove/prune", async () => {
    const p = join(root, "wt lifecycle");
    await a.mutate({ op: "worktree.add", path: p, newBranch: "wt-life", commitish: "main" });
    await a.mutate({ op: "worktree.lock", path: p, reason: "on a usb drive" });
    let wt = (await a.worktrees()).find((x) => realpathSync(x.path) === realpathSync(p))!;
    expect(wt).toMatchObject({ locked: true, lockReason: "on a usb drive", branch: "refs/heads/wt-life" });
    await expectCode(a.mutate({ op: "worktree.remove", path: p }), "GIT_FAILED"); // locked
    await a.mutate({ op: "worktree.unlock", path: p });
    await a.mutate({ op: "worktree.remove", path: p });
    expect(existsSync(p)).toBe(false);
    // prune: remove a worktree directory behind git's back
    const q = join(root, "wt-prunable");
    await a.mutate({ op: "worktree.add", path: q, newBranch: "wt-prunable", commitish: "main" });
    rmSync(q, { recursive: true, force: true });
    wt = (await a.worktrees()).find((x) => x.path.endsWith("wt-prunable"))!;
    expect(wt.prunable).toBe(true);
    const dry = await a.mutate({ op: "worktree.prune", dryRun: true });
    expect(dry.affected).toEqual(["worktrees/wt-prunable"]);
    expect((await a.worktrees()).some((x) => x.path.endsWith("wt-prunable"))).toBe(true);
    await a.mutate({ op: "worktree.prune" });
    expect((await a.worktrees()).some((x) => x.path.endsWith("wt-prunable"))).toBe(false);
  });

  it("clean: dry run lists exactly; real run deletes only listed paths", async () => {
    writeFileSync(join(fx.repo, "junk one.tmp"), "x");
    writeFileSync(join(fx.repo, "keep.tmp"), "x");
    const dry = await a.mutate({ op: "clean", paths: ["junk one.tmp", "-dash.txt"], dryRun: true });
    expect(dry.affected?.sort()).toEqual(["-dash.txt", "junk one.tmp"]);
    expect(existsSync(join(fx.repo, "junk one.tmp"))).toBe(true);
    const real = await a.mutate({ op: "clean", paths: ["junk one.tmp", "-dash.txt"], dryRun: false });
    expect(real.affected?.sort()).toEqual(["-dash.txt", "junk one.tmp"]);
    expect(existsSync(join(fx.repo, "junk one.tmp"))).toBe(false);
    expect(existsSync(join(fx.repo, "-dash.txt"))).toBe(false);
    expect(existsSync(join(fx.repo, "keep.tmp"))).toBe(true);
  });

  it("stash push/apply/drop/branch, cherry-pick, revert, reset", async () => {
    writeFileSync(join(fx.repo, "src/util.ts"), "// edit for stash\n");
    await a.mutate({ op: "stash.push", message: "stash for test", paths: ["src/util.ts"] });
    const refs = await a.refs();
    expect(refs.refs.filter((r) => r.kind === "stash").map((r) => r.message)[0]).toBe("On main: stash for test");
    await a.mutate({ op: "stash.apply", index: 0 });
    g(fx.repo, ["checkout", "--", "src/util.ts"]);
    await a.mutate({ op: "stash.branch", index: 0, name: "from-stash" });
    expect(g(fx.repo, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe("from-stash");
    g(fx.repo, ["stash", "push", "-q", "-m", "tmp"]);
    await a.mutate({ op: "checkout", target: "main" });
    await a.mutate({ op: "stash.drop", index: 0 });
    const hot = g(fx.repo, ["rev-parse", "hotfix/urgent"]).trim();
    await a.mutate({ op: "cherry-pick", hashes: [hot], recordOrigin: true });
    expect(g(fx.repo, ["log", "-1", "--format=%B"])).toContain(`(cherry picked from commit ${hot})`);
    await a.mutate({ op: "revert", hash: g(fx.repo, ["rev-parse", "HEAD"]).trim() });
    expect(g(fx.repo, ["log", "-1", "--format=%s"]).trim()).toMatch(/^Revert "Urgent hotfix"/);
    const target = g(fx.repo, ["rev-parse", "HEAD~2"]).trim();
    await a.mutate({ op: "reset", target, mode: "soft" });
    expect(g(fx.repo, ["rev-parse", "HEAD"]).trim()).toBe(target);
    await a.mutate({ op: "reset", target: "HEAD", mode: "hard" });
  });

  it("remote add/rename/set-url/remove; git.run captures exit code; invalid args rejected", async () => {
    await a.mutate({ op: "remote.add", name: "mirror", url: fx.remote });
    await a.mutate({ op: "remote.rename", from: "mirror", to: "mirror2" });
    await a.mutate({ op: "remote.set-url", name: "mirror2", url: "https://example.com/x.git" });
    expect((await a.remotes()).find((r) => r.name === "mirror2")!.fetchUrl).toBe("https://example.com/x.git");
    await a.mutate({ op: "remote.remove", name: "mirror2" });
    await expectCode(a.mutate({ op: "remote.add", name: "evil", url: "--upload-pack=touch /tmp/pwned" }), "BAD_REQUEST");
    const ok = await a.mutate({ op: "git.run", args: ["rev-parse", "HEAD"] });
    expect(ok.exitCode).toBe(0);
    expect(ok.output.trim()).toBe(g(fx.repo, ["rev-parse", "HEAD"]).trim());
    const bad = await a.mutate({ op: "git.run", args: ["rev-parse", "--verify", "nope"] });
    expect(bad.exitCode).not.toBe(0);
  });

  it("destructive commands require the confirmation token through executeCommand", async () => {
    const local = new LocalRepos();
    const info = await local.open(fx.repo);
    const registry = createCompanionRegistry(local);
    const ctx = { resolver: local, appOrigin: "http://localhost:8787", actor: "api" as const };
    g(fx.repo, ["branch", "doomed", "HEAD"]);
    const first = await executeCommand(registry, ctx, { command: "git.branch.delete", args: { repo: info.key, name: "doomed" } });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(first.error.message).toMatch(/Delete branch "doomed" \(currently at [0-9a-f]{8}\)/);
    expect(g(fx.repo, ["branch", "--list", "doomed"]).trim()).toBe("doomed");
    const wrong = await executeCommand(registry, ctx, { command: "git.branch.delete", args: { repo: info.key, name: "doomed" }, confirm: "0000000000000000" });
    expect(wrong.ok).toBe(false);
    const token = (first.error.details as { confirmToken: string }).confirmToken;
    const second = await executeCommand(registry, ctx, { command: "git.branch.delete", args: { repo: info.key, name: "doomed" }, confirm: token });
    expect(second.ok).toBe(true);
    expect(g(fx.repo, ["branch", "--list", "doomed"]).trim()).toBe("");
    // non-destructive invocations need no token
    const safe = await executeCommand(registry, ctx, { command: "git.restore", args: { repo: info.key, paths: ["README.md"], staged: true, worktree: false } });
    expect(safe.ok).toBe(true);
  });

  it("local.init and local.clone register repositories", async () => {
    const local = new LocalRepos();
    const registry = createCompanionRegistry(local);
    const ctx = { resolver: local, appOrigin: "http://localhost:8787" };
    const init = await executeCommand(registry, ctx, { command: "local.init", args: { path: join(root, "fresh repo") } });
    expect(init.ok).toBe(true);
    const clone = await executeCommand(registry, ctx, { command: "local.clone", args: { url: fx.remote, path: join(root, "cloned") } });
    expect(clone.ok, JSON.stringify(clone)).toBe(true);
    const keys = (await local.list()).map((r) => r.name);
    expect(keys).toEqual(expect.arrayContaining(["fresh repo", "cloned"]));
    // empty repository: history is empty, refs have an unborn HEAD
    const fresh = await local.resolve((init as { result: { key: string } }).result.key);
    expect((await fresh.refs()).head.kind).toBe("unborn");
    expect((await fresh.history(DEFAULT_HISTORY_QUERY, null, 10)).commits).toEqual([]);
  });
});
