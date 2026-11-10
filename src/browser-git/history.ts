// Commit graph walk and ordering (git's --date-order / --topo-order / --author-date-order).

import type { CommitOrder } from "../core/types.ts";
import { AppError } from "../core/types.ts";
import type { ObjectDatabase } from "./objects.ts";
import { parseCommit, subjectOf, type PersonTz } from "./parse.ts";

export interface CommitNode {
  hash: string;
  parents: string[];
  tree: string;
  author: PersonTz;
  committer: PersonTz;
  subject: string;
}

/** Throws CANCELLED when aborted; periodically yields to the event loop so cancel messages can arrive. */
export class Ticker {
  private last = Date.now();
  private readonly signal?: AbortSignal;
  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }
  async tick(): Promise<void> {
    if (this.signal?.aborted) throw new AppError("CANCELLED", "Request was cancelled");
    const now = Date.now();
    if (now - this.last > 30) {
      this.last = now;
      await new Promise((r) => setTimeout(r, 0));
      if (this.signal?.aborted) throw new AppError("CANCELLED", "Request was cancelled");
    }
  }
}

/** Parsed commits, kept for the lifetime of the repository (commits are immutable). */
export class CommitStore {
  private readonly nodes = new Map<string, CommitNode>();
  private readonly odb: ObjectDatabase;
  shallow: Set<string>;

  constructor(odb: ObjectDatabase, shallow: Set<string> = new Set()) {
    this.odb = odb;
    this.shallow = shallow;
  }

  get size(): number {
    return this.nodes.size;
  }

  // Identities repeat across thousands of commits: share their strings.
  private readonly strings = new Map<string, string>();
  private intern(s: string): string {
    const hit = this.strings.get(s);
    if (hit !== undefined) return hit;
    if (this.strings.size < 100_000) this.strings.set(s, s);
    return s;
  }
  private person(p: PersonTz): PersonTz {
    return { name: this.intern(p.name), email: this.intern(p.email), date: p.date, tz: this.intern(p.tz) };
  }

  peek(hash: string): CommitNode | undefined {
    return this.nodes.get(hash);
  }

  async get(hash: string): Promise<CommitNode | null> {
    const n = this.nodes.get(hash);
    if (n !== undefined) return n;
    const o = await this.odb.read(hash, { cache: false });
    let node: CommitNode | null = null;
    if (o && o.type === "commit") {
      const c = parseCommit(o.data);
      node = {
        hash,
        parents: this.shallow.has(hash) ? [] : c.parents,
        tree: c.tree,
        author: this.person(c.author),
        committer: this.person(c.committer),
        subject: subjectOf(c.message),
      };
    }
    // Missing commits are not cached: they may appear later (fetch, new pack).
    if (node) this.nodes.set(hash, node);
    return node;
  }

  async require(hash: string): Promise<CommitNode> {
    const n = await this.get(hash);
    if (!n) throw new AppError("COMMIT_NOT_FOUND", `Commit ${hash} not found`);
    return n;
  }
}

export interface Ordering {
  nodes: CommitNode[];
  /** Node indices in display order. */
  order: Int32Array;
  firstParent: boolean;
  /** Start commits of the walk. */
  tips: string[];
  /** hash → node index, built on demand. */
  index?: Map<string, number>;
}

export function indexOf(o: Ordering, hash: string): number | undefined {
  if (!o.index) {
    o.index = new Map();
    for (let i = 0; i < o.nodes.length; i++) o.index.set(o.nodes[i]!.hash, i);
  }
  return o.index.get(hash);
}

/** Walks every commit reachable from `tips` (following only first parents when requested). */
export async function walkCommits(store: CommitStore, tips: string[], firstParent: boolean, ticker: Ticker): Promise<CommitNode[]> {
  const seen = new Set<string>();
  const nodes: CommitNode[] = [];
  let frontier: string[] = [];
  for (const t of tips) {
    if (!seen.has(t)) {
      seen.add(t);
      frontier.push(t);
    }
  }
  let count = 0;
  while (frontier.length) {
    const batch = frontier.length > 256 ? frontier.splice(frontier.length - 256) : frontier;
    if (batch === frontier) frontier = [];
    const loaded = await Promise.all(batch.map((h) => store.peek(h) ?? store.get(h)));
    for (const n of loaded) {
      if (!n) continue; // missing object (partial clone / corrupt): treat as a boundary
      nodes.push(n);
      const ps = n.parents;
      const lim = firstParent ? Math.min(1, ps.length) : ps.length;
      for (let i = 0; i < lim; i++) {
        const p = ps[i]!;
        if (!seen.has(p)) {
          seen.add(p);
          frontier.push(p);
        }
      }
    }
    count += batch.length;
    if (count >= 4096) {
      count = 0;
      await ticker.tick();
    }
  }
  return nodes;
}

/**
 * Kahn's algorithm: a commit is emitted only after all of its children. Ready commits are taken
 * newest-first by committer (or author) date for "date"/"author-date"; "topo" uses git's LIFO order.
 */
export function orderCommits(nodes: CommitNode[], tips: string[], order: CommitOrder, firstParent: boolean): Int32Array {
  const n = nodes.length;
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(nodes[i]!.hash, i);
  // CSR parent edges restricted to the set.
  const start = new Int32Array(n + 1);
  const edges: number[] = [];
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    start[i] = edges.length;
    const ps = nodes[i]!.parents;
    const lim = firstParent ? Math.min(1, ps.length) : ps.length;
    for (let k = 0; k < lim; k++) {
      const j = index.get(ps[k]!);
      if (j === undefined) continue;
      edges.push(j);
      indeg[j]!++;
    }
  }
  start[n] = edges.length;
  const date = new Float64Array(n);
  for (let i = 0; i < n; i++) date[i] = order === "author-date" ? nodes[i]!.author.date : nodes[i]!.committer.date;

  const out = new Int32Array(n);
  let o = 0;
  // Initial ready set in tip order, then discovery order (matches git's insertion order for ties).
  const initial: number[] = [];
  const queued = new Uint8Array(n);
  for (const t of tips) {
    const i = index.get(t);
    if (i !== undefined && indeg[i] === 0 && !queued[i]) {
      queued[i] = 1;
      initial.push(i);
    }
  }
  for (let i = 0; i < n; i++) if (indeg[i] === 0 && !queued[i]) initial.push(i);

  if (order === "topo") {
    // git: prio_queue without comparator is a LIFO stack; initial tips are reversed so the
    // newest tip is popped first.
    initial.sort((x, y) => date[y]! - date[x]!);
    const stack = initial.reverse();
    while (stack.length) {
      const c = stack.pop()!;
      out[o++] = c;
      for (let e = start[c]!; e < start[c + 1]!; e++) {
        const p = edges[e]!;
        if (--indeg[p]! === 0) stack.push(p);
      }
    }
    return out;
  }

  // Binary max-heap on (date desc, insertion seq asc).
  const heap = new Int32Array(n);
  const seq = new Float64Array(n);
  let size = 0;
  let counter = 0;
  const less = (x: number, y: number) => date[x]! > date[y]! || (date[x] === date[y] && seq[x]! < seq[y]!);
  const push = (v: number) => {
    seq[v] = counter++;
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(v, heap[p]!)) break;
      heap[i] = heap[p]!;
      i = p;
    }
    heap[i] = v;
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap[--size]!;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) break;
      const r = l + 1;
      const c = r < size && less(heap[r]!, heap[l]!) ? r : l;
      if (!less(heap[c]!, last)) break;
      heap[i] = heap[c]!;
      i = c;
    }
    heap[i] = last;
    return top;
  };
  for (const i of initial) push(i);
  while (size) {
    const c = pop();
    out[o++] = c;
    for (let e = start[c]!; e < start[c + 1]!; e++) {
      const p = edges[e]!;
      if (--indeg[p]! === 0) push(p);
    }
  }
  if (o !== n) throw new AppError("INTERNAL", "Commit graph contains a cycle");
  return out;
}
