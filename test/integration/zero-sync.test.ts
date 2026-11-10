// The whole sync path: server + embedded zero-cache + a Zero client (as the web app uses it).
// Needs PostgreSQL with wal_level=logical and an empty "lanes" schema; skipped unless
// LANES_ZERO_TEST_DB points at one, e.g.
//
//   docker run -d -p 55433:5432 -e POSTGRES_PASSWORD=pass postgres:17 -c wal_level=logical
//   psql postgres://postgres:pass@localhost:55433/postgres -c 'create schema lanes'
//   LANES_ZERO_TEST_DB=postgres://postgres:pass@localhost:55433/postgres pnpm vitest run test/integration/zero-sync.test.ts

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Zero } from "@rocicorp/zero";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerApp, type ServerApp } from "../../src/server/app.ts";
import { testConfig } from "../../src/server/config.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { readId } from "../../src/zero/rows.ts";
import { schema, type ZeroContext } from "../../src/zero/schema.ts";
import { cleanupGitHubFixture, type FakeGitHub } from "../fakes/github.ts";
import { makeStaticDir, startFake, WEBHOOK_SECRET } from "../fakes/server-harness.ts";
import { signWebhook } from "../fakes/github.ts";

const DB = process.env.LANES_ZERO_TEST_DB;
const REPO = "github:octo:basic";

describe.skipIf(!DB)("Zero sync end to end", () => {
  let fake: FakeGitHub;
  let server: ServerApp;
  let port = 0;
  let http: ReturnType<typeof serve>;
  let z: Zero<typeof schema>;

  beforeAll(async () => {
    ({ fake } = await startFake());
    const config = testConfig({ databaseUrl: DB!, databaseSchema: "lanes", githubApiUrl: fake.url, githubWebUrl: fake.url, webhookSecret: WEBHOOK_SECRET, staticDir: makeStaticDir(), log: () => {} });
    config.zero = {
      cacheUrl: null,
      port: 4870 + (process.pid % 50),
      upstreamDb: DB!,
      cvrDb: null,
      changeDb: null,
      appId: "lanes_zero",
      apiKey: "test-key",
      adminPassword: "test",
      replicaFile: join(mkdtempSync(join(tmpdir(), "lanes-zero-")), "replica.db"),
      logLevel: "error",
      numSyncWorkers: 1,
    };
    server = createServerApp(config);
    await server.ready();
    port = await new Promise<number>((res) => {
      http = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }, (i) => res(i.port));
    });
    http.on("upgrade", (req, sock, head) => {
      if (!server.upgrade(req, sock, head)) sock.destroy();
    });
    server.startZero(port);
    z = new Zero({ cacheURL: `http://127.0.0.1:${port}/zero`, schema, mutators, kvStore: "mem", context: { accountId: null, agentId: null } as ZeroContext });
  }, 60_000);

  afterAll(async () => {
    await z?.close();
    http?.close();
    await server?.close();
    await fake?.close();
    cleanupGitHubFixture();
  });

  function watch<T>(query: unknown): { current: () => T | undefined; until: (pred: (v: T) => boolean, ms?: number) => Promise<T> } {
    let current: T | undefined;
    const waiters = new Set<() => void>();
    const view = (z.materialize as unknown as (q: unknown) => { addListener(l: (d: unknown) => void): void })(query);
    view.addListener((d) => {
      current = d as T;
      for (const w of [...waiters]) w();
    });
    return {
      current: () => current,
      until: (pred, ms = 30_000) =>
        new Promise<T>((resolve, reject) => {
          const check = () => {
            if (current !== undefined && pred(current)) {
              waiters.delete(check);
              clearTimeout(timer);
              resolve(current);
            }
          };
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new Error(`timed out; last value: ${JSON.stringify(current)?.slice(0, 300)}`));
          }, ms);
          waiters.add(check);
          check();
        }),
    };
  }

  it("opens a repository and syncs its history and refs", async () => {
    const commits = watch<{ hash: string }[]>(queries.repo.commits({ repoId: REPO, limit: 100 }));
    const refs = watch<{ short: string }[]>(queries.repo.refs({ repoId: REPO }));
    z.mutate(mutators.repo.open({ repoId: REPO, depth: 500, now: Date.now() }));
    expect((await commits.until((c) => c.length === 14, 60_000)).length).toBe(14);
    expect((await refs.until((r) => r.length > 0)).map((r) => r.short)).toContain("main");
  }, 90_000);

  it("answers reads", async () => {
    const [head] = (await z.run(queries.repo.commits({ repoId: REPO, limit: 1 }))) as { hash: string }[];
    const read = watch<{ state: string; result: { hash: string } } | undefined>(queries.reads.byId({ id: readId(REPO, "commit", [head!.hash]) }));
    z.mutate(mutators.read.request({ repoId: REPO, method: "commit", params: [head!.hash], live: false, now: Date.now() }));
    const r = await read.until((x) => x?.state === "ok");
    expect(r!.result.hash).toBe(head!.hash);
  }, 60_000);

  it("shows a pushed commit after GitHub's webhook", async () => {
    const commits = watch<{ subject: string }[]>(queries.repo.commits({ repoId: REPO, limit: 100 }));
    const pushed = fake.pushCommit("octo", "basic", "main", { message: "Pushed while watching" });
    const body = JSON.stringify(pushed.payload);
    await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": crypto.randomUUID(), "x-hub-signature-256": signWebhook(WEBHOOK_SECRET, body) },
    });
    await commits.until((c) => c.some((x) => x.subject === "Pushed while watching"), 30_000);
  }, 60_000);
});
