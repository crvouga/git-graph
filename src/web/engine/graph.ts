// The commit graph, computed from what Zero has synced: the commits of the window, the refs, the
// view's history query and the working-tree status. Pure (no DOM, no worker globals) so it runs in
// the engine worker and in unit tests.
//
// Order: every commit reachable from the query's tips inside the synced window, in git's
// --date-order / --topo-order / --author-date-order (orderCommits). Commits whose parents are not
// synced yet end the graph with dangling lines; the next window extends it.

import { GraphLayout, NODE_NORMAL, NODE_STASH, NODE_WORKING } from "../../core/graph/layout.ts";
import type { Commit, HistoryQuery, RefsSnapshot, WorkingTreeStatus } from "../../core/types.ts";
import { orderCommits, type CommitNode } from "../../browser-git/history.ts";
import type { LayoutChunk, RowCommit } from "./protocol.ts";

export interface GraphInput {
  refs: RefsSnapshot | null;
  query: HistoryQuery;
  status: WorkingTreeStatus | null;
  /** Every commit of the repository is in `commits` (history complete and fully synced). */
  complete: boolean;
}

export interface GraphOutput {
  rows: RowCommit[];
  layout: LayoutChunk;
  complete: boolean;
}

/** Commits of the query's tips: named refs / hashes, or every ref the display flags allow. */
export function tipsFor(refs: RefsSnapshot | null, q: HistoryQuery, has: (hash: string) => boolean): string[] {
  if (!refs) return [];
  const out: string[] = [];
  const add = (h: string | undefined) => {
    if (h && !out.includes(h)) out.push(h);
  };
  const head = refs.head.kind === "branch" || refs.head.kind === "detached" ? refs.head.commit : undefined;
  if (q.refs.length) {
    for (const name of q.refs) {
      const r = refs.refs.find((x) => x.short === name || x.name === name || x.name === `refs/heads/${name}` || x.name === `refs/tags/${name}`);
      if (r) add(r.commit);
      else if (name === "HEAD") add(head);
      else if (/^[0-9a-f]{40,64}$/i.test(name)) add(name.toLowerCase());
    }
    return out;
  }
  add(head);
  for (const r of refs.refs) {
    if (r.kind === "remote" && !q.includeRemotes) continue;
    if (r.kind === "tag" && !q.includeTags) continue;
    if (r.kind === "stash" && !q.includeStashes) continue;
    if (r.symbolicTarget) continue;
    if (has(r.commit)) add(r.commit);
  }
  return out;
}

export class Graph {
  private readonly commits = new Map<string, Commit>();
  private rows: RowCommit[] = [];
  private haystack: string[] = [];

  get size(): number {
    return this.commits.size;
  }

  has(hash: string): boolean {
    return this.commits.has(hash);
  }

  clear() {
    this.commits.clear();
    this.rows = [];
    this.haystack = [];
  }

  add(cs: readonly Commit[]) {
    for (const c of cs) this.commits.set(c.hash, c);
  }

  remove(hashes: readonly string[]) {
    for (const h of hashes) this.commits.delete(h);
  }

  compute(input: GraphInput): GraphOutput {
    const { refs, query } = input;
    const stashes = new Set((refs?.refs ?? []).filter((r) => r.kind === "stash").map((r) => r.commit));
    // A stash's extra parents (index, untracked) are implementation details: never shown.
    const hidden = new Set<string>();
    for (const s of stashes) for (const p of this.commits.get(s)?.parents.slice(1) ?? []) hidden.add(p);

    const tips = tipsFor(refs, query, (h) => this.commits.has(h)).filter((h) => this.commits.has(h));
    const nodes: Commit[] = [];
    const seen = new Set<string>();
    const stack = [...tips];
    for (const t of tips) seen.add(t);
    while (stack.length) {
      const c = this.commits.get(stack.pop()!);
      if (!c) continue;
      nodes.push(c);
      const ps = query.firstParent ? c.parents.slice(0, 1) : c.parents;
      for (const p of ps) {
        if (seen.has(p) || hidden.has(p) || !this.commits.has(p)) continue;
        seen.add(p);
        stack.push(p);
      }
    }
    const order = orderCommits(nodes as unknown as CommitNode[], tips, query.order, query.firstParent);
    const rows: RowCommit[] = [];
    const w = this.workingRow(input, seen);
    if (w) rows.push(w);
    for (let i = 0; i < order.length; i++) {
      const c = nodes[order[i]!]!;
      rows.push({ ...c, kind: stashes.has(c.hash) ? NODE_STASH : NODE_NORMAL });
    }
    const layout = new GraphLayout({ firstParent: query.firstParent });
    layout.hide(hidden);
    layout.append(rows);
    this.rows = rows;
    this.haystack = rows.map((c) => `${c.hash} ${c.subject} ${c.author.name} ${c.author.email}`.toLowerCase());
    return { rows, layout: layout.snapshotFrom(0), complete: input.complete };
  }

  private workingRow(input: GraphInput, shown: Set<string>): RowCommit | null {
    const s = input.status;
    const h = input.refs?.head;
    if (!s || !h || h.kind === "none" || h.kind === "unborn") return null;
    const n = s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length;
    if (n === 0) return null;
    // Only with HEAD in the displayed history (Git Graph behaviour with branch filters).
    if (!shown.has(h.commit) && (input.query.refs.length || this.commits.size === 0)) return null;
    const me = { name: "*", email: "", date: Math.floor(Date.now() / 1000) };
    return { hash: "working", parents: [h.commit], author: me, committer: me, subject: `Uncommitted Changes (${n})`, kind: NODE_WORKING, changes: n };
  }

  /** Row indices whose hash, subject, author or ref matches. */
  search(text: string, refNames: (hash: string) => string[] = () => []): number[] {
    const t = text.trim().toLowerCase();
    if (!t) return [];
    const out: number[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.haystack[i]!.includes(t) || refNames(this.rows[i]!.hash).some((n) => n.toLowerCase().includes(t))) out.push(i);
    }
    return out;
  }
}
