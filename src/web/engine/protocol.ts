// Messages between the UI thread and the graph engine worker. The worker only computes: commits,
// refs and status come from Zero on the UI thread; it answers with ordered rows and their layout.

import type { Commit, HistoryQuery, RefsSnapshot, WorkingTreeStatus } from "../../core/types.ts";

export interface LayoutChunk {
  from: number;
  nodeLane: Int16Array;
  nodeColor: Int16Array;
  edgeStart: Uint32Array;
  edges: Int16Array;
  tail: Int16Array;
  width: number;
}

/** A display row: a real commit or the pseudo "working" row (hash === "working"). */
export interface RowCommit extends Commit {
  kind: number;
  /** Uncommitted changes count for the working row. */
  changes?: number;
}

export type RowsMessage =
  | { t: "rows"; session: number; kind: "reset"; commits: RowCommit[]; layout: LayoutChunk; complete: boolean; stale: boolean; refs: RefsSnapshot }
  | { t: "rows"; session: number; kind: "append"; commits: RowCommit[]; layout: LayoutChunk; complete: boolean }
  /** Replace the first `removeTop` rows with `insert`, and the whole layout with `layout` (from = 0). */
  | { t: "rows"; session: number; kind: "splice"; removeTop: number; insert: RowCommit[]; layout: LayoutChunk; complete: boolean; refs: RefsSnapshot; reusedRows: number };

/** Freshness of the open repository, as the UI shows it (from the agent's sync state and Zero). */
export interface SyncInfo {
  connection: "live" | "polling" | "connecting" | "offline" | "idle";
  lastSuccessAt: number | null;
  lastError: string | null;
  stale: boolean;
  fromCache: boolean;
  refsVersion: string | null;
  pending: number;
  leader: boolean;
}

export interface GraphState {
  refs: RefsSnapshot | null;
  query: HistoryQuery;
  status: WorkingTreeStatus | null;
  complete: boolean;
}

export type EngineEvent = RowsMessage | { t: "metric"; name: string; value: number; session: number };

export type EngineCall =
  /** Start over for another repository (generation = the UI's session number). */
  | { method: "reset"; args: { session: number } }
  | { method: "commits"; args: { session: number; add: Commit[]; remove: string[] } }
  | { method: "state"; args: { session: number; state: GraphState } }
  | { method: "search"; args: { session: number; text: string; refs?: Record<string, string[]> } };

export type CallMessage = { t: "call"; id: number } & EngineCall;
export type CancelMessage = { t: "cancel"; id: number };
export type ResultMessage = { t: "result"; id: number; ok: true; value: unknown } | { t: "result"; id: number; ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
