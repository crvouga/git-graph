// Property-based tests for the Myers line diff and the date-order commit ordering.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyHunks, lineDiff, type LineFile } from "../../src/browser-git/myers.ts";
import { orderCommits, type CommitNode } from "../../src/browser-git/history.ts";
import { applyDelta } from "../../src/browser-git/objects.ts";

const file = (lines: string[], noEol = false): LineFile => ({ lines, noEol });

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

const linesArb = fc.array(fc.constantFrom("a", "b", "c", "d", "", "}", "  x"), { maxLength: 60 });

describe("Myers diff", () => {
  it("applying the hunks to the old text yields the new text, with a minimal edit count", () => {
    fc.assert(
      fc.property(linesArb, linesArb, fc.integer({ min: 0, max: 4 }), (a, b, context) => {
        const r = lineDiff(file(a), file(b), context);
        expect(applyHunks(a, r.hunks)).toEqual(b);
        expect(r.additions + r.deletions).toBe(a.length + b.length - 2 * lcs(a, b));
        // Header counts and line numbers are consistent.
        for (const h of r.hunks) {
          expect(h.lines.filter((l) => l.kind !== "add" && l.kind !== "meta").length).toBe(h.oldLines);
          expect(h.lines.filter((l) => l.kind !== "del" && l.kind !== "meta").length).toBe(h.newLines);
        }
        // Hunks are ordered and non-overlapping.
        for (let i = 1; i < r.hunks.length; i++) expect(r.hunks[i]!.oldStart).toBeGreaterThan(r.hunks[i - 1]!.oldStart + r.hunks[i - 1]!.oldLines - 1);
      }),
      { numRuns: 500 },
    );
  });

  it("handles large inputs and the work budget fallback", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `l${i % 997}`);
    const b = a.map((l, i) => (i % 101 === 0 ? `changed ${i}` : l)).filter((_, i) => i % 333 !== 0);
    const r = lineDiff(file(a), file(b));
    expect(applyHunks(a, r.hunks)).toEqual(b);
  });

  it("marks a missing final newline", () => {
    const r = lineDiff(file(["a", "b"], true), file(["a", "b"], false));
    expect(r.hunks[0]!.lines.map((l) => l.kind)).toEqual(["context", "del", "meta", "add"]);
  });
});

describe("date-order invariant on random DAGs", () => {
  // Random DAG: node i may have parents among nodes with larger index (older), random dates (clock skew allowed).
  const dagArb = fc.integer({ min: 1, max: 80 }).chain((n) =>
    fc.tuple(
      fc.constant(n),
      fc.array(fc.array(fc.nat(), { maxLength: 3 }), { minLength: n, maxLength: n }),
      fc.array(fc.integer({ min: 0, max: 50 }), { minLength: n, maxLength: n }),
      fc.array(fc.integer({ min: 0, max: 50 }), { minLength: n, maxLength: n }),
    ),
  );
  const build = ([n, ps, dates, adates]: [number, number[][], number[], number[]]): CommitNode[] =>
    Array.from({ length: n }, (_, i) => {
      const parents = [...new Set(ps[i]!.filter(() => i < n - 1).map((p) => i + 1 + (p % (n - i - 1 || 1))).filter((p) => p < n))];
      const person = (d: number) => ({ name: "x", email: "x", date: d, tz: "+0000" });
      return { hash: `h${i}`, parents: parents.map((p) => `h${p}`), tree: "", author: person(adates[i]!), committer: person(dates[i]!), subject: `s${i}` };
    });

  for (const order of ["date", "topo", "author-date"] as const) {
    for (const firstParent of [false, true]) {
      it(`${order}${firstParent ? " first-parent" : ""}: permutation; no commit before any of its children`, () => {
        fc.assert(
          fc.property(dagArb, (dag) => {
            const nodes = build(dag);
            const tips = nodes.filter((_, i) => i % 7 === 0).map((n) => n.hash);
            const out = orderCommits(nodes, tips, order, firstParent);
            expect([...out].sort((x, y) => x - y)).toEqual(nodes.map((_, i) => i));
            const pos = new Int32Array(nodes.length);
            out.forEach((v, i) => (pos[v] = i));
            nodes.forEach((n, i) => {
              const ps = firstParent ? n.parents.slice(0, 1) : n.parents;
              for (const p of ps) expect(pos[i]).toBeLessThan(pos[Number(p.slice(1))]!);
            });
            if (order !== "topo") {
              // Among ready commits the newest is emitted first: whenever a commit is emitted, no other
              // ready commit (all children emitted) has a strictly newer date.
              const date = (i: number) => (order === "date" ? nodes[i]!.committer.date : nodes[i]!.author.date);
              const children = nodes.map(() => [] as number[]);
              nodes.forEach((n, i) => (firstParent ? n.parents.slice(0, 1) : n.parents).forEach((p) => children[Number(p.slice(1))]!.push(i)));
              for (let k = 0; k < out.length; k++) {
                const c = out[k]!;
                for (let r = k + 1; r < out.length; r++) {
                  const o = out[r]!;
                  if (children[o]!.every((ch) => pos[ch]! < k)) expect(date(o)).toBeLessThanOrEqual(date(c));
                }
              }
            }
          }),
          { numRuns: 200 },
        );
      });
    }
  }
});

describe("delta application", () => {
  it("rejects malformed deltas", () => {
    const base = new Uint8Array([1, 2, 3]);
    expect(() => applyDelta(base, new Uint8Array([4, 3, 0x91, 0, 3]))).toThrow(/base size/);
    expect(() => applyDelta(base, new Uint8Array([3, 3, 0x91, 2, 3]))).toThrow(/out of range/);
    expect(Array.from(applyDelta(base, new Uint8Array([3, 5, 0x90, 3, 2, 9, 9])))).toEqual([1, 2, 3, 9, 9]);
  });
});
