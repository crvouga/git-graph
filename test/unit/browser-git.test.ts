// Compares the browser Git reader against real git on generated fixtures (loose + fully packed).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, DEFAULT_HISTORY_QUERY, type HistoryQuery } from "../../src/core/types.ts";
import { BrowserGitRepository } from "../../src/browser-git/repo.ts";
import { ObjectDatabase } from "../../src/browser-git/objects.ts";
import { fixtureEnv, makeBasic, makePacked, ROOT } from "../fixtures/make-fixtures.ts";
import { NodeDirSource } from "./browser-git-node-source.ts";

let tmp: string;
let basic: string;
let packed: string;
let bare: string;
let worktree: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: fixtureEnv(), maxBuffer: 1 << 28 });
}
function gitBuf(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, env: fixtureEnv(), maxBuffer: 1 << 28 });
}
const lines = (s: string) => s.split("\n").filter(Boolean);

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  if (!existsSync(join(ROOT, ".gitconfig"))) {
    writeFileSync(join(ROOT, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n");
  }
  tmp = mkdtempSync(join(tmpdir(), "lanes-browser-git-"));
  const b = makeBasic(tmp);
  basic = b.repo;
  bare = b.remote;
  worktree = b.worktreeFeature;
  packed = makePacked(tmp);
}, 120_000);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const open = (dir: string, opts = {}) => BrowserGitRepository.open(new NodeDirSource(dir), "test", opts);

async function allHistory(repo: BrowserGitRepository, q: Partial<HistoryQuery>, pageSize = 1000): Promise<string[]> {
  const query = { ...DEFAULT_HISTORY_QUERY, ...q };
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await repo.history(query, cursor, pageSize);
    out.push(...page.commits.map((c) => c.hash));
    cursor = page.cursor;
  } while (cursor);
  return out;
}

describe.each(["loose", "packed"] as const)("%s repository", (kind) => {
  const dir = () => (kind === "loose" ? basic : packed);

  it("reads refs like git for-each-ref (packed-refs, annotated tag peeling, symrefs)", async () => {
    const repo = await open(dir());
    const snap = await repo.refs();
    const gitRefs = lines(git(dir(), ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(*objectname)%09%(symref)", "refs/heads", "refs/remotes", "refs/tags"])).map((l) => l.split("\t"));
    const ours = snap.refs.filter((r) => r.kind !== "stash");
    expect(ours.map((r) => r.name)).toEqual(gitRefs.map((r) => r[0]));
    for (const [name, obj, peeled, symref] of gitRefs) {
      const r = ours.find((x) => x.name === name)!;
      expect(r.target, name).toBe(obj);
      expect(r.commit, name).toBe(peeled || obj);
      if (symref) expect(r.symbolicTarget).toBe(symref);
    }
    const tag = ours.find((r) => r.name === "refs/tags/v1.0")!;
    expect(tag.target).not.toBe(tag.commit);
    expect(tag.message).toBe("Release 1.0");
    expect(snap.head).toEqual({ kind: "branch", ref: git(dir(), ["symbolic-ref", "HEAD"]).trim(), commit: git(dir(), ["rev-parse", "HEAD"]).trim() });
    const main = ours.find((r) => r.name === "refs/heads/main")!;
    if (kind === "loose") {
      expect(main.upstream).toBe("refs/remotes/origin/main");
      expect(ours.find((r) => r.name === "refs/heads/feature/auth")!.checkedOutAt).toBe(realpathSync(worktree));
    }
    expect(ours.find((r) => r.name === "refs/remotes/origin/main")!.remote).toBe("origin");
    // Stashes
    const stashes = snap.refs.filter((r) => r.kind === "stash");
    if (kind === "loose") {
      const gitStash = lines(git(dir(), ["stash", "list", "--format=%gd%x09%H%x09%gs"])).map((l) => l.split("\t"));
      expect(stashes.map((s) => [s.short, s.target, s.message])).toEqual(gitStash);
    } else {
      // A mirror clone has refs/stash but no reflog: we still show stash@{0}.
      expect(stashes.map((s) => [s.short, s.target])).toEqual([["stash@{0}", git(dir(), ["rev-parse", "refs/stash"]).trim()]]);
    }
    // Version is deterministic and changes with refs.
    const again = await (await open(dir())).refs();
    expect(again.version).toBe(snap.version);
  });

  const cases: [string, Partial<HistoryQuery>, string[]][] = [
    ["--all", {}, ["--date-order", "--all"]],
    ["--branches HEAD", { includeRemotes: false, includeTags: false, includeStashes: false }, ["--date-order", "--branches", "HEAD"]],
    ["single ref", { refs: ["develop"] }, ["--date-order", "develop"]],
    ["several refs", { refs: ["origin/hotfix/urgent", "v1.0", "refs/heads/gh-pages"] }, ["--date-order", "origin/hotfix/urgent", "v1.0", "refs/heads/gh-pages"]],
    ["--first-parent", { firstParent: true }, ["--date-order", "--first-parent", "--all"]],
    ["--topo-order", { order: "topo" }, ["--topo-order", "--all"]],
    ["--author-date-order", { order: "author-date" }, ["--author-date-order", "--all"]],
  ];
  it.each(cases)("history order matches git log %s", async (_n, q, args) => {
    const repo = await open(dir());
    const expected = lines(git(dir(), ["log", ...args, "--format=%H"]));
    expect(await allHistory(repo, q)).toEqual(expected);
    // Paging with small pages yields the same sequence.
    expect(await allHistory(repo, q, 3)).toEqual(expected);
  });

  it("first-parent pages only expose first parents; total and cursor are consistent", async () => {
    const repo = await open(dir());
    const page = await repo.history({ ...DEFAULT_HISTORY_QUERY, firstParent: true }, null, 100);
    expect(page.cursor).toBeNull();
    expect(page.total).toBe(page.commits.length);
    for (const c of page.commits) expect(c.parents.length).toBeLessThanOrEqual(1);
    const p1 = await repo.history(DEFAULT_HISTORY_QUERY, null, 4);
    expect(p1.commits).toHaveLength(4);
    expect(p1.cursor).toMatch(/:4$/);
    expect(p1.refsVersion).toBe((await repo.refs()).version);
  });

  it("parses commits like git show", async () => {
    const repo = await open(dir());
    const SEP = "\x1f";
    const recs = git(dir(), ["log", "--all", `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%cn${SEP}%ce${SEP}%ct${SEP}%s${SEP}%b%x1e`])
      .split("\x1e")
      .map((r) => r.replace(/^\n/, ""))
      .filter(Boolean);
    expect(recs.length).toBeGreaterThan(10);
    for (const rec of recs) {
      const [hash, parents, an, ae, at, cn, ce, ct, s, b] = rec.split(SEP);
      const c = await repo.commit(hash!);
      expect(c.hash).toBe(hash);
      expect(c.parents).toEqual(parents ? parents.split(" ") : []);
      expect(c.author).toEqual({ name: an, email: ae, date: Number(at) });
      expect(c.committer).toEqual({ name: cn, email: ce, date: Number(ct) });
      expect(c.subject).toBe(s);
      expect(c.body).toBe(b!.trim());
    }
    // Abbreviated hashes and ref names resolve.
    const head = git(dir(), ["rev-parse", "HEAD"]).trim();
    expect((await repo.commit(head.slice(0, 7))).hash).toBe(head);
    expect((await repo.commit("main~1")).hash).toBe(git(dir(), ["rev-parse", "main~1"]).trim());
    await expect(repo.commit("does-not-exist")).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
  });

  it("changed files match git diff-tree -r -M (name-status and numstat)", async () => {
    const repo = await open(dir());
    const all = lines(git(dir(), ["log", "--all", "--format=%H %P"])).map((l) => l.split(" "));
    let sawRename = false;
    let sawDelete = false;
    let sawBinary = false;
    for (const [hash, p1] of all) {
      const range = p1 ? [p1, hash!] : ["--root", hash!];
      const ns = git(dir(), ["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--name-status", ...range]).split("\0").filter((x, i, a) => i < a.length - 1);
      const expected: { status: string; path: string; oldPath?: string }[] = [];
      for (let i = 0; i < ns.length; ) {
        const st = ns[i++]!;
        if (st.startsWith("R")) {
          const oldPath = ns[i++]!;
          expected.push({ status: "R", oldPath, path: ns[i++]! });
        } else expected.push({ status: st, path: ns[i++]! });
      }
      const nums = git(dir(), ["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--numstat", ...range]).split("\0");
      const counts: (string[] | null)[] = [];
      for (let i = 0; i < nums.length - 1; ) {
        const parts = nums[i++]!.split("\t");
        if (parts[2] === "") i += 2; // rename: paths follow
        counts.push(parts);
      }
      const c = await repo.commit(hash!);
      expect(c.files.map((f) => ({ status: f.status, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}) })), hash).toEqual(expected);
      c.files.forEach((f, i) => {
        const [a, d] = counts[i]!;
        if (a === "-") expect(f.binary, f.path).toBe(true);
        else expect([f.additions, f.deletions], `${hash} ${f.path}`).toEqual([Number(a), Number(d)]);
        if (f.status === "R") sawRename = true;
        if (f.status === "D") sawDelete = true;
        if (f.binary) sawBinary = true;
      });
    }
    expect(sawRename && sawDelete && sawBinary).toBe(true);
  });

  it("diff hunks match git diff for every commit", async () => {
    const repo = await open(dir());
    const all = lines(git(dir(), ["log", "--all", "--format=%H %P"])).map((l) => l.split(" "));
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    for (const [hash, p1] of all) {
      const out = git(dir(), ["diff", "-M", "--no-color", "--no-ext-diff", p1 || EMPTY_TREE, hash!]);
      const files = out.split(/^diff --git /m).slice(1).map((sec) => {
        const binary = /^Binary files /m.test(sec);
        const hunks: { header: string; lines: string[] }[] = [];
        for (const line of sec.split("\n")) {
          if (line.startsWith("@@")) hunks.push({ header: line, lines: [] });
          else if (hunks.length && /^[ +\-\\]/.test(line)) hunks[hunks.length - 1]!.lines.push(line);
        }
        return { binary, hunks };
      });
      const d = await repo.diff({ kind: "commit", hash: hash! });
      expect(d.files.length, hash).toBe(files.length);
      d.files.forEach((f, i) => {
        const g = files[i]!;
        expect(f.binary, f.path).toBe(g.binary);
        const ours = f.hunks.map((h) => ({
          header: h.header,
          lines: h.lines.map((l) => (l.kind === "context" ? " " : l.kind === "add" ? "+" : l.kind === "del" ? "-" : "") + l.text),
        }));
        expect(ours, `${hash} ${f.path}`).toEqual(g.hunks);
        // Line numbers are consistent with the header.
        for (const h of f.hunks) {
          let o = h.oldLines ? h.oldStart : h.oldStart + 1;
          let n = h.newLines ? h.newStart : h.newStart + 1;
          for (const l of h.lines) {
            if (l.kind === "context") {
              expect([l.oldNo, l.newNo]).toEqual([o++, n++]);
            } else if (l.kind === "del") expect(l.oldNo).toBe(o++);
            else if (l.kind === "add") expect(l.newNo).toBe(n++);
          }
        }
      });
    }
  });

  it("compare diffs and path-filtered diffs", async () => {
    const repo = await open(dir());
    const d = await repo.diff({ kind: "compare", base: "release/1.0", head: "main" });
    const expected = git(dir(), ["diff", "-M", "--name-status", "release/1.0", "main"]);
    expect(d.files.map((f) => `${f.status}${f.oldPath ? "\t" + f.oldPath : ""}\t${f.path}`)).toEqual(lines(expected).map((l) => l.replace(/^R\d+/, "R")));
    const one = await repo.diff({ kind: "compare", base: "release/1.0", head: "main" }, { path: "src/util.ts" });
    expect(one.files.map((f) => f.path)).toEqual(["src/util.ts"]);
    const renamed = await repo.diff({ kind: "compare", base: "release/1.0", head: "main" }, { path: "src/app.ts" });
    expect(renamed.files.map((f) => [f.status, f.oldPath, f.path])).toEqual([["R", "src/app.ts", "src/main.ts"]]);
    await expect(repo.diff({ kind: "working", staged: false })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("fileHistory matches git log -- path (and follows exact renames)", async () => {
    const repo = await open(dir());
    for (const path of ["src/util.ts", "README.md", "conflict.txt", "index.html", "assets/logo.bin", "docs/old.md", "src"]) {
      const expected = lines(git(dir(), ["log", "--all", "--date-order", "--format=%H", "--", path]));
      const got: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await repo.fileHistory(path, cursor, 2);
        got.push(...page.commits.map((c) => c.hash));
        cursor = page.cursor;
      } while (cursor);
      expect(got, path).toEqual(expected);
    }
    const followed = (await repo.fileHistory("src/main.ts", null, 100)).commits.map((c) => c.hash);
    const viaGit = lines(git(dir(), ["log", "--follow", "--format=%H", "main", "--", "src/main.ts"]));
    for (const h of viaGit) expect(followed).toContain(h);
  });

  it("search by hash prefix, subject, author and ref", async () => {
    const repo = await open(dir());
    const head = git(dir(), ["rev-parse", "HEAD"]).trim();
    expect((await repo.search({ text: head.slice(0, 8) })).map((c) => c.hash)).toContain(head);
    expect((await repo.search({ text: "LOGOUT" })).map((c) => c.subject)).toEqual(["Add logout"]);
    const grace = await repo.search({ text: "grace@example.com", fields: ["author"] });
    expect(grace.length).toBe(lines(git(dir(), ["log", "--all", "--author=grace@example.com", "--format=%H"])).length);
    expect((await repo.search({ text: "hotfix/urgent", fields: ["ref"] })).map((c) => c.subject)).toEqual(["Urgent hotfix"]);
    expect(await repo.search({ text: "nothing-matches-this" })).toEqual([]);
  });

  it("reads files at a revision", async () => {
    const repo = await open(dir());
    const readme = await repo.file("README.md", "main");
    expect(readme).toEqual({ content: git(dir(), ["show", "main:README.md"]), encoding: "utf8", size: readme.content.length });
    const logo = await repo.file("assets/logo.bin", "main~2");
    expect(logo.encoding).toBe("base64");
    expect(Buffer.from(logo.content, "base64").equals(gitBuf(dir(), ["show", "main~2:assets/logo.bin"]))).toBe(true);
    await expect(repo.file("nope.txt", "main")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads every object exactly like git cat-file (whole-pack and ranged reads)", async () => {
    const raw = gitBuf(dir(), ["cat-file", "--batch-all-objects", "--batch"]);
    const objects: { hash: string; type: string; data: Buffer }[] = [];
    for (let i = 0; i < raw.length; ) {
      const nl = raw.indexOf(10, i);
      const [hash, type, size] = raw.subarray(i, nl).toString().split(" ");
      const start = nl + 1;
      objects.push({ hash: hash!, type: type!, data: raw.subarray(start, start + Number(size)) });
      i = start + Number(size) + 1;
    }
    expect(objects.length).toBeGreaterThan(40);
    for (const opts of [{}, { wholePackLimit: 0, windowBytes: 64 }, { cacheBytes: 0 }]) {
      const odb = new ObjectDatabase(new NodeDirSource(dir()), ".git/objects", opts);
      for (const o of objects) {
        const got = await odb.read(o.hash);
        expect(got?.type, o.hash).toBe(o.type);
        expect(Buffer.from(got!.data).equals(o.data), o.hash).toBe(true);
      }
      expect(await odb.read("0".repeat(40))).toBeNull();
    }
    if (kind === "packed") {
      // The aggressive gc fixture really exercises delta chains.
      const pack = readdirSync(join(dir(), ".git/objects/pack")).find((f) => f.endsWith(".idx"))!;
      const verify = git(dir(), ["verify-pack", "-v", join(".git/objects/pack", pack)]);
      const deltas = lines(verify).filter((l) => /^[0-9a-f]{40} \w+ \d+ \d+ \d+ \d+ [0-9a-f]{40}$/.test(l));
      expect(deltas.length).toBeGreaterThan(0);
    }
  });
});

describe("repository layouts and capabilities", () => {
  it("opens a bare repository", async () => {
    const repo = await open(bare);
    const snap = await repo.refs();
    expect(snap.refs.filter((r) => r.kind !== "stash").map((r) => r.name)).toEqual(lines(git(bare, ["for-each-ref", "--format=%(refname)"])));
    expect(await allHistory(repo, {})).toEqual(lines(git(bare, ["log", "--date-order", "--all", "--format=%H"])));
  });

  it("rejects a linked worktree whose git dir is outside the picked folder", async () => {
    const err = await open(worktree).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toMatch(/main repository folder/);
    expect(err.message).toMatch(/git-graph open \./);
  });

  it("follows a relative .git file inside the picked folder", async () => {
    const dir = join(tmp, "relative-gitdir");
    mkdirSync(dir, { recursive: true });
    git(tmp, ["clone", "-q", "--bare", basic, join(dir, "store.git")]);
    writeFileSync(join(dir, ".git"), "gitdir: store.git\n");
    const repo = await open(dir);
    expect((await repo.refs()).head).toMatchObject({ kind: "branch", ref: "refs/heads/main" });
    expect((await repo.history(DEFAULT_HISTORY_QUERY, null, 5)).commits).toHaveLength(5);
  });

  it("rejects SHA-256 repositories and non-repositories", async () => {
    const sha = join(tmp, "sha256");
    git(tmp, ["init", "-q", "--object-format=sha256", sha]);
    await expect(open(sha)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const empty = join(tmp, "not-a-repo");
    mkdirSync(empty, { recursive: true });
    await expect(open(empty)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("handles an unborn HEAD", async () => {
    const fresh = join(tmp, "fresh");
    git(tmp, ["init", "-q", fresh]);
    const repo = await open(fresh);
    const snap = await repo.refs();
    expect(snap.head).toEqual({ kind: "unborn", ref: "refs/heads/main" });
    const page = await repo.history(DEFAULT_HISTORY_QUERY, null, 10);
    expect(page.commits).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  it("reports read-only capabilities and rejects writes with the same reason", async () => {
    const repo = await open(basic);
    const caps = await repo.capabilities();
    for (const c of ["history", "refs", "commit", "diff", "compare", "search", "fileHistory"] as const) expect(caps[c]).toEqual({ available: true });
    expect(caps.stage).toEqual({ available: false, reason: expect.stringContaining("git-graph open .") });
    expect(caps.blame.available).toBe(false);
    const reason = (caps.push as { reason: string }).reason;
    await expect(repo.mutate({ op: "fetch" })).rejects.toMatchObject({ code: "UNSUPPORTED", message: reason });
    await expect(repo.status()).rejects.toMatchObject({ code: "UNSUPPORTED", message: reason });
    await expect(repo.blame("README.md", "HEAD")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(repo.key).toBe("browser:test");
    expect(typeof repo.subscribe(() => {})).toBe("function");
    expect((await repo.info()).defaultBranch).toBe("main");
  });

  it("resolves deep OFS_DELTA / REF_DELTA chains (aggressive gc and thin-pack style repacks)", async () => {
    const dir = join(tmp, "deltas");
    git(tmp, ["init", "-q", dir]);
    let text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(i % 40)}`).join("\n") + "\n";
    for (let i = 0; i < 60; i++) {
      const ls = text.split("\n");
      ls[(i * 37) % 300] = `edited ${i}`;
      text = ls.join("\n");
      writeFileSync(join(dir, "big.txt"), text);
      writeFileSync(join(dir, `small-${i % 3}.txt`), `v${i}\n`);
      git(dir, ["add", "-A"]);
      git(dir, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "-m", `c${i}`]);
    }
    git(dir, ["gc", "-q", "--aggressive", "--prune=now"]);
    const pack = readdirSync(join(dir, ".git/objects/pack")).find((f) => f.endsWith(".idx"))!;
    const verify = lines(git(dir, ["verify-pack", "-v", join(".git/objects/pack", pack)]));
    const maxDepth = Math.max(...verify.map((l) => /^chain length = (\d+)/.exec(l)?.[1]).filter(Boolean).map(Number));
    expect(maxDepth).toBeGreaterThan(10);
    // Also add a REF_DELTA pack (index-pack of a thin pack keeps ref deltas when told to).
    const raw = gitBuf(dir, ["cat-file", "--batch-all-objects", "--batch"]);
    const objects: { hash: string; type: string; data: Buffer }[] = [];
    for (let i = 0; i < raw.length; ) {
      const nl = raw.indexOf(10, i);
      const [hash, type, size] = raw.subarray(i, nl).toString().split(" ");
      objects.push({ hash: hash!, type: type!, data: raw.subarray(nl + 1, nl + 1 + Number(size)) });
      i = nl + 1 + Number(size) + 1;
    }
    for (const opts of [{}, { wholePackLimit: 0, windowBytes: 4096, cacheBytes: 32 * 1024 }]) {
      const odb = new ObjectDatabase(new NodeDirSource(dir), ".git/objects", opts);
      for (const o of objects) {
        const got = await odb.read(o.hash);
        expect(got?.type, o.hash).toBe(o.type);
        expect(Buffer.from(got!.data).equals(o.data), o.hash).toBe(true);
      }
    }
    // REF_DELTA: pack-objects without --delta-base-offset writes REF_DELTA entries.
    const refDir = join(tmp, "refdelta");
    git(tmp, ["init", "-q", "--bare", refDir]);
    const list = objects.map((o) => o.hash).join("\n") + "\n";
    const packOut = execFileSync("git", ["pack-objects", "-q", "--window=50", "--depth=50", join(refDir, "objects/pack/pack")], { cwd: dir, env: fixtureEnv(), input: list, encoding: "utf8" });
    expect(packOut.trim()).toMatch(/^[0-9a-f]{40}$/);
    const odb = new ObjectDatabase(new NodeDirSource(refDir), "objects", {});
    for (const o of objects) {
      const got = await odb.read(o.hash);
      expect(Buffer.from(got!.data).equals(o.data), o.hash).toBe(true);
    }
  });

  it("cancels history computation through AbortSignal", async () => {
    const repo = await open(packed);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(repo.history(DEFAULT_HISTORY_QUERY, null, 10, { signal: ctrl.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    // A later call still works.
    expect((await repo.history(DEFAULT_HISTORY_QUERY, null, 10)).commits.length).toBe(10);
  });

  it("notices new refs and new commits between calls", async () => {
    const dir = join(tmp, "live");
    git(tmp, ["clone", "-q", basic, dir]);
    const repo = await open(dir);
    const before = await repo.refs();
    git(dir, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "new commit"]);
    git(dir, ["gc", "-q"]);
    const after = await repo.refs();
    expect(after.version).not.toBe(before.version);
    const page = await repo.history(DEFAULT_HISTORY_QUERY, null, 1);
    expect(page.commits[0]!.subject).toBe("new commit");
    expect(page.refsVersion).toBe(after.version);
  });
});
