import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { HistoryMerge, type PageLoader } from "../../src/github/history.ts";
import { parsePatch, toFileDiff } from "../../src/github/patch.ts";
import type { Commit } from "../../src/core/types.ts";

/** Random DAG where each commit's date is strictly greater than its parents' (no clock skew). */
function buildDag(seed: number[], n: number) {
  const commits: Commit[] = [];
  let r = 0;
  const rnd = () => seed[r++ % seed.length]! / 1000;
  for (let i = 0; i < n; i++) {
    const parents: string[] = [];
    if (i > 0 && rnd() > 0.05) parents.push(commits[Math.floor(rnd() * i)]!.hash);
    if (i > 1 && rnd() > 0.8) {
      const p2 = commits[Math.floor(rnd() * i)]!.hash;
      if (!parents.includes(p2)) parents.push(p2);
    }
    const date = 1000 + i * 10 + Math.floor(rnd() * 5);
    const hash = (i + 1).toString(16).padStart(40, "0");
    commits.push({ hash, parents, subject: `c${i}`, author: { name: "a", email: "a", date }, committer: { name: "a", email: "a", date } });
  }
  return commits;
}

/** GitHub-like `git log` walk (date-ordered priority queue), paged. */
function loaderFor(commits: Commit[], pageSize: number, counter: { n: number }): PageLoader {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const walks = new Map<string, Commit[]>();
  const walk = (tip: string) => {
    let w = walks.get(tip);
    if (w) return w;
    w = [];
    const seen = new Set([tip]);
    const q = [byHash.get(tip)!];
    while (q.length) {
      q.sort((a, b) => b.committer.date - a.committer.date);
      const c = q.shift()!;
      w.push(c);
      for (const p of c.parents) if (!seen.has(p)) (seen.add(p), q.push(byHash.get(p)!));
    }
    walks.set(tip, w);
    return w;
  };
  return async (tip, page) => {
    counter.n++;
    const w = walk(tip);
    const slice = w.slice((page - 1) * pageSize, page * pageSize);
    return { commits: slice, last: page * pageSize >= w.length };
  };
}

function reachable(commits: Commit[], tips: string[]): Set<string> {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const s = new Set<string>();
  const st = [...tips];
  while (st.length) {
    const x = st.pop()!;
    if (s.has(x)) continue;
    s.add(x);
    st.push(...byHash.get(x)!.parents);
  }
  return s;
}

describe("HistoryMerge (property)", () => {
  it("emits every reachable commit once, children before parents, for any page size and limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 20, maxLength: 60 }),
        fc.integer({ min: 2, max: 80 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 30 }),
        async (seed, n, tipCount, pageSize, limit) => {
          const commits = buildDag(seed, n);
          const tips = [...new Set(Array.from({ length: tipCount }, (_, i) => commits[Math.max(0, n - 1 - ((seed[i]! * 7) % n))]!.hash))];
          const counter = { n: 0 };
          const m = new HistoryMerge(
            tips.map((t) => ({ id: t, tip: t })),
            loaderFor(commits, pageSize, counter),
          );
          const out: Commit[] = [];
          for (let guard = 0; guard < 1000; guard++) {
            const page = await m.next(limit);
            out.push(...page);
            if (page.length < limit) break;
          }
          const want = reachable(commits, tips);
          expect(out.length).toBe(want.size);
          expect(new Set(out.map((c) => c.hash))).toEqual(want);
          const idx = new Map(out.map((c, i) => [c.hash, i]));
          for (const [i, c] of out.entries()) for (const p of c.parents) expect(idx.get(p)!).toBeGreaterThan(i);
          expect(m.stats.lateChildren).toBe(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("retires branch streams already covered by another stream (few page loads)", async () => {
    // A linear main of 500 commits and 20 branches pointing into it: only main should be paged.
    const commits: Commit[] = [];
    for (let i = 0; i < 500; i++) {
      const hash = (i + 1).toString(16).padStart(40, "0");
      commits.push({ hash, parents: i ? [commits[i - 1]!.hash] : [], subject: "", author: { name: "", email: "", date: i }, committer: { name: "", email: "", date: i } });
    }
    const counter = { n: 0 };
    const tips = [commits[499]!.hash, ...Array.from({ length: 20 }, (_, i) => commits[480 - i * 3]!.hash)];
    const m = new HistoryMerge(tips.map((t) => ({ id: t, tip: t })), loaderFor(commits, 100, counter));
    const out = await m.next(100);
    expect(out).toHaveLength(100);
    expect(counter.n).toBeLessThanOrEqual(2);
  });
});

describe("parsePatch", () => {
  it("parses hunks, line numbers and no-newline markers", () => {
    const h = parsePatch("@@ -1,3 +1,3 @@ fn\n a\n-b\n+B\n c\n@@ -10 +10,2 @@\n x\n+y\n\\ No newline at end of file");
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, header: "@@ -1,3 +1,3 @@ fn" });
    expect(h[0]!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["context", 1, 1],
      ["del", 2, undefined],
      ["add", undefined, 2],
      ["context", 3, 3],
    ]);
    expect(h[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 });
    expect(h[1]!.lines[2]).toEqual({ kind: "meta", text: "\\ No newline at end of file" });
  });

  it("flags binary and oversized files", () => {
    expect(toFileDiff({ filename: "a.png", status: "modified", additions: 0, deletions: 0, changes: 0 })).toMatchObject({ binary: true, hunks: [] });
    expect(toFileDiff({ filename: "big.txt", status: "modified", additions: 9000, deletions: 0, changes: 9000 })).toMatchObject({ binary: false, truncated: true });
    expect(toFileDiff({ filename: "b", previous_filename: "a", status: "renamed", changes: 0 })).toMatchObject({ status: "R", oldPath: "a", binary: false });
  });
});
