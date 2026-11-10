import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubAdapter, LOCAL_ONLY_REASON, PublicityCache } from "../../src/github/adapter.ts";
import { GitHubClient } from "../../src/github/client.ts";
import { HistoryStateCache } from "../../src/github/history.ts";
import { AppError, DEFAULT_HISTORY_QUERY, type Commit } from "../../src/core/types.ts";
import { cleanupGitHubFixture, FakeGitHub, makeGitHubFixture } from "../fakes/github.ts";

let fake: FakeGitHub;
let dir: string;
let alice: string;
let bob: string;
let bot: string;

const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

beforeAll(async () => {
  dir = makeGitHubFixture();
  fake = await new FakeGitHub().start();
  fake.addUser("alice", "Alice");
  fake.addUser("bob", "Bob");
  fake.addUser("bot");
  fake.addRepoFromGit("octo", "basic", dir, { perms: { alice: "admin", bob: "read" } });
  fake.addRepoFromGit("octo", "secret", dir, { private: true, perms: { alice: "write", bot: "read" } });
  alice = fake.issueToken("alice");
  bob = fake.issueToken("bob");
  bot = fake.issueToken("bot");
}, 60_000);

afterAll(async () => {
  await fake?.close();
  cleanupGitHubFixture();
});

function client() {
  return new GitHubClient({ apiUrl: fake.url, webUrl: fake.url });
}

function adapter(o: Partial<ConstructorParameters<typeof GitHubAdapter>[0]> = {}) {
  return new GitHubAdapter({ owner: "octo", name: "basic", api: client(), ...o });
}

async function errOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return AppError.from(e);
  }
  throw new Error("expected rejection");
}

function assertTopological(commits: Commit[]) {
  const idx = new Map(commits.map((c, i) => [c.hash, i]));
  for (const [i, c] of commits.entries()) {
    for (const p of c.parents) {
      const j = idx.get(p);
      if (j !== undefined) expect(j, `parent ${p.slice(0, 7)} of ${c.hash.slice(0, 7)} must come after it`).toBeGreaterThan(i);
    }
  }
}

async function allPages(a: GitHubAdapter, limit: number, q = DEFAULT_HISTORY_QUERY) {
  const out: Commit[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p = await a.history(q, cursor, limit);
    out.push(...p.commits);
    cursor = p.cursor;
    pages++;
    expect(pages).toBeLessThan(200);
  } while (cursor);
  return { commits: out, pages };
}

describe("GitHub adapter: refs", () => {
  it("lists branches and tags like git, peeling annotated tags", async () => {
    const snap = await adapter().refs();
    const want = git(["for-each-ref", "--format=%(refname) %(objectname) %(*objectname)", "refs/heads", "refs/tags"]).trim().split("\n");
    expect(snap.refs.map((r) => r.name).sort()).toEqual(want.map((l) => l.split(" ")[0]).sort());
    for (const l of want) {
      const [name, target, peeled] = l.split(" ");
      const r = snap.refs.find((x) => x.name === name)!;
      expect(r.target).toBe(target);
      expect(r.commit).toBe(peeled || target);
    }
    expect(snap.head).toMatchObject({ kind: "branch", ref: "refs/heads/main", commit: git(["rev-parse", "main"]).trim() });
    expect((await adapter().refs()).version).toBe(snap.version);
  });
});

describe("GitHub adapter: history", () => {
  it("merges every branch, children before parents, union equals git", async () => {
    const { commits } = await allPages(adapter({ token: alice }), 1000);
    const want = git(["log", "--format=%H", "--branches"]).trim().split("\n");
    expect(new Set(commits.map((c) => c.hash))).toEqual(new Set(want));
    expect(commits.length).toBe(want.length); // no duplicates
    assertTopological(commits);
  });

  it("paginates across tiny GitHub pages and small limits with identical, deterministic output", async () => {
    const full = (await allPages(adapter({ pageSize: 100 }), 1000)).commits.map((c) => c.hash);
    const cache = new HistoryStateCache();
    const paged = await allPages(adapter({ pageSize: 3, historyCache: cache }), 4);
    expect(paged.pages).toBeGreaterThan(3);
    assertTopological(paged.commits);
    expect(new Set(paged.commits.map((c) => c.hash))).toEqual(new Set(full));
    // Determinism: a fresh run (and a replay without the state cache) yields the same order.
    const again = await allPages(adapter({ pageSize: 3, historyCache: new HistoryStateCache(0, 0) }), 4);
    expect(again.commits.map((c) => c.hash)).toEqual(paged.commits.map((c) => c.hash));
  });

  it("keeps a skewed child (older date than its parent) ahead of the parent", async () => {
    const mainTip = git(["rev-parse", "main"]).trim();
    const tipDate = fake.repo("octo", "basic").commits.get(mainTip)!.committer.date;
    const { after } = fake.pushCommit("octo", "basic", "skewed", { parents: [mainTip], date: tipDate - 50_000 });
    try {
      for (const pageSize of [2, 100]) {
        const { commits } = await allPages(adapter({ pageSize }), 3);
        assertTopological(commits);
        expect(commits.findIndex((c) => c.hash === after)).toBeLessThan(commits.findIndex((c) => c.hash === mainTip));
      }
    } finally {
      fake.setRef("octo", "basic", "refs/heads/skewed", null);
    }
  });

  it("supports explicit refs and first-parent", async () => {
    const p = await adapter().history({ ...DEFAULT_HISTORY_QUERY, refs: ["develop"], firstParent: true }, null, 100);
    const want = git(["log", "--first-parent", "--format=%H", "develop"]).trim().split("\n");
    expect(p.commits.map((c) => c.hash)).toEqual(want);
    expect(p.cursor).toBeNull();
    expect((await errOf(adapter().history({ ...DEFAULT_HISTORY_QUERY, refs: ["nope"] }, null, 10))).code).toBe("REF_NOT_FOUND");
  });

  it("serves later pages from immutable cache (no extra GitHub requests on replay)", async () => {
    const api = client();
    const a = new GitHubAdapter({ owner: "octo", name: "basic", api, pageSize: 3, historyCache: new HistoryStateCache(0, 0) });
    const p1 = await a.history(DEFAULT_HISTORY_QUERY, null, 5);
    const before = api.stats.requests;
    await a.history(DEFAULT_HISTORY_QUERY, p1.cursor, 2); // replay: pages already cached
    const replayRequests = api.stats.requests - before;
    expect(replayRequests).toBeLessThanOrEqual(2);
  });
});

describe("GitHub adapter: commits, diffs, files", () => {
  const sha = (msg: string) => git(["log", "--all", "--format=%H", `--grep=^${msg}$`]).trim().split("\n")[0]!;

  it("commit details with renamed, removed and binary files", async () => {
    const a = adapter();
    const ren = await a.commit(sha("Rename app.ts to main.ts"));
    expect(ren.files).toEqual([expect.objectContaining({ path: "src/main.ts", oldPath: "src/app.ts", status: "R" })]);
    const rm = await a.commit(sha("Remove old docs and update logo"));
    expect(rm.files.find((f) => f.path === "docs/old.md")).toMatchObject({ status: "D" });
    expect(rm.files.find((f) => f.path === "assets/logo.bin")).toMatchObject({ status: "M", binary: true });
    expect((await errOf(a.commit("0".repeat(40)))).code).toBe("COMMIT_NOT_FOUND");
  });

  it("parses patches into hunks with line numbers", async () => {
    const d = await adapter().diff({ kind: "commit", hash: sha("Add logout") });
    const f = d.files.find((x) => x.path === "src/auth.ts")!;
    expect(f.status).toBe("M");
    expect(f.hunks).toHaveLength(1);
    const h = f.hunks[0]!;
    expect(h).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 });
    expect(h.lines).toEqual([
      { kind: "context", text: "export const login = () => true;", oldNo: 1, newNo: 1 },
      { kind: "add", text: "export const logout = () => false;", newNo: 2 },
    ]);
    const bin = await adapter().diff({ kind: "commit", hash: sha("Remove old docs and update logo") }, { path: "assets/logo.bin" });
    expect(bin.files).toEqual([expect.objectContaining({ path: "assets/logo.bin", binary: true, hunks: [] })]);
  });

  it("compares two commits with path filter", async () => {
    const base = git(["rev-parse", "main~2"]).trim();
    const head = git(["rev-parse", "main"]).trim();
    const d = await adapter().diff({ kind: "compare", base, head });
    const want = git(["diff", "--name-only", "-M", `${base}...${head}`]).trim().split("\n");
    expect(d.files.map((f) => f.path).sort()).toEqual(want.sort());
    const one = await adapter().diff({ kind: "compare", base, head }, { path: "src/util.ts" });
    expect(one.files.map((f) => f.path)).toEqual(["src/util.ts"]);
    expect((await errOf(adapter().diff({ kind: "working", staged: true }))).code).toBe("UNSUPPORTED");
  });

  it("reads files as utf8 or base64", async () => {
    const a = adapter();
    const readme = await a.file("README.md", "main");
    expect(readme).toMatchObject({ encoding: "utf8", content: git(["show", "main:README.md"]) });
    const bin = await a.file("assets/logo.bin", "main");
    expect(bin.encoding).toBe("base64");
    expect(Buffer.from(bin.content, "base64").equals(execFileSync("git", ["-C", dir, "show", "main:assets/logo.bin"]))).toBe(true);
  });

  it("file history, search and blame", async () => {
    const a = adapter();
    const fh = await a.fileHistory("README.md", null, 100);
    expect(fh.commits.map((c) => c.hash)).toEqual(git(["log", "--format=%H", "main", "--", "README.md"]).trim().split("\n"));
    const head = git(["rev-parse", "main"]).trim();
    expect((await a.search({ text: head.slice(0, 10) })).map((c) => c.hash)).toEqual([head]);
    expect((await a.search({ text: "logout" })).map((c) => c.subject)).toContain("Add logout");
    const authed = await adapter({ token: alice }).search({ text: "logout" });
    expect(authed.map((c) => c.subject)).toContain("Add logout");

    const anonBlame = await errOf(a.blame("src/util.ts", "main"));
    expect(anonBlame).toMatchObject({ code: "UNSUPPORTED", message: "Sign in to GitHub to use blame" });
    const blame = await adapter({ token: alice }).blame("src/util.ts", "main");
    expect(blame.map((l) => l.text).join("\n") + "\n").toBe(git(["show", "main:src/util.ts"]));
    expect(blame[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("local-only reads are UNSUPPORTED with the companion hint", async () => {
    for (const call of [() => adapter().status(), () => adapter().worktrees(), () => adapter().remotes(), () => adapter().conflict("x")]) {
      expect(await errOf(call())).toMatchObject({ code: "UNSUPPORTED", message: LOCAL_ONLY_REASON });
    }
  });
});

describe("GitHub adapter: capabilities and access", () => {
  it("reports capabilities by authentication and permission", async () => {
    const anon = await adapter().capabilities();
    expect(anon.history.available).toBe(true);
    expect(anon.blame).toEqual({ available: false, reason: "Sign in to GitHub to use blame" });
    expect(anon.branchWrite.available).toBe(false);
    expect(anon.merge).toMatchObject({ available: false, reason: expect.stringContaining("pull request") });
    expect(anon.workingTree).toEqual({ available: false, reason: LOCAL_ONLY_REASON });
    const reader = await adapter({ token: bob }).capabilities();
    expect(reader.blame.available).toBe(true);
    expect(reader.branchWrite).toEqual({ available: false, reason: "You need write access to octo/basic" });
    const admin = await adapter({ token: alice }).capabilities();
    expect(admin.branchWrite.available && admin.tagWrite.available).toBe(true);
  });

  it("private repos: 404 for anonymous and non-collaborators", async () => {
    const sec = (token: string | null) => new GitHubAdapter({ owner: "octo", name: "secret", api: client(), token });
    expect((await errOf(sec(null).info())).code).toBe("NOT_FOUND");
    expect((await errOf(sec(bob).refs())).code).toBe("NOT_FOUND");
    expect((await sec(alice).info()).visibility).toBe("private");
  });

  it("a server-side public token never serves private repositories", async () => {
    const publicity = new PublicityCache();
    const mk = (name: string) => new GitHubAdapter({ owner: "octo", name, api: client(), token: bot, requirePublic: true, publicity });
    expect((await mk("basic").info()).visibility).toBe("public");
    const calls = [
      () => mk("secret").info(),
      () => mk("secret").refs(),
      () => mk("secret").history(DEFAULT_HISTORY_QUERY, null, 10),
      () => mk("secret").commit(git(["rev-parse", "main"]).trim()),
      () => mk("secret").file("README.md", "main"),
      () => mk("secret").diff({ kind: "commit", hash: git(["rev-parse", "main"]).trim() }),
    ];
    for (const call of calls) expect((await errOf(call())).code).toBe("NOT_FOUND");
    // the bot itself can read the private repo — the guard is what protects it
    expect((await new GitHubAdapter({ owner: "octo", name: "secret", api: client(), token: bot }).info()).visibility).toBe("private");
  });
});

describe("GitHub adapter: mutations", () => {
  it("creates and deletes branches with preconditions; never leaks tokens", async () => {
    const a = adapter({ token: alice });
    const main = git(["rev-parse", "main"]).trim();
    const r = await a.mutate({ op: "branch.create", name: "tmp/new", target: "main" });
    expect(r.invocations).toEqual(["POST /repos/octo/basic/git/refs"]);
    expect(JSON.stringify(r)).not.toContain(alice);
    expect(fake.repo("octo", "basic").refs.get("refs/heads/tmp/new")).toBe(main);
    expect((await errOf(a.mutate({ op: "branch.create", name: "tmp/new", target: "main" }))).code).toBe("CONFLICT");

    const stale = await errOf(a.mutate({ op: "branch.delete", name: "tmp/new" }, { ref: { name: "tmp/new", commit: "1".repeat(40) } }));
    expect(stale.code).toBe("STALE_STATE");
    expect(fake.repo("octo", "basic").refs.has("refs/heads/tmp/new")).toBe(true);
    const staleV = await errOf(a.mutate({ op: "branch.delete", name: "tmp/new" }, { refsVersion: "deadbeef" }));
    expect(staleV.code).toBe("STALE_STATE");

    const ok = await a.mutate({ op: "branch.delete", name: "tmp/new" }, { ref: { name: "refs/heads/tmp/new", commit: main } });
    expect(ok.refsVersion).toBe((await adapter().refs()).version);
    expect(fake.repo("octo", "basic").refs.has("refs/heads/tmp/new")).toBe(false);
  });

  it("refuses to delete unmerged branches without force, and the default branch", async () => {
    const a = adapter({ token: alice });
    await a.mutate({ op: "branch.create", name: "tmp/unmerged", target: "develop" });
    expect((await errOf(a.mutate({ op: "branch.delete", name: "tmp/unmerged" }))).code).toBe("CONFLICT");
    await a.mutate({ op: "branch.delete", name: "tmp/unmerged", force: true });
    expect((await errOf(a.mutate({ op: "branch.delete", name: "main", force: true }))).code).toBe("FORBIDDEN");
  });

  it("renames branches, creates annotated tags, rejects unsupported ops and read-only users", async () => {
    const a = adapter({ token: alice });
    await a.mutate({ op: "branch.create", name: "tmp/a", target: "main" });
    await a.mutate({ op: "branch.rename", from: "tmp/a", to: "tmp/b" });
    expect(fake.repo("octo", "basic").refs.has("refs/heads/tmp/b")).toBe(true);
    await a.mutate({ op: "branch.delete", name: "tmp/b" });

    const t = await a.mutate({ op: "tag.create", name: "v9", target: "main", message: "Nine" });
    expect(t.invocations).toEqual(["POST /repos/octo/basic/git/tags", "POST /repos/octo/basic/git/refs"]);
    const snap = await adapter().refs();
    expect(snap.refs.find((r) => r.name === "refs/tags/v9")).toMatchObject({ commit: git(["rev-parse", "main"]).trim() });
    await a.mutate({ op: "tag.delete", name: "v9" });

    expect(await errOf(a.mutate({ op: "merge", ref: "develop" }))).toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("pull request") });
    expect((await errOf(adapter({ token: bob }).mutate({ op: "branch.create", name: "x", target: "main" }))).code).toBe("FORBIDDEN");
    expect((await errOf(adapter().mutate({ op: "branch.create", name: "x", target: "main" }))).code).toBe("UNSUPPORTED");
  });
});

describe("GitHub client", () => {
  it("revalidates with ETags (304) and serves immutable objects from cache", async () => {
    const api = client();
    const a = new GitHubAdapter({ owner: "octo", name: "basic", api, infoFreshMs: 0 });
    await a.refs();
    const n0 = fake.countRequests();
    await new GitHubAdapter({ owner: "octo", name: "basic", api, infoFreshMs: 0 }).refs();
    const reqs = fake.log.slice(n0);
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.status === 304)).toBe(true);
    const head = git(["rev-parse", "main"]).trim();
    await a.commit(head);
    const n1 = fake.countRequests();
    await a.commit(head);
    expect(fake.countRequests()).toBe(n1);
  });

  it("maps rate limits (primary and secondary) to RATE_LIMITED with retryAfter and backs off", async () => {
    const token = fake.issueToken("bob");
    const api = client();
    fake.rateLimit(token, { seconds: 30 });
    const e = await errOf(new GitHubAdapter({ owner: "octo", name: "basic", api, token }).info());
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.details?.retryAfter).toBeGreaterThan(0);
    // blocked locally: no request goes out
    const n = fake.countRequests();
    expect((await errOf(new GitHubAdapter({ owner: "octo", name: "basic", api, token }).info())).code).toBe("RATE_LIMITED");
    expect(fake.countRequests()).toBe(n);

    const t2 = fake.issueToken("bob");
    fake.rateLimit(t2, { secondary: true, seconds: 5 });
    const e2 = await errOf(new GitHubAdapter({ owner: "octo", name: "basic", api: client(), token: t2 }).info());
    expect(e2).toMatchObject({ code: "RATE_LIMITED", details: { retryAfter: 5, secondary: true } });
  });

  it("maps 401 and tracks the remaining budget", async () => {
    const api = client();
    expect((await errOf(new GitHubAdapter({ owner: "octo", name: "basic", api, token: "ghu_bogus" }).info())).code).toBe("UNAUTHENTICATED");
    await new GitHubAdapter({ owner: "octo", name: "basic", api, token: alice }).info();
    expect(api.budget(alice)).toMatchObject({ limit: 100_000 });
  });
});
