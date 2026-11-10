// 100k-commit history: first page latency and full streamed paging. Uses .fixtures/large-100000
// (generated once by make-fixtures; read-only here). A commit-graph variant is measured on a copy.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeLarge } from "../fixtures/make-fixtures.ts";
import { CliGitAdapter } from "../../src/companion/git-adapter.ts";
import { DEFAULT_HISTORY_QUERY, type HistoryQuery } from "../../src/core/types.ts";

async function measure(path: string) {
  const a = await CliGitAdapter.open(path, "large");
  const q: HistoryQuery = { ...DEFAULT_HISTORY_QUERY };
  await a.refsLite(); // warm the git binary / page cache like a running companion would be
  const t0 = performance.now();
  let page = await a.history(q, null, 300);
  const first = performance.now() - t0;
  const seen = new Set(page.commits.map((c) => c.hash));
  let n = page.commits.length;
  while (page.cursor) {
    page = await a.history(q, page.cursor, 5000);
    for (const c of page.commits) seen.add(c.hash);
    n += page.commits.length;
  }
  const full = performance.now() - t0;
  a.dispose();
  return { first: Math.round(first), full: Math.round(full), n, unique: seen.size, total: page.total };
}

describe("100k history", () => {
  let large: string;
  let copy: string;
  beforeAll(async () => {
    large = await makeLarge(100_000);
    copy = realpathSync(mkdtempSync(join(tmpdir(), "lanes-perf-")));
  }, 600_000);
  afterAll(() => rmSync(copy, { recursive: true, force: true }));

  it("first page and full stream (no commit-graph: git must sort the whole graph first)", async () => {
    const r = await measure(large);
    console.log(`[history 100k, no commit-graph] first page (300) ${r.first} ms, full stream ${r.full} ms, ${r.n} commits`);
    expect(r.n).toBe(100_000);
    expect(r.unique).toBe(100_000);
    expect(r.total).toBe(100_000);
    expect(r.first).toBeLessThan(2000);
    expect(r.full).toBeLessThan(10_000);
  });

  it("first page with a commit-graph (what `git gc` / maintenance produce)", async () => {
    const repo = join(copy, "large");
    cpSync(large, repo, { recursive: true });
    execFileSync("git", ["commit-graph", "write", "--reachable"], { cwd: repo, stdio: "ignore" });
    const r = await measure(repo);
    console.log(`[history 100k, commit-graph] first page (300) ${r.first} ms, full stream ${r.full} ms, ${r.n} commits`);
    expect(r.n).toBe(100_000);
    expect(r.first).toBeLessThan(300);
  });
});
