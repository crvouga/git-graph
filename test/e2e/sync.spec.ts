// Real-time synchronization: external commits, shared refs from other worktrees, GitHub pushes via
// webhooks, multi-tab coordination and stale-session isolation. No manual refresh anywhere.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { control, git, openLocal, state } from "./harness.ts";
import { makeBasic } from "../fixtures/make-fixtures.ts";
import { focusedRowSubject, row, waitForGraph } from "./util.ts";

function freshBasic(name: string) {
  const root = join(state().fixturesRoot, name);
  mkdirSync(root, { recursive: true });
  return makeBasic(root);
}

test("external commit and a ref moved from another worktree appear automatically; selection and focus are kept", async ({ page }) => {
  const fx = freshBasic("sync-local");
  const { url } = openLocal(fx.repo);
  await page.goto(url);
  await waitForGraph(page, 10);
  await expect(page.getByTestId("sync-status")).toHaveAttribute("aria-label", /^Live/);

  // Select a commit with the keyboard and open its details.
  await page.getByRole("grid").focus();
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowDown");
  expect(await focusedRowSubject(page)).toBe("Rename app.ts to main.ts");
  await page.keyboard.press("Enter");
  const selectedUrl = page.url();
  await expect(page.getByRole("region", { name: "Commit details" })).toBeVisible();

  // 1. Another process commits in this worktree.
  const t0 = Date.now();
  git(fx.repo, ["commit", "--allow-empty", "-q", "-m", "External commit from a shell"]);
  await expect(row(page, "External commit from a shell")).toBeVisible({ timeout: 5000 });
  const localLatency = Date.now() - t0;
  // Same selection (by object id), same URL, details still open, focus still in the graph.
  expect(page.url()).toBe(selectedUrl);
  await expect(page.getByRole("region", { name: "Commit details" })).toBeVisible();
  expect(await focusedRowSubject(page)).toBe("Rename app.ts to main.ts");
  await expect(page.getByRole("grid")).toBeFocused();

  // 2. A shared ref is updated from the other linked worktree (wt-two branch).
  const t1 = Date.now();
  git(fx.worktreeTwo, ["commit", "--allow-empty", "-q", "-m", "Commit made in linked worktree"]);
  await expect(row(page, "Commit made in linked worktree")).toContainText("wt-two", { timeout: 5000 });
  const worktreeLatency = Date.now() - t1;

  // 3. A working-tree edit by an editor shows up as one more uncommitted change.
  const count = async () => Number(/\((\d+)\)/.exec((await page.locator('[data-hash="working"] .subject').textContent()) ?? "")?.[1] ?? 0);
  const before = await count();
  writeFileSync(join(fx.repo, "new-file.txt"), "hello\n");
  await expect.poll(count, { timeout: 5000 }).toBe(before + 1);

  test.info().annotations.push({ type: "latency", description: JSON.stringify({ localCommitToUiMs: localLatency, otherWorktreeRefToUiMs: worktreeLatency }) });
  console.log(`sync latency: external commit → UI ${localLatency}ms, other worktree → UI ${worktreeLatency}ms`);
});

test("a refresh of the previous repository never touches the newly opened one", async ({ page }) => {
  const a = freshBasic("stale-a");
  const b = freshBasic("stale-b");
  git(b.repo, ["commit", "--allow-empty", "-q", "-m", "Only in repository B"]);
  const ua = openLocal(a.repo);
  const ub = openLocal(b.repo);
  await page.goto(ua.url);
  await waitForGraph(page, 10);
  // Switch to B, then cause changes in A while B is loading.
  await page.goto(ub.url.split("#")[0]!);
  git(a.repo, ["commit", "--allow-empty", "-q", "-m", "Late change in repository A"]);
  await waitForGraph(page, 10);
  await expect(row(page, "Only in repository B")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(row(page, "Late change in repository A")).toHaveCount(0);
  expect(page.url()).toContain(ub.key.split(":")[1]!);
});

test("GitHub push delivered by webhook updates the open graph and a second tab without manual refresh", async ({ page, context }) => {
  const s = state();
  await page.goto(`${s.appOrigin}/github/octo/basic`);
  await waitForGraph(page, 5);
  const page2 = await context.newPage();
  await page2.goto(`${s.appOrigin}/github/octo/basic`);
  await waitForGraph(page2, 5);
  // Exactly one tab holds the real-time stream; the other is fed over BroadcastChannel.
  const labels = [await page.getByTestId("sync-status").getAttribute("aria-label"), await page2.getByTestId("sync-status").getAttribute("aria-label")];
  expect(labels.filter((l) => l?.includes("shared with another tab")).length).toBe(1);

  // An agent subscribes to the same stream through the public API (no browser involved).
  const agentEvents: string[] = [];
  const agentAbort = new AbortController();
  const agent = (async () => {
    const res = await fetch(`${s.appOrigin}/api/v1/repositories/github:octo:basic/events`, { headers: { accept: "text/event-stream" }, signal: agentAbort.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const m of value.matchAll(/^event: (.+)$/gm)) agentEvents.push(m[1]!);
    }
  })().catch(() => {});
  await expect.poll(() => agentEvents.includes("hello")).toBe(true);

  const t0 = Date.now();
  const pushed = await control("/push", { owner: "octo", name: "basic", branch: "main", message: "Pushed on GitHub" });
  console.log("PUSH", JSON.stringify(pushed));
  page.context().on("request", (r) => r.url().includes("/api/") && console.log("REQ", Date.now() - t0, r.method(), r.url().replace(s.appOrigin, "")));
  await expect(row(page, "Pushed on GitHub")).toBeVisible({ timeout: 5000 });
  const webhookLatency = Date.now() - t0;
  await expect(row(page2, "Pushed on GitHub")).toBeVisible({ timeout: 5000 });
  await expect.poll(() => agentEvents.filter((e) => e === "refs.changed" || e === "commits.added").length, { timeout: 5000 }).toBeGreaterThan(0);
  agentAbort.abort();
  await agent;
  console.log(`webhook receipt → visible graph: ${webhookLatency}ms`);
  test.info().annotations.push({ type: "latency", description: JSON.stringify({ webhookToUiMs: webhookLatency }) });
  await page2.close();
});
