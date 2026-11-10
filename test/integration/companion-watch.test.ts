// SSE + external-change watcher: changes made by other processes reach subscribers of every
// worktree of the repository, with measured latency.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, makeBasic, type BasicFixture } from "../fixtures/make-fixtures.ts";
import { createCompanion, type Companion } from "../../src/companion/server.ts";
import { HttpApi, subscribeEvents, type EventSubscription } from "../../src/core/api/client.ts";
import type { EventEnvelope, RepoInfo } from "../../src/core/types.ts";

const run = promisify(execFile);

class Inbox {
  readonly items: { at: number; env: EventEnvelope }[] = [];
  private waiters: (() => void)[] = [];
  push(env: EventEnvelope) {
    this.items.push({ at: performance.now(), env });
    for (const w of this.waiters.splice(0)) w();
  }
  /** Wait for the first matching event after index `from`. */
  async waitFor(pred: (e: EventEnvelope) => boolean, from: number, timeoutMs = 5000): Promise<{ at: number; env: EventEnvelope; index: number }> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const i = this.items.findIndex((x, idx) => idx >= from && pred(x.env));
      if (i >= 0) return { ...this.items[i]!, index: i };
      const left = deadline - performance.now();
      if (left <= 0) throw new Error(`timed out waiting for event; got ${JSON.stringify(this.items.slice(from).map((x) => x.env.event.type))}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, left);
      });
    }
  }
}

describe("SSE + watcher", () => {
  let root: string;
  let fx: BasicFixture;
  let companion: Companion;
  let close: () => Promise<void>;
  let api: HttpApi;
  let main: RepoInfo;
  let feature: RepoInfo;
  const subs: EventSubscription[] = [];
  const inbox = { main: new Inbox(), feature: new Inbox() };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lanes-watch-")));
    const cfg = join(root, "user.gitconfig");
    writeFileSync(cfg, "[user]\n\tname = W\n\temail = w@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
    process.env.GIT_CONFIG_GLOBAL = cfg;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    if (!existsSync(join(ROOT, ".gitconfig"))) {
      mkdirSync(ROOT, { recursive: true });
      writeFileSync(join(ROOT, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
    }
    fx = makeBasic(root);
    companion = createCompanion({ configDir: join(root, "cfg"), watch: { debounceMs: 40, pollMs: 5000 } });
    const l = await companion.listen(0);
    close = l.close;
    const token = companion.token();
    api = new HttpApi({ baseUrl: `${l.url}/api/v1`, headers: () => ({ authorization: `Bearer ${token}` }), client: "cli" });
    const open = async (path: string) => ((await api.post<{ ok: boolean; result: RepoInfo }>("/commands/execute", { command: "local.open", args: { path } })).result);
    main = await open(fx.repo);
    feature = await open(fx.worktreeFeature);
    expect(main.commonDir).toBe(feature.commonDir);
    expect(main.key).not.toBe(feature.key);
    subs.push(subscribeEvents(api, main.key, (e) => inbox.main.push(e)));
    subs.push(subscribeEvents(api, feature.key, (e) => inbox.feature.push(e)));
    // wait until both watchers computed their baselines
    for (const key of [main.key, feature.key]) {
      const deadline = Date.now() + 5000;
      while (!companion.runtime.watch.isWatching(key) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await companion.runtime.watch.ready(key);
    }
    await inbox.main.waitFor((e) => e.event.type === "sync.ok", 0);
  });

  afterAll(async () => {
    for (const s of subs) s.close();
    await close();
    rmSync(root, { recursive: true, force: true });
  });

  it("an external commit in another process produces refs.changed + commits.added", async () => {
    const from = inbox.main.items.length;
    await run("git", ["commit", "-q", "--allow-empty", "-m", "external commit"], { cwd: fx.repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.repo, encoding: "utf8" }).trim();
    const ev = await inbox.main.waitFor((e) => e.event.type === "refs.changed", from);
    expect(ev.env.event).toMatchObject({ type: "refs.changed", repositoryId: main.key, version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const added = await inbox.main.waitFor((e) => e.event.type === "commits.added", from);
    expect((added.env.event as { commits: string[] }).commits).toContain(head);
    // the version in the event is the current refs version
    const refs = await api.get<{ version: string }>(`/repositories/${main.key}/refs`);
    expect((ev.env.event as { version: string }).version).toBe(refs.version);
  });

  it("a ref updated from the other linked worktree notifies both worktree keys", async () => {
    const fm = inbox.main.items.length;
    const ff = inbox.feature.items.length;
    await run("git", ["commit", "-q", "--allow-empty", "-m", "from linked worktree"], { cwd: fx.worktreeFeature });
    await inbox.feature.waitFor((e) => e.event.type === "refs.changed", ff);
    await inbox.main.waitFor((e) => e.event.type === "refs.changed", fm);
  });

  it("working-tree edits produce status.changed; worktree add produces worktree.changed", async () => {
    const from = inbox.main.items.length;
    writeFileSync(join(fx.repo, "new-untracked.txt"), "hello\n");
    const st = await inbox.main.waitFor((e) => e.event.type === "status.changed", from);
    expect(st.env.event).toMatchObject({ worktreeId: realpathSync(fx.repo) });
    const f2 = inbox.feature.items.length;
    await run("git", ["worktree", "add", "-q", join(root, "wt-added"), "-b", "wt-added", "main"], { cwd: fx.repo });
    await inbox.feature.waitFor((e) => e.event.type === "worktree.changed", f2);
  });

  it("does not publish when nothing changed (digest dedupe)", async () => {
    await companion.runtime.watch.poke(main.key);
    const from = inbox.main.items.length;
    await companion.runtime.watch.poke(main.key);
    await companion.runtime.watch.poke(main.key);
    await new Promise((r) => setTimeout(r, 150));
    expect(inbox.main.items.slice(from).map((x) => x.env.event.type)).toEqual([]);
  });

  it("latency: external ref change -> SSE event, p95 over 20 changes", async () => {
    const lat: number[] = [];
    for (let i = 0; i < 20; i++) {
      const from = inbox.main.items.length;
      const t0 = performance.now();
      await run("git", ["update-ref", `refs/heads/lat-${i}`, "HEAD"], { cwd: fx.repo });
      const t1 = performance.now();
      const ev = await inbox.main.waitFor((e) => e.event.type === "refs.changed", from);
      lat.push(ev.at - t1);
      void t0;
      await new Promise((r) => setTimeout(r, 60));
    }
    lat.sort((a, b) => a - b);
    const p = (q: number) => lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)]!;
    const summary = { n: lat.length, p50: Math.round(p(0.5)), p95: Math.round(p(0.95)), max: Math.round(lat[lat.length - 1]!) };
    console.log(`[watch latency ms] ${JSON.stringify(summary)}`);
    expect(summary.p95).toBeLessThan(1000);
  });

  it("stops watching when the last subscriber leaves", async () => {
    for (const s of subs.splice(0)) s.close();
    const deadline = Date.now() + 3000;
    while ((companion.runtime.watch.isWatching(main.key) || companion.runtime.watch.isWatching(feature.key)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(companion.runtime.watch.isWatching(main.key)).toBe(false);
    expect(companion.runtime.watch.isWatching(feature.key)).toBe(false);
  });
});
