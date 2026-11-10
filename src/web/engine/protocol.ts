// Messages between the UI thread and the graph engine worker.

import type { Capabilities, Commit, HistoryQuery, RefsSnapshot, RepoInfo, RepositoryEvent, WorkingTreeStatus } from "../../core/types.ts";

export type SourceConfig =
  | { kind: "server"; baseUrl: string }
  | { kind: "companion"; baseUrl: string; token: string }
  | { kind: "fs"; handle: FileSystemDirectoryHandle };

export interface OpenArgs {
  session: number;
  repoKey: string;
  source: SourceConfig;
  query: HistoryQuery;
  /** Rows to load before the first `rows` message (at least one page). */
  initial: number;
  /** Hash to make sure is loaded (deep link to a commit deep in history). */
  ensure?: string | null;
}

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

export interface SyncInfo {
  connection: "live" | "polling" | "connecting" | "offline" | "idle";
  lastSuccessAt: number | null;
  lastError: string | null;
  stale: boolean;
  fromCache: boolean;
  refsVersion: string | null;
  pending: number;
  /** Is this tab holding the shared real-time subscription for the repo? */
  leader: boolean;
}

export type EngineEvent =
  | RowsMessage
  | { t: "sync"; session: number; sync: SyncInfo }
  | { t: "repo"; session: number; info: RepoInfo; caps: Capabilities }
  | { t: "status"; session: number; status: WorkingTreeStatus | null }
  | { t: "event"; session: number; event: RepositoryEvent }
  | { t: "metric"; name: string; value: number; session: number }
  | { t: "error"; session: number; error: { code: string; message: string } };

export type EngineCall =
  | { method: "open"; args: OpenArgs }
  | { method: "close"; args: { session: number } }
  | { method: "loadMore"; args: { session: number; count: number } }
  | { method: "ensure"; args: { session: number; hash: string; maxRows?: number } }
  | { method: "refresh"; args: { session: number; reason: string; force?: boolean } }
  | { method: "search"; args: { session: number; text: string; limit?: number } }
  | { method: "port"; args: { session: number; name: string; params: unknown[] } }
  | { method: "execute"; args: { session: number; command: string; params: unknown; confirm?: string } }
  | { method: "visibility"; args: { visible: boolean; focused: boolean; online: boolean } };

export type CallMessage = { t: "call"; id: number } & EngineCall;
export type CancelMessage = { t: "cancel"; id: number };
export type ResultMessage = { t: "result"; id: number; ok: true; value: unknown } | { t: "result"; id: number; ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
