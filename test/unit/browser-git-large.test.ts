// Performance + correctness on a large history (.fixtures/large-100000 when present, else 20k generated).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_HISTORY_QUERY } from "../../src/core/types.ts";
import { BrowserGitRepository } from "../../src/browser-git/repo.ts";
import { fixtureEnv, makeLarge, ROOT } from "../fixtures/make-fixtures.ts";
import { NodeDirSource } from "./browser-git-node-source.ts";

let dir: string;
let tmp: string | null = null;

beforeAll(async () => {
  const big = join(ROOT, "large-100000");
  if (existsSync(join(big, ".git", "fixture-complete"))) dir = big;
  else {
    tmp = mkdtempSync(join(tmpdir(), "lanes-browser-git-large-"));
    dir = await makeLarge(20_000, tmp);
  }
}, 600_000);
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const gitLog = (args: string[]) =>
  execFileSync("git", ["log", "--format=%H", ...args], { cwd: dir, env: fixtureEnv(), encoding: "utf8", maxBuffer: 1 << 30 }).trim().split("\n");

describe("large history", () => {
  it("first page, full walk and paging match git log --date-order --all", async () => {
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const src = new NodeDirSource(dir);
    const repo = await BrowserGitRepository.open(src, "large");
    const tOpen = performance.now();
    const refs = await repo.refs();
    const tRefs = performance.now();
    const first = await repo.history(DEFAULT_HISTORY_QUERY, null, 200);
    const tFirst = performance.now();
    const all: string[] = first.commits.map((c) => c.hash);
    let cursor = first.cursor;
    let pages = 1;
    while (cursor) {
      const p = await repo.history(DEFAULT_HISTORY_QUERY, cursor, 200);
      all.push(...p.commits.map((c) => c.hash));
      cursor = p.cursor;
      pages++;
    }
    const tPaged = performance.now();
    // Warm re-query (cached ordering) and a different query on the warm commit store.
    const again = await repo.history(DEFAULT_HISTORY_QUERY, null, 200);
    const tWarm = performance.now();
    await repo.history({ ...DEFAULT_HISTORY_QUERY, firstParent: true }, null, 200);
    const tFp = performance.now();
    const heap1 = process.memoryUsage().heapUsed;

    const tGit0 = performance.now();
    const expected = gitLog(["--date-order", "--all"]);
    const tGit = performance.now() - tGit0;
    expect(all.length).toBe(expected.length);
    expect(all).toEqual(expected);
    expect(again.commits[0]!.hash).toBe(expected[0]);
    expect(gitLog(["--date-order", "--first-parent", "--all"]).slice(0, 200)).toEqual(
      (await repo.history({ ...DEFAULT_HISTORY_QUERY, firstParent: true }, null, 200)).commits.map((c) => c.hash),
    );

    const ms = (a: number, b: number) => Math.round(b - a);
    console.log(
      JSON.stringify(
        {
          historyCommits: all.length,
          refs: refs.refs.length,
          openMs: ms(t0, tOpen),
          refsMs: ms(tOpen, tRefs),
          firstPageMs: ms(tRefs, tFirst),
          coldFirstPageTotalMs: ms(t0, tFirst),
          pagingAllMs: ms(tFirst, tPaged),
          pages,
          warmFirstPageMs: ms(tPaged, tWarm),
          firstParentWarmStoreMs: ms(tWarm, tFp),
          gitLogMs: Math.round(tGit),
          heapDeltaMB: Math.round((heap1 - heap0) / 1e6),
          ...repo.stats(),
          bytesRead: src.stats.bytes,
        },
        null,
        1,
      ),
    );
  }, 120_000);

  it("ranged pack reads (huge-pack mode) give the same first page", async () => {
    const t0 = performance.now();
    const src = new NodeDirSource(dir);
    const repo = await BrowserGitRepository.open(src, "large-ranged", { wholePackLimit: 0 });
    const first = await repo.history(DEFAULT_HISTORY_QUERY, null, 200);
    const t1 = performance.now();
    expect(first.commits.map((c) => c.hash)).toEqual(gitLog(["--date-order", "--all", "-n", "200"]));
    console.log(JSON.stringify({ rangedFirstPageMs: Math.round(t1 - t0), rangeReads: src.stats.readRange, bytesRead: src.stats.bytes }));
  }, 120_000);

  it("search and fileHistory stay usable", async () => {
    const repo = await BrowserGitRepository.open(new NodeDirSource(dir), "large-search");
    await repo.history(DEFAULT_HISTORY_QUERY, null, 1);
    const t0 = performance.now();
    const hits = await repo.search({ text: "Feature 12 step", limit: 50 });
    const t1 = performance.now();
    expect(hits.length).toBeGreaterThan(0);
    const fh = await repo.fileHistory("f7.txt", null, 50);
    const t2 = performance.now();
    expect(fh.commits.map((c) => c.hash)).toEqual(gitLog(["--all", "--date-order", "-n", "50", "--", "f7.txt"]));
    console.log(JSON.stringify({ searchMs: Math.round(t1 - t0), fileHistoryFirstPageMs: Math.round(t2 - t1) }));
  }, 120_000);
});
