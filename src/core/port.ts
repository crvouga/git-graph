// The repository port. Every adapter (GitHub, local companion, browser FS, HTTP client) implements it.
// Methods an adapter cannot support must throw AppError("UNSUPPORTED", reason) and the adapter's
// capabilities() must report the same reason, so the UI never fails silently.

import type {
  BlameLine,
  Capabilities,
  CommitDetails,
  ConflictFile,
  Diff,
  DiffSpec,
  GitMutation,
  Hash,
  HistoryPage,
  HistoryQuery,
  MutationPrecondition,
  MutationResult,
  RefsSnapshot,
  Remote,
  RepoInfo,
  RepoRef,
  RepositoryEvent,
  WorkingTreeStatus,
  Worktree,
  Commit,
} from "./types.ts";

export interface ReadOptions {
  signal?: AbortSignal;
}

export interface DiffOptions extends ReadOptions {
  /** Only diff this path (and its rename source). */
  path?: string;
  /** Lines of context (default 3). */
  context?: number;
}

export interface SearchQuery {
  text: string;
  /** Which fields to search. Default: all. */
  fields?: ("hash" | "subject" | "body" | "author" | "ref")[];
  limit?: number;
}

export interface RepositoryPort {
  readonly ref: RepoRef;
  readonly key: string;

  capabilities(opts?: ReadOptions): Promise<Capabilities>;
  info(opts?: ReadOptions): Promise<RepoInfo>;
  refs(opts?: ReadOptions): Promise<RefsSnapshot>;
  /** Commits in graph order. `cursor` null = first page. */
  history(query: HistoryQuery, cursor: string | null, limit: number, opts?: ReadOptions): Promise<HistoryPage>;
  commit(hash: Hash, opts?: ReadOptions): Promise<CommitDetails>;
  diff(spec: DiffSpec, opts?: DiffOptions): Promise<Diff>;
  fileHistory(path: string, cursor: string | null, limit: number, opts?: ReadOptions): Promise<HistoryPage>;
  blame(path: string, rev: string, opts?: ReadOptions): Promise<BlameLine[]>;
  /** Server-side search across full history (hash prefix, subject, author, ref). */
  search(q: SearchQuery, opts?: ReadOptions): Promise<Commit[]>;
  /** Raw file content at a revision (text or base64 for binary). */
  file(path: string, rev: string, opts?: ReadOptions): Promise<{ content: string; encoding: "utf8" | "base64"; size: number }>;

  // Local-only reads (throw UNSUPPORTED elsewhere)
  status(opts?: ReadOptions): Promise<WorkingTreeStatus>;
  worktrees(opts?: ReadOptions): Promise<Worktree[]>;
  remotes(opts?: ReadOptions): Promise<Remote[]>;
  conflict(path: string, opts?: ReadOptions): Promise<ConflictFile>;

  /** Perform a mutation. Must enforce `precondition` atomically where the backend allows. Never auto-retries. */
  mutate(m: GitMutation, precondition?: MutationPrecondition): Promise<MutationResult>;

  /** Subscribe to change events for this repository. Returns an unsubscribe function. */
  subscribe(listener: (e: RepositoryEvent) => void): () => void;
}

/** Resolves repository keys to ports for a given caller (session-scoped on the server). */
export interface RepositoryResolver {
  resolve(key: string): Promise<RepositoryPort>;
  list(opts?: { query?: string; limit?: number }): Promise<import("./types.ts").RepoInfo[]>;
}
