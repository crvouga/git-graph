import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubAdapter } from "../../src/github/adapter.ts";
import { GitHubClient } from "../../src/github/client.ts";
import type { EventEnvelope } from "../../src/core/types.ts";
import { cleanupGitHubFixture, type FakeGitHub } from "../fakes/github.ts";
import { percentile, sleep, startFake, startStack, type Stack } from "../fakes/server-harness.ts";

const KEY = "github:octo:basic";
const SECRET = "github:octo:secret";
// Webhook tests: polling far in the future so only webhooks drive changes.
const NO_POLL = { fastMs: 600_000, coveredMs: 600_000, maxMs: 600_000, coverageWindowMs: 600_000, jitter: 0 };

let fake: FakeGitHub;
let users: Stack["users"];

beforeAll(async () => {
  // LANES_FAKE_LATENCY_MS simulates GitHub API round-trip time for the latency measurements.
  ({ fake, users } = await startFake({ latencyMs: Number(process.env.LANES_FAKE_LATENCY_MS ?? 0) }));
}, 60_000);

afterAll(async () => {
  await fake?.close();
  cleanupGitHubFixture();
});

async function currentVersion(name = "basic", token: string | null = null) {
  return (await new GitHubAdapter({ owner: "octo", name, api: new GitHubClient({ apiUrl: fake.url }), token }).refs()).version;
}

/** The stream is live once the hello frame (seq 0) arrived. */
const isHello = (e: EventEnvelope) => e.seq === 0 && e.event.type === "sync.ok";
const isRefs = (v?: string) => (e: EventEnvelope) => e.event.type === "refs.changed" && (v === undefined || e.event.version === v);

describe("webhook receiver", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ fake, config: { poller: NO_POLL } });
  });
  afterAll(() => s.close());

  it("rejects missing and invalid signatures", async () => {
    const payload = fake.refPayload("octo", "basic", "x", "branch");
    expect((await s.webhook("create", payload, { signature: "" })).status).toBe(401);
    expect((await s.webhook("create", payload, { secret: "wrong" })).status).toBe(401);
    expect((await s.webhook("create", payload, { signature: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect((await s.webhook("ping", { zen: "hi" })).status).toBe(202);
    expect(s.server.webhooks.stats.rejected).toBe(3);
  });

  it("processes a duplicate delivery once", async () => {
    const before = { ...s.server.webhooks.stats };
    const published: EventEnvelope[] = [];
    const off = s.server.hub.subscribeAll((e) => published.push(e));
    const { payload } = fake.pushCommit("octo", "basic", "dup-test");
    const r1 = await s.webhook("push", payload, { delivery: "dup-1" });
    const r2 = await s.webhook("push", payload, { delivery: "dup-1" });
    await s.server.webhooks.idle();
    off();
    fake.setRef("octo", "basic", "refs/heads/dup-test", null);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ duplicate: true });
    expect(s.server.webhooks.stats.processed - before.processed).toBe(1);
    expect(published.filter((e) => e.event.type === "commits.added")).toHaveLength(1);
  });

  it("de-duplicates durably across restarts (DATA_DIR)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lanes-data-"));
    try {
      const a = await startStack({ fake, config: { dataDir, poller: NO_POLL } });
      expect((await a.webhook("ping", {}, { delivery: "durable-1" })).status).toBe(202);
      await a.close();
      const b = await startStack({ fake, config: { dataDir, poller: NO_POLL } });
      expect(await (await b.webhook("ping", {}, { delivery: "durable-1" })).json()).toMatchObject({ duplicate: true });
      await b.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("is unavailable without a secret", async () => {
    const n = await startStack({ fake, config: { webhookSecret: null, poller: NO_POLL } });
    try {
      expect((await n.webhook("ping", {})).status).toBe(501);
    } finally {
      await n.close();
    }
  });
});

describe("real-time sync over SSE", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ fake, listen: true, config: { poller: NO_POLL, heartbeatMs: 1000 } });
  });
  afterAll(() => s.close());

  it("ends in the authoritative state when create/delete deliveries arrive out of order", async () => {
    const c = s.sse(KEY);
    await c.next(isHello);
    const main = fake.repo("octo", "basic").refs.get("refs/heads/main")!;
    // GitHub: branch created, then deleted. Deliveries arrive reversed.
    fake.setRef("octo", "basic", "refs/heads/ooo", main);
    fake.setRef("octo", "basic", "refs/heads/ooo", null);
    await s.webhook("delete", fake.refPayload("octo", "basic", "ooo", "branch"));
    await s.webhook("create", fake.refPayload("octo", "basic", "ooo", "branch"));
    await s.server.webhooks.idle();
    const want = await currentVersion();
    expect(s.server.reconciler.state(KEY).lastVersion).toBe(want);
    const refsEvents = c.events.filter(isRefs());
    expect(refsEvents[refsEvents.length - 1]!.event).toMatchObject({ version: want });
    // and the reverse: created, deleted, re-created → present
    fake.setRef("octo", "basic", "refs/heads/ooo2", main);
    await s.webhook("create", fake.refPayload("octo", "basic", "ooo2", "branch"));
    await s.webhook("delete", fake.refPayload("octo", "basic", "ooo2", "branch"));
    await s.server.webhooks.idle();
    const want2 = await currentVersion();
    await c.next(isRefs(want2));
    fake.setRef("octo", "basic", "refs/heads/ooo2", null);
    c.close();
  });

  it("coalesces rapid pushes into few reconciliations", async () => {
    const c = s.sse(KEY);
    await c.next(isHello);
    await sleep(100); // initial reconciliation on subscribe
    const st = s.server.reconciler.state(KEY);
    const r0 = st.reconciles;
    const n0 = fake.countRequests((r) => r.path.includes("/git/matching-refs/heads"));
    // 10 pushes land on GitHub in quick succession; their deliveries arrive concurrently.
    const payloads = Array.from({ length: 10 }, () => fake.pushCommit("octo", "basic", "burst").payload);
    await Promise.all(payloads.map((p) => s.webhook("push", p)));
    await s.server.webhooks.idle();
    const want = await currentVersion();
    await c.next(isRefs(want));
    const reconciles = st.reconciles - r0;
    const headReads = fake.countRequests((r) => r.path.includes("/git/matching-refs/heads")) - n0;
    console.log(`[coalescing] 10 pushes → ${reconciles} reconciliations, ${headReads} ref reads`);
    expect(reconciles).toBeLessThanOrEqual(3);
    expect(c.events.filter((e) => e.event.type === "commits.added")).toHaveLength(10);
    fake.setRef("octo", "basic", "refs/heads/burst", null);
    c.close();
  });

  it("delivers refs.changed after push+webhook; measures receipt→notification latency", async () => {
    const c = s.sse(KEY);
    await c.next(isHello);
    await sleep(300 + 4 * Number(process.env.LANES_FAKE_LATENCY_MS ?? 0)); // initial reconciliation on subscribe
    const lat: number[] = [];
    for (let i = 0; i < 20; i++) {
      await s.server.webhooks.idle(); // previous delivery fully processed: nothing else in flight
      const { payload } = fake.pushCommit("octo", "basic", "latency");
      const want = await currentVersion();
      const t0 = performance.now();
      const r = await s.webhook("push", payload);
      expect(r.status).toBe(202);
      const e = await c.next(isRefs(want), 5000);
      lat.push(e.receivedAt - t0);
      await sleep(5);
    }
    fake.setRef("octo", "basic", "refs/heads/latency", null);
    const p50 = percentile(lat, 50);
    const p95 = percentile(lat, 95);
    const fakeLatency = Number(process.env.LANES_FAKE_LATENCY_MS ?? 0);
    console.log(`[latency] webhook receipt → SSE refs.changed over ${lat.length} events (GitHub RTT ${fakeLatency}ms): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${Math.max(...lat).toFixed(1)}ms`);
    expect(Math.min(...lat)).toBeGreaterThan(0);
    expect(p95).toBeLessThan(500 + 4 * fakeLatency);
    c.close();
  });

  it("never delivers private repo events to unauthorized subscribers", async () => {
    const alice = await s.login("alice");
    const bob = await s.login("bob");
    const a = s.sse(SECRET, alice);
    await a.next(isHello);
    // bob and anonymous cannot open the stream at all
    expect((await fetch(`${s.url}/api/v1/repositories/${SECRET}/events`, { headers: { cookie: bob.header() } })).status).toBe(404);
    expect((await fetch(`${s.url}/api/v1/repositories/${SECRET}/events`)).status).toBe(404);
    const b = s.sse(SECRET, bob);
    const anon = s.sse(SECRET);
    const { payload } = fake.pushCommit("octo", "secret", "private-work");
    await s.webhook("push", payload);
    await a.next((e) => e.event.type === "commits.added");
    await sleep(200);
    expect(b.events).toHaveLength(0);
    expect(anon.events).toHaveLength(0);
    expect(b.states).toContain("backoff");
    fake.setRef("octo", "secret", "refs/heads/private-work", null);
    for (const x of [a, b, anon]) x.close();
  });

  it("replays missed events on reconnect with Last-Event-ID", async () => {
    const c1 = s.sse(KEY);
    await c1.next(isHello);
    const cursor = c1.cursor();
    c1.close();
    const { payload, after } = fake.pushCommit("octo", "basic", "missed");
    await s.webhook("push", payload);
    await s.server.webhooks.idle();
    const want = await currentVersion();
    const c2 = s.sse(KEY, undefined, cursor);
    const added = await c2.next((e) => e.event.type === "commits.added" && e.event.commits.includes(after));
    const changed = await c2.next(isRefs(want));
    expect(added.seq).toBeLessThan(changed.seq);
    expect(c2.events.some((e) => e.event.type === "resync")).toBe(false);
    fake.setRef("octo", "basic", "refs/heads/missed", null);
    c2.close();
  });

  it("a server restart (new hub epoch) makes reconnecting clients resync", async () => {
    const c1 = s.sse(KEY);
    await c1.next(isHello);
    const cursor = c1.cursor()!;
    c1.close();
    const restarted = await startStack({ fake, listen: true, config: { poller: NO_POLL } });
    try {
      expect(restarted.server.hub.epoch).not.toBe(s.server.hub.epoch);
      const c2 = restarted.sse(KEY, undefined, cursor);
      const e = await c2.next((x) => x.event.type === "resync");
      expect(e.event).toMatchObject({ type: "resync", reason: "server restarted" });
      c2.close();
    } finally {
      await restarted.close();
    }
  });

  it("access.revoked seals streams; reconnecting re-checks access", async () => {
    const c = s.sse(KEY);
    await c.next(isHello);
    fake.repo("octo", "basic").private = true;
    try {
      const r = await s.webhook("repository", { action: "privatized", repository: fake.repoPayload(fake.repo("octo", "basic")) });
      expect(r.status).toBe(202);
      await c.next((e) => e.event.type === "access.revoked");
      const n = c.events.length;
      // nothing more is delivered on the sealed stream
      const { payload } = fake.pushCommit("octo", "basic", "after-revoke");
      await s.webhook("push", payload);
      await s.server.webhooks.idle();
      await sleep(100);
      expect(c.events.length).toBe(n);
      // a fresh anonymous request is re-authorized against GitHub: now 404
      expect((await fetch(`${s.url}/api/v1/repositories/${KEY}/refs`)).status).toBe(404);
      expect((await fetch(`${s.url}/api/v1/repositories/${KEY}/events`)).status).toBe(404);
    } finally {
      fake.repo("octo", "basic").private = false;
      fake.setRef("octo", "basic", "refs/heads/after-revoke", null);
      await s.webhook("repository", { action: "publicized", repository: fake.repoPayload(fake.repo("octo", "basic")) });
      await s.server.webhooks.idle();
      c.close();
    }
  });

  it("app authorization revoked: the user's streams get access.revoked and sessions end", async () => {
    const alice = await s.login("alice");
    const a = s.sse(SECRET, alice);
    await a.next(isHello);
    const anon = s.sse(KEY);
    await anon.next(isHello);
    await s.webhook("github_app_authorization", { action: "revoked", sender: { login: "alice", id: users.alice } });
    await a.next((e) => e.event.type === "access.revoked");
    expect((await (await fetch(`${s.url}/api/v1/session`, { headers: { cookie: alice.header() } })).json()).authenticated).toBe(false);
    await sleep(50);
    expect(anon.events.some((e) => e.event.type === "access.revoked")).toBe(false);
    a.close();
    anon.close();
  });
});

describe("reconciliation poller", () => {
  it("recovers a change that had no webhook", async () => {
    const s = await startStack({ fake, listen: true, config: { poller: { fastMs: 100, coveredMs: 100, maxMs: 400, coverageWindowMs: 60_000, jitter: 0.1 } } });
    try {
      const c = s.sse(KEY);
      await c.next(isHello);
      const t0 = performance.now();
      fake.pushCommit("octo", "basic", "silent"); // no webhook
      const want = await currentVersion();
      await c.next(isRefs(want), 3000);
      console.log(`[poller] change without webhook detected after ${(performance.now() - t0).toFixed(0)}ms (fast=100ms, max=400ms)`);
      const status = await (await fetch(`${s.url}/api/v1/repositories/${KEY}/sync`)).json();
      expect(status).toMatchObject({ repositoryId: KEY, connection: "polling", refsVersion: want, subscribers: 1, webhook: { covered: false } });
      expect(status.lastSuccessAt).toBeGreaterThan(0);
      c.close();
      await sleep(100);
      expect(s.server.poller.info(KEY).polling).toBe(false); // paused without subscribers
    } finally {
      fake.setRef("octo", "basic", "refs/heads/silent", null);
      await s.close();
    }
  });

  it("idle repositories cost few requests, almost all 304s", async () => {
    const poller = { fastMs: 50, coveredMs: 50, maxMs: 400, coverageWindowMs: 60_000, jitter: 0.1 };
    const s = await startStack({ fake, listen: true, config: { poller } });
    try {
      const c = s.sse(KEY);
      await c.next(isHello);
      await sleep(200); // let the first back-off steps settle
      const n0 = fake.log.length;
      const windowMs = 3000;
      await sleep(windowMs);
      const reqs = fake.log.slice(n0);
      const polls = s.server.poller.info(KEY).polls;
      const notModified = reqs.filter((r) => r.status === 304).length;
      console.log(
        `[idle] ${windowMs}ms idle with 1 subscriber (fast=${poller.fastMs}ms, max=${poller.maxMs}ms): ${reqs.length} GitHub requests, ${notModified} were 304 (${((notModified / Math.max(1, reqs.length)) * 100).toFixed(0)}%), ${polls} polls total, interval now ${s.server.poller.info(KEY).intervalMs}ms`,
      );
      // At the max interval: ~windowMs/maxMs polls × ≤4 conditional requests each.
      expect(reqs.length).toBeLessThanOrEqual(Math.ceil(windowMs / poller.maxMs + 2) * 4);
      expect(notModified / reqs.length).toBeGreaterThanOrEqual(0.9);
      expect(s.server.poller.info(KEY).intervalMs).toBe(poller.maxMs);
      c.close();
    } finally {
      await s.close();
    }
  });

  it("projects production idle cost from the default schedule", () => {
    // Default: 15s fast, doubling to 5 min; ≤3 conditional requests per poll (repo, heads, tags).
    let t = 0;
    let interval = 15_000;
    let polls = 0;
    while (t < 3600_000) {
      t += interval;
      polls++;
      interval = Math.min(300_000, interval * 2);
    }
    console.log(`[idle-projection] default schedule: ${polls} polls/hour/repo with subscribers ≈ ${polls * 3} conditional requests/hour (304s do not count against the rate limit)`);
    expect(polls).toBeLessThan(20);
  });
});
