// Deterministic, streaming commit-graph layout.
//
// Commits arrive in display order (every child before its parents). Each commit gets a lane;
// lanes never shift sideways once assigned, so vertical lines stay straight and the layout of a
// row depends only on the rows above it. That gives three properties we rely on:
//  1. Pagination: `append()` continues exactly where the previous page stopped.
//  2. Incremental refresh: when new commits are prepended, `rebase()` lays out only the new prefix
//     and splices the old rows back once the lane state converges (checked at checkpoints).
//  3. Edges always connect a commit to its parents' rows, whatever subset of refs is shown.
//
// Output is stored in flat typed arrays (bounded memory for 100k+ rows):
//   nodeLane[r]           lane of row r's node
//   edgeStart[r]..[r+1]   edges in the gap between row r-1 and row r (incoming edges of row r)
//   edges[3*i..]          (fromLane at row r-1, toLane at row r, colorAndFlags)
// Colors follow branches, Git Graph style: a lane keeps its color for its whole life, and a new
// lane takes the lowest color that is free (released on an earlier row).

export const EDGE_DASHED = 0x100;
export const EDGE_COLOR_MASK = 0xff;

export const NODE_NORMAL = 0;
export const NODE_WORKING = 1;
export const NODE_STASH = 2;

export interface LayoutCommit {
  hash: string;
  parents: readonly string[];
  kind?: number;
}

interface Slot {
  expect: string;
  /** Lanes (at the previous row) whose lines flow into this lane. */
  srcs: number[];
  dashed: boolean;
  color: number;
}

type LaneState = (Slot | null)[];

export interface LayoutOptions {
  firstParent?: boolean;
  palette?: number;
  checkpointEvery?: number;
}

interface Checkpoint {
  lanes: LaneState;
  /** Per color: in-use count, and whether it was released on the previous row (not yet reusable). */
  colors: string;
}

function cloneState(s: LaneState): LaneState {
  return s.map((x) => (x ? { expect: x.expect, srcs: x.srcs.slice(), dashed: x.dashed, color: x.color } : null));
}

function sameState(a: LaneState, b: LaneState): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) {
      if (x !== y) return false;
      continue;
    }
    if (x.expect !== y.expect || x.dashed !== y.dashed || x.color !== y.color || x.srcs.length !== y.srcs.length) return false;
    for (let j = 0; j < x.srcs.length; j++) if (x.srcs[j] !== y.srcs[j]) return false;
  }
  return true;
}

class GrowI16 {
  a: Int16Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Int16Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Int16Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  view() {
    return this.a.subarray(0, this.n);
  }
}

class GrowU32 {
  a: Uint32Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Uint32Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  view() {
    return this.a.subarray(0, this.n);
  }
}

/** Serializable snapshot of the visual layout (transferable typed arrays). */
export interface LayoutData {
  rows: number;
  nodeLane: Int16Array;
  /** Color index of each node (-1 = neutral, used for uncommitted changes). */
  nodeColor: Int16Array;
  /** rows+1 entries: edges of row r are edges[3*edgeStart[r] .. 3*edgeStart[r+1]). */
  edgeStart: Uint32Array;
  edges: Int16Array;
  /** Edges continuing below the last row (lanes still open). */
  tail: Int16Array;
  width: number;
}

export class GraphLayout {
  readonly palette: number;
  readonly firstParent: boolean;
  readonly checkpointEvery: number;
  private lanes: LaneState = [];
  private nodeLane = new GrowI16();
  private edgeStart = new GrowU32();
  private edges = new GrowI16();
  private checkpoints = new Map<number, Checkpoint>();
  private colorUse: number[];
  private colorFreedAt: number[];
  private nodeColor = new GrowI16();
  private kinds: number[] = [];
  /** Hashes already placed (guards against malformed orders where a parent precedes a child). */
  private placed = new Set<string>();
  private hidden = new Set<string>();
  width = 0;

  constructor(opts: LayoutOptions = {}) {
    this.palette = opts.palette ?? 12;
    this.firstParent = opts.firstParent ?? false;
    this.checkpointEvery = opts.checkpointEvery ?? 64;
    this.edgeStart.push(0);
    this.colorUse = new Array(this.palette).fill(0);
    this.colorFreedAt = new Array(this.palette).fill(-2);
  }

  private colorKey(r: number): string {
    let k = "";
    for (let c = 0; c < this.palette; c++) k += `${this.colorUse[c]}${this.colorFreedAt[c]! >= r ? "r" : ""},`;
    return k;
  }

  private takeColor(r: number): number {
    for (let c = 0; c < this.palette; c++) {
      if (this.colorUse[c] === 0 && this.colorFreedAt[c]! < r) {
        this.colorUse[c]!++;
        return c;
      }
    }
    // Palette exhausted: reuse the least-used color.
    let best = 0;
    for (let c = 1; c < this.palette; c++) if (this.colorUse[c]! < this.colorUse[best]!) best = c;
    this.colorUse[best]!++;
    return best;
  }

  private releaseColor(c: number, r: number) {
    this.colorUse[c]!--;
    if (this.colorUse[c] === 0) this.colorFreedAt[c] = r;
  }

  get rows(): number {
    return this.nodeLane.n;
  }

  /** Hide commits (e.g. stash index/untracked commits) — they are skipped and edges into them dropped. */
  hide(hashes: Iterable<string>) {
    for (const h of hashes) this.hidden.add(h);
  }

  isHidden(hash: string): boolean {
    return this.hidden.has(hash);
  }

  private firstFree(): number {
    const i = this.lanes.indexOf(null);
    return i < 0 ? this.lanes.length : i;
  }

  /** Lay out more commits below the current last row. Hidden commits must be filtered by the caller. */
  append(commits: readonly LayoutCommit[]): void {
    for (const c of commits) this.place(c);
  }

  private place(c: LayoutCommit): void {
    const r = this.nodeLane.n;
    if (r % this.checkpointEvery === 0) this.checkpoints.set(r, { lanes: cloneState(this.lanes), colors: this.colorKey(r) });
    const lanes = this.lanes;
    let m = -1;
    for (let L = 0; L < lanes.length; L++) {
      if (lanes[L]?.expect === c.hash) {
        if (m < 0) m = L;
      }
    }
    if (m < 0) m = this.firstFree();

    // Incoming edges (gap between row r-1 and row r).
    if (r > 0) {
      for (let L = 0; L < lanes.length; L++) {
        const s = lanes[L];
        if (!s) continue;
        const to = s.expect === c.hash ? m : L;
        const flags = s.color | (s.dashed ? EDGE_DASHED : 0);
        for (const src of s.srcs) {
          this.edges.push(src);
          this.edges.push(to);
          this.edges.push(flags);
          if (src + 1 > this.width) this.width = src + 1;
          if (to + 1 > this.width) this.width = to + 1;
        }
      }
    }
    this.edgeStart.push(this.edges.n / 3);
    this.nodeLane.push(m);
    const mSlot = lanes[m];
    const nodeColor = mSlot && mSlot.expect === c.hash ? mSlot.color : -1;
    this.kinds.push(c.kind ?? NODE_NORMAL);
    if (m + 1 > this.width) this.width = m + 1;

    // Lanes that converged into this commit end here; every surviving lane becomes a pass-through.
    for (let L = 0; L < lanes.length; L++) {
      const s = lanes[L];
      if (!s) continue;
      if (s.expect === c.hash) {
        if (L !== m) this.releaseColor(s.color, r);
        lanes[L] = null;
      } else s.srcs = [L];
    }
    this.placed.add(c.hash);
    // The node keeps the color of the lane it continues; a branch tip starts a new color.
    const color = nodeColor >= 0 ? nodeColor : this.takeColor(r);

    let parents = c.parents.filter((p) => !this.hidden.has(p) && !this.placed.has(p));
    if (this.firstParent || c.kind === NODE_STASH) parents = parents.slice(0, 1);
    this.nodeColor.push(c.kind === NODE_WORKING ? -1 : color);
    if (parents.length) {
      lanes[m] = { expect: parents[0]!, srcs: [m], dashed: c.kind === NODE_WORKING, color };
      for (let i = 1; i < parents.length; i++) {
        const p = parents[i]!;
        let target = -1;
        for (let L = 0; L < lanes.length; L++) {
          if (L !== m && lanes[L]?.expect === p) {
            target = L;
            break;
          }
        }
        if (target >= 0) {
          lanes[target]!.srcs.push(m);
        } else {
          const b = this.firstFree();
          lanes[b] = { expect: p, srcs: [m], dashed: false, color: this.takeColor(r) };
        }
      }
    } else {
      this.releaseColor(color, r);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  }

  /** Edges below the last row, so open lanes visibly continue into not-yet-loaded history. */
  tail(): Int16Array {
    const out: number[] = [];
    this.lanes.forEach((s, L) => {
      if (!s) return;
      for (const src of s.srcs) out.push(src, L, s.color | (s.dashed ? EDGE_DASHED : 0));
    });
    return Int16Array.from(out);
  }

  openLanes(): number {
    return this.lanes.filter(Boolean).length;
  }

  snapshot(): LayoutData {
    return {
      rows: this.rows,
      nodeLane: this.nodeLane.view().slice(),
      nodeColor: this.nodeColor.view().slice(),
      edgeStart: this.edgeStart.view().slice(),
      edges: this.edges.view().slice(),
      tail: this.tail(),
      width: this.width,
    };
  }

  /** Snapshot of rows [from, rows): for incremental transfer after append(). */
  snapshotFrom(from: number): { from: number; nodeLane: Int16Array; nodeColor: Int16Array; edgeStart: Uint32Array; edges: Int16Array; tail: Int16Array; width: number } {
    const es = this.edgeStart.view();
    const base = es[from]!;
    return {
      from,
      nodeLane: this.nodeLane.view().slice(from),
      nodeColor: this.nodeColor.view().slice(from),
      edgeStart: es.slice(from).map((x) => x - base),
      edges: this.edges.view().slice(base * 3),
      tail: this.tail(),
      width: this.width,
    };
  }

  /**
   * Build a new layout for `prefix` + old.commits[skip..] without recomputing rows whose lane state
   * is unchanged: lays out the prefix, then walks old rows until the lane state matches an old
   * checkpoint, and splices the remaining old rows. Returns the new layout and how many old rows
   * were reused verbatim.
   */
  static rebase(
    old: GraphLayout,
    oldCommits: readonly LayoutCommit[],
    prefix: readonly LayoutCommit[],
    skip: number,
    maxWalk = 4096,
  ): { layout: GraphLayout; reused: number } {
    const nl = new GraphLayout({ palette: old.palette, firstParent: old.firstParent, checkpointEvery: old.checkpointEvery });
    nl.hidden = new Set(old.hidden);
    nl.append(prefix);
    let j = skip;
    const limit = Math.min(oldCommits.length, skip + maxWalk);
    while (j < oldCommits.length) {
      const cp = old.checkpoints.get(j);
      if (cp && sameState(nl.lanes, cp.lanes) && nl.colorKey(nl.rows) === cp.colors) {
        nl.spliceFrom(old, oldCommits, j);
        return { layout: nl, reused: old.rows - j };
      }
      if (j >= limit) break;
      nl.place(oldCommits[j]!);
      j++;
    }
    // No convergence within the walk budget: lay out the rest normally.
    for (; j < oldCommits.length; j++) nl.place(oldCommits[j]!);
    return { layout: nl, reused: 0 };
  }

  private spliceFrom(old: GraphLayout, oldCommits: readonly LayoutCommit[], j: number): void {
    const delta = this.rows - j;
    const oes = old.edgeStart.view();
    const base = oes[j]!;
    const myBase = this.edgeStart.a[this.edgeStart.n - 1]!; // == edges.n/3
    // node lanes
    const onl = old.nodeLane.view();
    const onc = old.nodeColor.view();
    for (let r = j; r < old.rows; r++) {
      this.nodeLane.push(onl[r]!);
      this.nodeColor.push(onc[r]!);
      this.kinds.push(old.kinds[r]!);
      this.edgeStart.push(oes[r + 1]! - base + myBase);
    }
    // Re-index old checkpoints by their new row so the next rebase can converge against them.
    for (const [r, cp] of old.checkpoints) if (r >= j) this.checkpoints.set(r + delta, cp);
    const oe = old.edges.view();
    for (let i = base * 3; i < oe.length; i++) this.edges.push(oe[i]!);
    for (let r = j; r < oldCommits.length; r++) this.placed.add(oldCommits[r]!.hash);
    this.lanes = cloneState(old.lanes);
    this.width = Math.max(this.width, old.width);
    // Color bookkeeping continues from the old layout, shifted by the row delta.
    this.colorUse = old.colorUse.slice();
    this.colorFreedAt = old.colorFreedAt.map((x) => (x < 0 ? x : x + delta));
  }
}

/** Decode the edges of one row from LayoutData (or the incremental chunk form). */
export function rowEdges(d: { edgeStart: Uint32Array; edges: Int16Array }, r: number): Int16Array {
  return d.edges.subarray(d.edgeStart[r]! * 3, d.edgeStart[r + 1]! * 3);
}
