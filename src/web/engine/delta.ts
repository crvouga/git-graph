// What the graph worker sends after a recompute: only the rows past what the UI thread already
// holds, when nothing above them changed (see appendOf).

import type { GraphState, LayoutChunk, RowCommit } from "./protocol.ts";

/** What the UI thread holds: the rows and layout of the last message sent this session. */
export interface Sent {
  rows: RowCommit[];
  complete: boolean;
  refs: GraphState["refs"];
  nodeLane: Int16Array;
  nodeColor: Int16Array;
  edgeStart: Uint32Array;
  edges: Int16Array;
}
/** Refs arrive as a fresh copy with every state message; compare what they say, not identity. */
function sameRefs(a: GraphState["refs"], b: GraphState["refs"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.version === b.version && JSON.stringify(a.head) === JSON.stringify(b.head);
}

const sameRow = (a: RowCommit, b: RowCommit) => a.hash === b.hash && a.kind === b.kind && a.changes === b.changes;

function equalPrefix<T extends Int16Array | Uint32Array>(a: T, b: T, n: number): boolean {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The rows and layout past what the UI already has, when the new result only adds rows below
 * it (older history streaming in) and leaves everything above unchanged. Null: send a reset.
 * Re-sending every row on each streamed batch made the UI thread clone and re-index thousands
 * of commits while scrolling.
 */
export function appendOf(prev: Sent, rows: RowCommit[], l: LayoutChunk, refs: GraphState["refs"]): { rows: RowCommit[]; layout: LayoutChunk } | null {
  const n = prev.rows.length;
  if (!sameRefs(refs, prev.refs) || n === 0 || rows.length < n) return null;
  for (let i = 0; i < n; i++) if (!sameRow(rows[i]!, prev.rows[i]!)) return null;
  const edgeBase = l.edgeStart[n]!;
  if (edgeBase !== prev.edgeStart[n]) return null;
  if (!equalPrefix(l.nodeLane, prev.nodeLane, n) || !equalPrefix(l.nodeColor, prev.nodeColor, n)) return null;
  if (!equalPrefix(l.edgeStart, prev.edgeStart, n + 1) || !equalPrefix(l.edges, prev.edges, edgeBase * 3)) return null;
  const edgeStart = l.edgeStart.slice(n);
  for (let i = 0; i < edgeStart.length; i++) edgeStart[i]! -= edgeBase;
  return {
    rows: rows.slice(n),
    layout: { from: n, nodeLane: l.nodeLane.slice(n), nodeColor: l.nodeColor.slice(n), edgeStart, edges: l.edges.slice(edgeBase * 3), tail: l.tail.slice(), width: l.width },
  };
}

/** Copy what was sent (the layout's buffers are transferred away right after). */
export function remember(rows: RowCommit[], l: LayoutChunk, refs: GraphState["refs"], complete: boolean): Sent {
  return { rows, complete, refs, nodeLane: l.nodeLane.slice(), nodeColor: l.nodeColor.slice(), edgeStart: l.edgeStart.slice(), edges: l.edges.slice() };
}
