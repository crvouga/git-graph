// The worker sends only new rows ("append") while older history streams in. Whatever it sends,
// the UI thread must end up with exactly the rows and layout a full reset would give it.
import { describe, expect, it } from "vitest";
import { DEFAULT_HISTORY_QUERY, type Commit, type RefsSnapshot } from "../../src/core/types.ts";
import { GraphRows } from "../../src/web/engine/client.ts";
import { appendOf, remember, type Sent } from "../../src/web/engine/delta.ts";
import { Graph } from "../../src/web/engine/graph.ts";
import type { RowsMessage } from "../../src/web/engine/protocol.ts";

const h = (n: number) => n.toString(16).padStart(40, "0");
const person = (date: number) => ({ name: "A", email: "a@x", date });

/** Main line 1..n; every 10th commit merges a two-commit feature branch forked 5 commits back. */
function history(n: number): Commit[] {
  const out: Commit[] = [];
  let id = 1;
  const main: number[] = [];
  for (let i = 0; i < n; i++) {
    const parents: number[] = main.length ? [main[main.length - 1]!] : [];
    if (i % 10 === 9 && main.length > 5) {
      const base = main[main.length - 5]!;
      const f1 = id++;
      const f2 = id++;
      out.push({ hash: h(f1), parents: [h(base)], author: person(f1), committer: person(f1), subject: `f${f1}` });
      out.push({ hash: h(f2), parents: [h(f1)], author: person(f2), committer: person(f2), subject: `f${f2}` });
      parents.push(f2);
    }
    const m = id++;
    out.push({ hash: h(m), parents: parents.map(h), author: person(m), committer: person(m), subject: `m${m}` });
    main.push(m);
  }
  return out;
}

function snapshot(rows: GraphRows) {
  return {
    hashes: rows.commits.map((c) => c.hash),
    lanes: Array.from(rows.nodeLane.subarray(0, rows.length)),
    colors: Array.from(rows.nodeColor.subarray(0, rows.length)),
    edges: rows.commits.map((_, r) => Array.from(rows.rowEdges(r))),
    tail: Array.from(rows.tail),
    width: rows.width,
    complete: rows.complete,
  };
}

describe("graph worker deltas", () => {
  it("streams older history as appends that match a full reset", () => {
    const all = history(400).sort((a, b) => b.committer.date - a.committer.date);
    const head = all[0]!;
    const refs: RefsSnapshot = { head: { kind: "branch", ref: "refs/heads/main", commit: head.hash }, refs: [{ name: "refs/heads/main", kind: "head", short: "main", target: head.hash, commit: head.hash }], version: "v" };
    const g = new Graph();
    const viaDeltas = new GraphRows();
    const viaResets = new GraphRows();
    let sent: Sent | null = null;
    let appends = 0;
    for (let at = 0; at < all.length; at += 37) {
      g.add(all.slice(at, at + 37));
      const complete = at + 37 >= all.length;
      const out = g.compute({ refs, query: DEFAULT_HISTORY_QUERY, status: null, complete });
      const delta = sent ? appendOf(sent, out.rows, out.layout, refs) : null;
      sent = remember(out.rows, out.layout, refs, out.complete);
      const reset: RowsMessage = { t: "rows", session: 1, kind: "reset", commits: out.rows, layout: out.layout, complete: out.complete, stale: false, refs };
      if (delta) {
        appends++;
        viaDeltas.apply({ t: "rows", session: 1, kind: "append", commits: delta.rows, layout: delta.layout, complete: out.complete });
      } else viaDeltas.apply(reset);
      viaResets.apply(reset);
      expect(snapshot(viaDeltas)).toEqual(snapshot(viaResets));
    }
    expect(viaResets.length).toBe(all.length);
    expect(appends).toBeGreaterThan(0);
  });

  it("falls back to a reset when rows above the new ones change", () => {
    const all = history(30).sort((a, b) => b.committer.date - a.committer.date);
    const head = all[0]!;
    const refs: RefsSnapshot = { head: { kind: "branch", ref: "refs/heads/main", commit: head.hash }, refs: [{ name: "refs/heads/main", kind: "head", short: "main", target: head.hash, commit: head.hash }], version: "v" };
    const g = new Graph();
    g.add(all.slice(1));
    const older = g.compute({ refs: { ...refs, refs: [{ ...refs.refs[0]!, target: all[1]!.hash, commit: all[1]!.hash }] }, query: DEFAULT_HISTORY_QUERY, status: null, complete: true });
    const sent = remember(older.rows, older.layout, refs, true);
    g.add([head]);
    const out = g.compute({ refs, query: DEFAULT_HISTORY_QUERY, status: null, complete: true });
    // A new commit on top changes every row's position: never an append.
    expect(appendOf(sent, out.rows, out.layout, refs)).toBeNull();
    // A copy of the same refs (every state message clones them) still allows an append;
    // a different refs version never does.
    expect(appendOf(remember(out.rows, out.layout, refs, true), out.rows, out.layout, structuredClone(refs))).not.toBeNull();
    expect(appendOf(remember(out.rows, out.layout, refs, true), out.rows, out.layout, { ...refs, version: "v2" })).toBeNull();
  });
});
