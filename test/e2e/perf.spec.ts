// Performance budgets on a 100,000-commit history (production build). Results → test-results/perf.json.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { git, openLocal, ROOT, state } from "./harness.ts";
import { MOD } from "./util.ts";

const BUDGET = {
  firstVisibleCommitsMs: 1500,
  firstUsableGraphMs: 2000,
  scrollAvgFps: 50,
  paletteInputP95Ms: 50,
  branchFilterMs: 1500,
  commitSelectionMs: 400,
  largeDiffMs: 2500,
  cachedReopenMs: 1200,
};

test("100k-commit history stays fast and responsive", async ({ page, context }) => {
  const s = state();
  test.skip(!s.large, "Run `node test/fixtures/make-fixtures.ts --large` to create the 100k fixture");
  const results: Record<string, number | string> = {};
  const { url } = openLocal(s.large!);

  // Time to first visible commits / first usable graph (keyboard navigation works).
  const t0 = Date.now();
  await page.goto(url);
  await expect(page.locator('[role="row"][data-row="0"]')).toBeVisible({ timeout: 10_000 });
  results.firstVisibleCommitsMs = Date.now() - t0;
  await page.getByRole("grid").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[role="row"][data-row="1"].kb')).toBeVisible();
  results.firstUsableGraphMs = Date.now() - t0;
  results.domRows = await page.locator('[role="row"][data-row]').count();

  // Scroll frame rate while more history streams in.
  const scroll = await page.evaluate(async () => {
    const el = document.querySelector(".graph-scroll") as HTMLElement;
    const frames: number[] = [];
    let last = performance.now();
    const start = last;
    await new Promise<void>((res) => {
      const step = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        el.scrollTop += 240;
        if (now - start < 3000) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
    frames.sort((a, b) => a - b);
    return { avgFps: frames.length / 3, p95FrameMs: frames[Math.floor(frames.length * 0.95)]!, rowsLoaded: document.querySelectorAll('[role="row"][data-row]').length };
  });
  results.scrollAvgFps = Math.round(scroll.avgFps);
  results.scrollP95FrameMs = Math.round(scroll.p95FrameMs);

  // Palette typing latency while history keeps loading in the background (End triggers paging).
  await page.getByRole("grid").focus();
  await page.keyboard.press("End");
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.evaluate(() => {
    const w = window as unknown as { __lat: number[] };
    w.__lat = [];
    const input = document.querySelector('[role="combobox"]')!;
    input.addEventListener("keydown", () => {
      const t = performance.now();
      requestAnimationFrame(() => setTimeout(() => w.__lat.push(performance.now() - t), 0));
    });
  });
  await page.keyboard.type("toggle remote branches", { delay: 30 });
  await page.waitForTimeout(200);
  const lat = (await page.evaluate(() => (window as unknown as { __lat: number[] }).__lat)).sort((a, b) => a - b);
  results.paletteInputP50Ms = Math.round(lat[Math.floor(lat.length / 2)]!);
  results.paletteInputP95Ms = Math.round(lat[Math.floor(lat.length * 0.95)]!);
  await page.keyboard.press("Escape");

  // Commit selection latency (Enter → details rendered).
  await page.getByRole("grid").focus();
  await page.keyboard.press("Home");
  let t = Date.now();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Commit details" })).toContainText("Commit:");
  results.commitSelectionMs = Date.now() - t;
  await page.keyboard.press("Escape");

  // Branch filter latency (one feature branch).
  const branch = git(s.large!, ["for-each-ref", "--count=1", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/feature/"]).trim();
  t = Date.now();
  await page.goto(`${url.split("#")[0]}?branch=${encodeURIComponent(branch)}`);
  await expect(page.locator('[data-dropdown="branches"]')).toHaveText(branch);
  await expect(page.locator('[role="row"][data-row="0"]')).toBeVisible();
  results.branchFilterMs = Date.now() - t;

  // Reopen: rendered from the IndexedDB cache, then revalidated.
  t = Date.now();
  await page.goto(url.split("#")[0]!);
  await expect(page.locator('[role="row"][data-row="5"]')).toBeVisible();
  results.cachedReopenMs = Date.now() - t;
  results.cacheMetrics = JSON.stringify(await page.evaluate(() => (globalThis as { __lanesMetrics?: unknown }).__lanesMetrics));

  // Memory after loading/scrolling (Chrome only).
  results.jsHeapMB = await page.evaluate(() => Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576));

  // Large diff: a commit changing a 20,000-line file.
  const big = join(s.fixturesRoot, "bigdiff");
  mkdirSync(big, { recursive: true });
  execFileSync("git", ["init", "-q", big]);
  writeFileSync(join(big, "big.txt"), Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n"));
  git(big, ["add", "."]);
  git(big, ["commit", "-q", "-m", "base"]);
  writeFileSync(join(big, "big.txt"), Array.from({ length: 20000 }, (_, i) => `line ${i} changed`).join("\n"));
  git(big, ["commit", "-qam", "Change every line"]);
  const b = openLocal(big);
  await page.goto(b.url);
  await expect(page.locator('[role="row"][data-row="1"]')).toBeVisible();
  const head = git(big, ["rev-parse", "HEAD"]).trim();
  t = Date.now();
  await page.goto(`${b.url.split("#")[0]}?commit=${head}&file=big.txt`);
  await expect(page.getByTestId("diff-view").locator(".diff-line").nth(20)).toBeVisible({ timeout: 15000 });
  results.largeDiffMs = Date.now() - t;
  results.largeDiffDomLines = await page.getByTestId("diff-view").locator(".diff-line").count(); // of 40,000 diff lines

  mkdirSync(join(ROOT, "test-results"), { recursive: true });
  writeFileSync(join(ROOT, "test-results/perf.json"), JSON.stringify({ at: new Date().toISOString(), budget: BUDGET, results }, null, 2));
  console.log("PERF", JSON.stringify(results));
  void context;

  expect(results.firstVisibleCommitsMs).toBeLessThan(BUDGET.firstVisibleCommitsMs);
  expect(results.firstUsableGraphMs).toBeLessThan(BUDGET.firstUsableGraphMs);
  expect(results.scrollAvgFps).toBeGreaterThan(BUDGET.scrollAvgFps);
  expect(results.paletteInputP95Ms).toBeLessThan(BUDGET.paletteInputP95Ms);
  expect(results.commitSelectionMs).toBeLessThan(BUDGET.commitSelectionMs);
  expect(results.branchFilterMs).toBeLessThan(BUDGET.branchFilterMs);
  expect(results.cachedReopenMs).toBeLessThan(BUDGET.cachedReopenMs);
  expect(results.largeDiffMs).toBeLessThan(BUDGET.largeDiffMs);
  expect(results.domRows as number).toBeLessThan(120); // virtualized
});
