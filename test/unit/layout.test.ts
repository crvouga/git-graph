import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { GraphLayout, rowEdges, type LayoutCommit, type LayoutData } from "../../src/core/graph/layout.ts";

/** Random DAG in display order: commit i's parents are drawn from commits after it. */
const dagArb = fc
  .integer({ min: 1, max: 120 })
  .chain((n) =>
    fc.tuple(
      fc.constant(n),
      fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.integer({ min: 0, max: 9 })), { minLength: n, maxLength: n }),
    ),
  )
  .map(([n, picks]) => {
    const commits: LayoutCommit[] = [];
    for (let i = 0; i < n; i++) {
      const [a, b, c, k] = picks[i]!;
      const rest = n - i - 1;
      const parents: string[] = [];
      if (rest > 0 && k > 0) {
        // mostly near parents, sometimes far ones; 0-3 parents
        parents.push(`c${i + 1 + (a % Math.min(rest, k < 7 ? 2 : rest))}`);
        if (k >= 7) {
          const p = `c${i + 1 + (b % rest)}`;
          if (!parents.includes(p)) parents.push(p);
        }
        if (k === 9) {
          const p = `c${i + 1 + (c % rest)}`;
          if (!parents.includes(p)) parents.push(p);
        }
      }
      commits.push({ hash: `c${i}`, parents });
    }
    return commits;
  });

/** Follow edges from each node; return the rows of nodes reached directly (stopping at nodes). */
function reachedParents(d: LayoutData, rows: number, r: number): Set<number> {
  const out = new Set<number>();
  let frontier = new Set<number>([d.nodeLane[r]!]);
  let fromNode = true;
  for (let k = r + 1; k < rows && frontier.size; k++) {
    const e = rowEdges(d, k);
    const next = new Set<number>();
    for (let i = 0; i < e.length; i += 3) {
      if (frontier.has(e[i]!)) next.add(e[i + 1]!);
    }
    // A position equal to the node lane at row k lands on that node: record and stop there.
    const node = d.nodeLane[k]!;
    if (next.has(node)) {
      out.add(k);
      next.delete(node);
    }
    frontier = next;
    fromNode = false;
  }
  void fromNode;
  return out;
}

function check(commits: LayoutCommit[], layout: GraphLayout) {
  const d = layout.snapshot();
  const row = new Map(commits.map((c, i) => [c.hash, i]));
  for (let r = 0; r < commits.length; r++) {
    const expected = new Set(commits[r]!.parents.map((p) => row.get(p)!));
    expect(reachedParents(d, commits.length, r)).toEqual(expected);
  }
}

describe("graph layout", () => {
  it("connects every commit to exactly its parents (property)", () => {
    fc.assert(
      fc.property(dagArb, (commits) => {
        const l = new GraphLayout();
        l.append(commits);
        check(commits, l);
      }),
      { numRuns: 400 },
    );
  });

  it("is identical whether appended in one go or in pages", () => {
    fc.assert(
      fc.property(dagArb, fc.integer({ min: 1, max: 40 }), (commits, page) => {
        const a = new GraphLayout();
        a.append(commits);
        const b = new GraphLayout();
        for (let i = 0; i < commits.length; i += page) b.append(commits.slice(i, i + page));
        expect(b.snapshot()).toEqual(a.snapshot());
      }),
      { numRuns: 200 },
    );
  });

  it("rebase (prepend new commits) equals a full recompute and reuses rows", () => {
    fc.assert(
      fc.property(dagArb, fc.integer({ min: 1, max: 5 }), (commits, newCount) => {
        // New commits on top of the first commit (like pushes to the newest branch).
        const prefix: LayoutCommit[] = [];
        for (let i = 0; i < newCount; i++) prefix.push({ hash: `n${i}`, parents: [i === newCount - 1 ? commits[0]!.hash : `n${i + 1}`] });
        const old = new GraphLayout({ checkpointEvery: 4 });
        old.append(commits);
        const { layout } = GraphLayout.rebase(old, commits, prefix, 0);
        const full = new GraphLayout({ checkpointEvery: 4 });
        full.append([...prefix, ...commits]);
        expect(layout.snapshot()).toEqual(full.snapshot());
      }),
      { numRuns: 200 },
    );
  });

  it("reuses old rows on a linear push", () => {
    const commits: LayoutCommit[] = Array.from({ length: 1000 }, (_, i) => ({ hash: `c${i}`, parents: i < 999 ? [`c${i + 1}`] : [] }));
    const old = new GraphLayout();
    old.append(commits);
    const { layout, reused } = GraphLayout.rebase(old, commits, [{ hash: "new", parents: ["c0"] }], 0);
    expect(reused).toBeGreaterThan(900);
    expect(layout.rows).toBe(1001);
  });

  it("drops hidden parents and keeps only first parent in first-parent mode", () => {
    const l = new GraphLayout({ firstParent: true });
    l.append([
      { hash: "m", parents: ["a", "b"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    const d = l.snapshot();
    expect(Array.from(d.nodeLane)).toEqual([0, 1, 0]);
  });

  it("lays out 100k commits quickly", () => {
    const n = 100_000;
    const commits: LayoutCommit[] = [];
    for (let i = 0; i < n; i++) {
      const parents = i + 1 < n ? [`c${i + 1}`] : [];
      if (i % 7 === 0 && i + 5 < n) parents.push(`c${i + 5}`);
      commits.push({ hash: `c${i}`, parents });
    }
    const t = performance.now();
    const l = new GraphLayout();
    l.append(commits);
    const ms = performance.now() - t;
    console.log(`layout 100k: ${ms.toFixed(1)}ms, width ${l.width}`);
    expect(ms).toBeLessThan(1500);
  });
});
