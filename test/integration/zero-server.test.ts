// The server side of Zero sync on the test PostgreSQL (PGlite): the GitHub agent publishing
// repositories, server mutators enforcing permissions, reads and queued operations.
// zero-cache itself is not started here (see zero-sync.test.ts for the full path).

import { mustGetMutator } from "@rocicorp/zero";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupGitHubFixture, type FakeGitHub } from "../fakes/github.ts";
import { CookieJar, startFake, startStack, type Stack } from "../fakes/server-harness.ts";
import { createServerMutators } from "../../src/server/zero/mutators.ts";
import { demandId, readId } from "../../src/zero/rows.ts";
import type { ZeroContext } from "../../src/zero/schema.ts";

let fake: FakeGitHub;
let s: Stack;
let mutators: ReturnType<typeof createServerMutators>;
let alice: string;
let bob: string;

const KEY = "github:octo:basic";
const SECRET = "github:octo:secret";

beforeAll(async () => {
  ({ fake } = await startFake());
  s = await startStack({
    fake,
    config: {
      // PGlite serves one connection at a time; concurrent pooled connections confuse its socket server.
      databasePoolMax: 1,
      log: (l: string, m: string, e?: unknown) => {
        if (process.env.ZDEBUG) console.log("LOG", l, m, JSON.stringify(e));
      },
      zero: { cacheUrl: "http://127.0.0.1:9", port: 0, upstreamDb: "", cvrDb: null, changeDb: null, appId: "lanes_zero", apiKey: "test-key", adminPassword: "x", replicaFile: "", logLevel: "warn", numSyncWorkers: null },
    },
  });
  mutators = createServerMutators({ t: s.server.db!.t, kick: () => s.server.githubAgent!.kick() });
  await s.login("alice");
  await s.signIn("bob-subject");
  const rows = await s.db.query<{ id: string; oidc_subject: string }>(`select id, oidc_subject from "${s.config.databaseSchema}".accounts`);
  alice = rows.find((r) => r.oidc_subject !== "bob-subject")!.id;
  bob = rows.find((r) => r.oidc_subject === "bob-subject")!.id;
}, 60_000);

afterAll(async () => {
  await s?.close();
  await fake?.close();
  cleanupGitHubFixture();
});

const ctx = (accountId: string | null, agentId: string | null = null): ZeroContext => ({ accountId, agentId });

async function mutate(name: string, args: unknown, c: ZeroContext): Promise<void> {
  await s.server.db!.sql.begin(async (tx) => {
    await mustGetMutator(mutators, name).fn({ args: args as never, tx: { location: "server", dbTransaction: { wrappedTransaction: tx } } as never, ctx: c });
  });
}

const q = <T>(sql: string, params: unknown[] = []) => s.db.query<T>(sql.replaceAll("$S", `"${s.config.databaseSchema}"`), params);

async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("GitHub agent", () => {
  it("publishes a public repository opened by a signed-out viewer", async () => {
    await mutate("repo.open", { repoId: KEY, depth: 500, now: Date.now() }, ctx(null));
    const repo = await until(async () => (await q<{ is_public: boolean; commit_count: number; history_complete: boolean; refs_version: string }>(`select * from $S.repos where id = $1`, [KEY]))[0]?.history_complete && (await q<{ is_public: boolean; commit_count: number; history_complete: boolean; refs_version: string }>(`select * from $S.repos where id = $1`, [KEY]))[0], "history");
    expect(repo.is_public).toBe(true);
    expect(repo.commit_count).toBe(14);
    expect(repo.refs_version).not.toBe("");
    const refs = await q<{ short: string }>(`select short from $S.refs where repo_id = $1`, [KEY]);
    expect(refs.map((r) => r.short)).toContain("main");
    const [d] = await q<{ state: string }>(`select state from $S.demands where id = $1`, [demandId(KEY, null)]);
    expect(d!.state).toBe("ok");
  });

  it("refuses a private repository to signed-out viewers and grants it to people with access", async () => {
    await mutate("repo.open", { repoId: SECRET, depth: 100, now: Date.now() }, ctx(null));
    const anon = await until(async () => (await q<{ state: string; error: { code: string } }>(`select state, error from $S.demands where id = $1`, [demandId(SECRET, null)]))[0]?.state === "error" && (await q<{ state: string; error: { code: string } }>(`select state, error from $S.demands where id = $1`, [demandId(SECRET, null)]))[0], "anonymous refusal");
    expect(anon.error.code).toBe("NOT_FOUND");

    await mutate("repo.open", { repoId: SECRET, depth: 100, now: Date.now() }, ctx(alice));
    await until(async () => (await q(`select 1 from $S.repo_access where repo_id = $1 and account_id = $2`, [SECRET, alice])).length > 0, "alice's access").catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await q(`select * from $S.demands`))}`); });
    const [repo] = await q<{ is_public: boolean }>(`select is_public from $S.repos where id = $1`, [SECRET]);
    expect(repo!.is_public).toBe(false);
  });

  it("serves reads and only to viewers who can see the repository", async () => {
    const [head] = await q<{ commit: string }>(`select commit from $S.refs where repo_id = $1 and short = 'main'`, [KEY]);
    await mutate("read.request", { repoId: KEY, method: "commit", params: [head!.commit], live: false, now: Date.now() }, ctx(null));
    const id = readId(KEY, "commit", [head!.commit]);
    const row = await until(async () => (await q<{ state: string; result: { hash: string; files: unknown[] } }>(`select state, result from $S.reads where id = $1`, [id]))[0]?.state === "ok" && (await q<{ state: string; result: { hash: string; files: unknown[] } }>(`select state, result from $S.reads where id = $1`, [id]))[0], "read");
    expect(row.result.hash).toBe(head!.commit);
    expect(row.result.files.length).toBeGreaterThan(0);
    await expect(mutate("read.request", { repoId: SECRET, method: "remotes", params: [], live: false, now: Date.now() }, ctx(bob))).rejects.toThrow(/not found/i);
  });

  it("runs queued operations with the requester's own token, with the confirmation round trip", async () => {
    const [head] = await q<{ commit: string }>(`select commit from $S.refs where repo_id = $1 and short = 'main'`, [KEY]);
    await mutate("op.enqueue", { id: "op-create-1", repoId: KEY, agentId: null, command: "git.branch.create", args: { name: "zero-made", target: head!.commit }, title: "Create branch", now: Date.now() }, ctx(alice));
    const op = await until(async () => {
      const [r] = await q<{ state: string; error: unknown }>(`select state, error from $S.operations where id = 'op-create-1'`);
      return r && (r.state === "ok" || r.state === "error") && r;
    }, "operation");
    expect(op.state, JSON.stringify(op.error)).toBe("ok");
    await until(async () => (await q(`select 1 from $S.refs where repo_id = $1 and short = 'zero-made'`, [KEY])).length > 0, "new ref published");

    await mutate("op.enqueue", { id: "op-delete-1", repoId: KEY, agentId: null, command: "git.branch.delete", args: { name: "zero-made", remote: false }, title: "Delete branch", now: Date.now() }, ctx(alice));
    const asked = await until(async () => {
      const [r] = await q<{ state: string; confirm_token: string | null; consequence: string | null }>(`select state, confirm_token, consequence from $S.operations where id = 'op-delete-1'`);
      return r && r.state !== "pending" && r.state !== "running" && r;
    }, "delete outcome");
    if (asked.state === "confirm") {
      expect(asked.consequence).toBeTruthy();
      await mutate("op.confirm", { id: "op-delete-1", token: asked.confirm_token!, now: Date.now() }, ctx(alice));
      await until(async () => (await q<{ state: string }>(`select state from $S.operations where id = 'op-delete-1'`))[0]?.state === "ok", "confirmed delete");
    } else expect(asked.state).toBe("ok");
    await until(async () => (await q(`select 1 from $S.refs where repo_id = $1 and short = 'zero-made'`, [KEY])).length === 0, "ref removed");
  });

  it("requires sign-in to queue operations", async () => {
    await expect(mutate("op.enqueue", { id: "op-anonymous", repoId: KEY, agentId: null, command: "git.branch.create", args: { name: "x", target: "HEAD" }, title: "x", now: Date.now() }, ctx(null))).rejects.toThrow(/sign in/i);
  });
});

describe("agent writes", () => {
  it("lets an owner publish a browser-folder repository and nobody else write to it", async () => {
    const repo = { agentId: "browser-aliceagent01", id: "browser:alicefolder", provider: "browser", name: "folder", info: { name: "folder" }, caps: {}, now: Date.now() };
    await mutate("agent.repo", repo, ctx(alice));
    const [row] = await q<{ owner_account_id: string; is_public: boolean }>(`select owner_account_id, is_public from $S.repos where id = 'browser:alicefolder'`);
    expect(row).toMatchObject({ owner_account_id: alice, is_public: false });
    await expect(mutate("agent.repo", { ...repo, agentId: "browser-bobagent0001" }, ctx(bob))).rejects.toThrow();
    await expect(mutate("agent.refs", { repoId: "browser:alicefolder", head: { kind: "none" }, version: "x", refs: [] }, ctx(bob))).rejects.toThrow(/not your/i);
    await expect(mutate("agent.refs", { repoId: KEY, head: { kind: "none" }, version: "x", refs: [] }, ctx(alice))).rejects.toThrow(/not your/i);

    await mutate("repo.open", { repoId: "browser:alicefolder", depth: 10, now: Date.now() }, ctx(bob));
    const [d] = await q<{ state: string }>(`select state from $S.demands where id = $1`, [demandId("browser:alicefolder", bob)]);
    expect(d!.state).toBe("error");
  });

  it("pairs a companion through a one-time code", async () => {
    const res = await s.req("/agent-api/v1/register", { method: "POST", body: JSON.stringify({ name: "laptop" }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const reg = (await res.json()) as { agentId: string; token: string; code: string };
    const me = async () => (await (await s.req("/agent-api/v1/me", { headers: { authorization: `Bearer ${reg.token}` } })).json()) as { paired: boolean; userID: string };
    expect(await me()).toMatchObject({ paired: false, userID: `agent:${reg.agentId}` });
    await expect(mutate("agent.claim", { code: "wrong-code-123", now: Date.now() }, ctx(alice))).rejects.toThrow(/invalid or expired/);
    await mutate("agent.claim", { code: reg.code, now: Date.now() }, ctx(alice));
    expect((await me()).paired).toBe(true);
    await expect(mutate("agent.claim", { code: reg.code, now: Date.now() }, ctx(bob))).rejects.toThrow();
  });
});

describe("endpoints", () => {
  it("only zero-cache (with the API key) may call the query and mutate endpoints", async () => {
    const r = await s.req("/internal/zero/query", { method: "POST", body: "[]", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(403);
  });

  it("tells the web client who it is in a readable boot cookie", async () => {
    const jar = new CookieJar();
    await s.req("/github/octo/basic", { jar });
    const boot = [...jar.cookies].find(([k]) => k.startsWith("lanes_boot"));
    expect(boot?.[1]).toBe(".11");
    const signedIn = await s.login("alice");
    await s.req("/github/octo/basic", { jar: signedIn });
    expect([...signedIn.cookies].find(([k]) => k.startsWith("lanes_boot"))?.[1]).toBe(`${alice}.11`);
  });
});
