import { describe, expect, it } from "vitest";
import { Graph, tipsFor } from "../../src/web/engine/graph.ts";
import { DEFAULT_HISTORY_QUERY, type Commit, type Ref, type RefsSnapshot } from "../../src/core/types.ts";
import { NODE_STASH, NODE_WORKING } from "../../src/core/graph/layout.ts";

const h = (n: number) => n.toString(16).padStart(40, "0");
function c(n: number, parents: number[], date: number, subject = `c${n}`): Commit {
  const p = { name: "A", email: "a@x", date };
  return { hash: h(n), parents: parents.map(h), author: p, committer: p, subject };
}
function ref(name: string, kind: Ref["kind"], commit: number, short = name): Ref {
  return { name, kind, short, target: h(commit), commit: h(commit) };
}
function snap(refs: Ref[], head = 0): RefsSnapshot {
  return { head: head ? { kind: "branch", ref: "refs/heads/main", commit: h(head) } : { kind: "none" }, refs, version: "v" };
}

// 1 ← 2 ← 3 (main)      1 ← 4 (feature)      5 = merge(3, 4) on develop
const commits = [c(1, [], 100), c(2, [1], 200), c(3, [2], 300), c(4, [1], 250), c(5, [3, 4], 400)];
const refs = snap([ref("refs/heads/main", "head", 3, "main"), ref("refs/heads/feature", "head", 4, "feature"), ref("refs/heads/develop", "head", 5, "develop")], 3);

describe("Graph", () => {
  it("orders reachable commits newest first, children before parents", () => {
    const g = new Graph();
    g.add(commits);
    const out = g.compute({ refs, query: DEFAULT_HISTORY_QUERY, status: null, complete: true });
    expect(out.rows.map((r) => r.subject)).toEqual(["c5", "c3", "c4", "c2", "c1"]);
    expect(out.complete).toBe(true);
    expect(out.layout.nodeLane.length).toBe(5);
  });

  it("filters to the query's branches and follows first parents on request", () => {
    const g = new Graph();
    g.add(commits);
    expect(g.compute({ refs, query: { ...DEFAULT_HISTORY_QUERY, refs: ["feature"] }, status: null, complete: true }).rows.map((r) => r.subject)).toEqual(["c4", "c1"]);
    expect(g.compute({ refs, query: { ...DEFAULT_HISTORY_QUERY, refs: ["develop"], firstParent: true }, status: null, complete: true }).rows.map((r) => r.subject)).toEqual(["c5", "c3", "c2", "c1"]);
  });

  it("ends the graph at commits whose parents are not synced yet", () => {
    const g = new Graph();
    g.add(commits.filter((x) => x.subject !== "c1"));
    const out = g.compute({ refs, query: DEFAULT_HISTORY_QUERY, status: null, complete: false });
    expect(out.rows.map((r) => r.subject)).toEqual(["c5", "c3", "c4", "c2"]);
    g.add([commits[0]!]);
    expect(g.compute({ refs, query: DEFAULT_HISTORY_QUERY, status: null, complete: true }).rows).toHaveLength(5);
  });

  it("hides a stash's index commit and marks the stash", () => {
    const g = new Graph();
    g.add([...commits, c(6, [3], 500, "index on main"), c(7, [3, 6], 501, "WIP on main")]);
    const r = snap([...refs.refs, ref("refs/stash", "stash", 7, "stash@{0}")], 3);
    const out = g.compute({ refs: r, query: DEFAULT_HISTORY_QUERY, status: null, complete: true });
    expect(out.rows.map((x) => x.subject)).not.toContain("index on main");
    expect(out.rows.find((x) => x.subject === "WIP on main")!.kind).toBe(NODE_STASH);
  });

  it("adds the uncommitted-changes row above HEAD", () => {
    const g = new Graph();
    g.add(commits);
    const status = { staged: [{ path: "a", status: "M" as const }], unstaged: [], untracked: ["b"], conflicted: [], operation: null };
    const out = g.compute({ refs, query: DEFAULT_HISTORY_QUERY, status, complete: true });
    expect(out.rows[0]!.kind).toBe(NODE_WORKING);
    expect(out.rows[0]!.parents).toEqual([h(3)]);
    expect(out.rows[0]!.subject).toBe("Uncommitted Changes (2)");
  });

  it("searches subjects, hashes and ref names", () => {
    const g = new Graph();
    g.add(commits);
    g.compute({ refs, query: DEFAULT_HISTORY_QUERY, status: null, complete: true });
    expect(g.search("c4")).toEqual([2]);
    expect(g.search(h(5).slice(-6))).toEqual([0]);
    expect(g.search("develop", (x) => (x === h(5) ? ["develop"] : []))).toEqual([0]);
  });
});

describe("tipsFor", () => {
  it("respects the display flags", () => {
    const r = snap([ref("refs/heads/main", "head", 3, "main"), ref("refs/remotes/origin/x", "remote", 4, "origin/x"), ref("refs/tags/v1", "tag", 2, "v1")], 3);
    const all = tipsFor(r, DEFAULT_HISTORY_QUERY, () => true);
    expect(all).toEqual([h(3), h(4), h(2)]);
    expect(tipsFor(r, { ...DEFAULT_HISTORY_QUERY, includeRemotes: false, includeTags: false }, () => true)).toEqual([h(3)]);
    expect(tipsFor(r, { ...DEFAULT_HISTORY_QUERY, refs: ["v1", h(4)] }, () => true)).toEqual([h(2), h(4)]);
  });
});
