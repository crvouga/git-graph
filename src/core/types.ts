// Core domain types shared by every adapter, the web app, the API, the CLI and the MCP server.
// Pure data only: no runtime dependencies, safe in browser, worker and Node.

export type Hash = string;

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

export type RepoRef =
  | { provider: "github"; owner: string; name: string }
  /** A repository served by the local companion. `id` is stable per common git dir. */
  | { provider: "local"; id: string; worktree?: string }
  /** A repository opened through the browser File System Access API. */
  | { provider: "browser"; id: string };

export type ProviderKind = RepoRef["provider"];

/** Canonical string id, used in API paths, caches and event streams. Never contains "/". */
export function repoKey(r: RepoRef): string {
  switch (r.provider) {
    case "github":
      return `github:${r.owner}:${r.name}`;
    case "local":
      return `local:${r.id}`;
    case "browser":
      return `browser:${r.id}`;
  }
}

export function parseRepoKey(key: string): RepoRef | null {
  const parts = key.split(":");
  if (parts[0] === "github" && parts.length === 3 && parts[1] && parts[2]) {
    return { provider: "github", owner: parts[1], name: parts[2] };
  }
  if ((parts[0] === "local" || parts[0] === "browser") && parts.length === 2 && /^[A-Za-z0-9_-]{1,64}$/.test(parts[1]!)) {
    return { provider: parts[0], id: parts[1]! } as RepoRef;
  }
  return null;
}

export function repoLabel(r: RepoRef): string {
  return r.provider === "github" ? `${r.owner}/${r.name}` : r.id;
}

export interface RepoInfo {
  ref: RepoRef;
  key: string;
  /** Human name: "owner/repo" or the folder name. */
  name: string;
  description?: string;
  defaultBranch?: string;
  visibility?: "public" | "private" | "internal" | "local";
  /** Absolute path of the current worktree (local adapter only). */
  worktreePath?: string;
  /** Absolute path of the shared common git dir (local adapter only). */
  commonDir?: string;
  /** Viewer permission (GitHub adapter). */
  permission?: "read" | "triage" | "write" | "maintain" | "admin" | "none";
  htmlUrl?: string;
}

// ---------------------------------------------------------------------------
// Commits and refs
// ---------------------------------------------------------------------------

export interface Person {
  name: string;
  email: string;
  /** Unix seconds. */
  date: number;
}

export interface Commit {
  hash: Hash;
  parents: Hash[];
  author: Person;
  committer: Person;
  subject: string;
}

export interface CommitDetails extends Commit {
  body: string;
  files: FileChange[];
  /** Files list was cut short by the provider. */
  filesTruncated?: boolean;
  signature?: { status: "good" | "bad" | "unknown" | "none"; signer?: string };
}

export type RefKind = "head" | "remote" | "tag" | "stash";

export interface Ref {
  /** Full ref name, e.g. "refs/heads/main", "refs/remotes/origin/main", "refs/tags/v1", "refs/stash@{0}". */
  name: string;
  kind: RefKind;
  /** Display name, e.g. "main", "origin/main", "v1", "stash@{0}". */
  short: string;
  /** Object the ref points at (for annotated tags: the tag object). */
  target: Hash;
  /** Commit the ref ultimately points at (peeled). Always set. */
  commit: Hash;
  remote?: string;
  /** "refs/remotes/origin/main" for a local branch with an upstream. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Absolute path of a worktree where this branch is checked out. */
  checkedOutAt?: string;
  /** Stash message / annotated tag message, when cheap to obtain. */
  message?: string;
  /** Symbolic refs such as origin/HEAD. */
  symbolicTarget?: string;
}

export type HeadState =
  | { kind: "branch"; ref: string; commit: Hash }
  | { kind: "detached"; commit: Hash }
  | { kind: "unborn"; ref: string }
  | { kind: "none" };

export interface RefsSnapshot {
  head: HeadState;
  refs: Ref[];
  /** Deterministic digest of head + refs. Equal versions mean equal ref state. */
  version: string;
}

export type CommitOrder = "date" | "topo" | "author-date";

export interface HistoryQuery {
  /** Short or full ref names / hashes to show. Empty = all refs permitted by the flags below. */
  refs: string[];
  includeRemotes: boolean;
  includeTags: boolean;
  includeStashes: boolean;
  firstParent: boolean;
  order: CommitOrder;
}

export const DEFAULT_HISTORY_QUERY: HistoryQuery = {
  refs: [],
  includeRemotes: true,
  includeTags: true,
  includeStashes: true,
  firstParent: false,
  order: "date",
};

export interface HistoryPage {
  commits: Commit[];
  /** Opaque cursor for the next page; null when history is exhausted. */
  cursor: string | null;
  /** RefsSnapshot.version this page was computed against. */
  refsVersion: string;
  /** Total number of commits when known cheaply. */
  total?: number;
}

// ---------------------------------------------------------------------------
// Files and diffs
// ---------------------------------------------------------------------------

/** A=added M=modified D=deleted R=renamed C=copied T=type change U=unmerged ?=untracked */
export type FileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "?";

export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export type DiffSpec =
  | { kind: "commit"; hash: Hash }
  | { kind: "compare"; base: Hash; head: Hash }
  /** Uncommitted changes: index vs HEAD (staged) or worktree vs index (unstaged). */
  | { kind: "working"; staged: boolean };

export interface DiffLine {
  kind: "context" | "add" | "del" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  oldSize?: number;
  newSize?: number;
  hunks: Hunk[];
  /** Diff was cut at the provider's size limit. */
  truncated?: boolean;
}

export interface Diff {
  spec: DiffSpec;
  files: FileDiff[];
}

export interface BlameLine {
  line: number;
  hash: Hash;
  author: string;
  date: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Working tree and worktrees (local adapter)
// ---------------------------------------------------------------------------

export type InProgressOperation =
  | { kind: "merge"; head?: Hash; message?: string }
  | { kind: "rebase"; interactive: boolean; step?: number; total?: number; onto?: Hash; headName?: string }
  | { kind: "cherry-pick"; head?: Hash }
  | { kind: "revert"; head?: Hash }
  | { kind: "bisect" }
  | { kind: "am" };

export interface WorkingTreeStatus {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  conflicted: FileChange[];
  operation: InProgressOperation | null;
  /** Upstream tracking info for the current branch. */
  branch?: { name: string; upstream?: string; ahead: number; behind: number };
}

export interface Worktree {
  path: string;
  head: Hash | null;
  /** "refs/heads/feature" or undefined when detached/bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
  isMain: boolean;
  /** True for the worktree the adapter is bound to. */
  isCurrent: boolean;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface ConflictFile {
  path: string;
  /** Stage contents (1 = base, 2 = ours, 3 = theirs); undefined when absent or binary. */
  base?: string;
  ours?: string;
  theirs?: string;
  /** Current working-tree content including conflict markers. */
  working?: string;
  binary: boolean;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  "history",
  "refs",
  "commit",
  "diff",
  "compare",
  "fileHistory",
  "blame",
  "search",
  "workingTree",
  "stage",
  "stageHunk",
  "commitWrite",
  "branchWrite",
  "tagWrite",
  "merge",
  "rebase",
  "interactiveRebase",
  "cherryPick",
  "revert",
  "reset",
  "stash",
  "remotes",
  "fetch",
  "pull",
  "push",
  "worktrees",
  "conflicts",
  "clean",
  "runGit",
  "watch",
  "clone",
  "init",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityState = { available: true } | { available: false; reason: string };

export type Capabilities = Record<Capability, CapabilityState>;

export function capabilities(
  available: readonly Capability[],
  unavailableReason: (c: Capability) => string,
): Capabilities {
  const out = {} as Capabilities;
  for (const c of CAPABILITIES) {
    out[c] = available.includes(c) ? { available: true } : { available: false, reason: unavailableReason(c) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type InteractiveRebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export type GitMutation =
  | { op: "checkout"; target: string; /** create a local tracking branch from a remote ref */ track?: boolean }
  | { op: "branch.create"; name: string; target: string; checkout?: boolean }
  | { op: "branch.delete"; name: string; force?: boolean; remote?: boolean }
  | { op: "branch.rename"; from: string; to: string }
  | { op: "tag.create"; name: string; target: string; message?: string; sign?: boolean }
  | { op: "tag.delete"; name: string }
  | { op: "tag.push"; name: string; remote: string }
  | { op: "merge"; ref: string; noFastForward?: boolean; squash?: boolean; noCommit?: boolean }
  | { op: "rebase"; onto: string; todo?: { action: InteractiveRebaseAction; hash: Hash; message?: string }[] }
  | { op: "cherry-pick"; hashes: Hash[]; noCommit?: boolean; recordOrigin?: boolean; mainline?: number }
  | { op: "revert"; hash: Hash; mainline?: number }
  | { op: "reset"; target: string; mode: "soft" | "mixed" | "hard" }
  | { op: "operation.continue" }
  | { op: "operation.skip" }
  | { op: "operation.abort" }
  | { op: "stage"; paths: string[] }
  | { op: "unstage"; paths: string[] }
  /** Apply a unified-diff patch (one or more hunks) to the index; reverse=true unstages. */
  | { op: "stage.patch"; patch: string; reverse?: boolean }
  /** Discard a unified-diff patch from the working tree (reverse-apply). */
  | { op: "discard.patch"; patch: string }
  | { op: "restore"; paths: string[]; source?: string; staged?: boolean; worktree?: boolean }
  | { op: "commit"; message: string; amend?: boolean; signoff?: boolean; allowEmpty?: boolean }
  | { op: "stash.push"; message?: string; paths?: string[]; includeUntracked?: boolean; keepIndex?: boolean; staged?: boolean }
  | { op: "stash.apply"; index: number; reinstateIndex?: boolean }
  | { op: "stash.pop"; index: number; reinstateIndex?: boolean }
  | { op: "stash.drop"; index: number }
  | { op: "stash.branch"; index: number; name: string }
  | { op: "fetch"; remote?: string; prune?: boolean; pruneTags?: boolean }
  | { op: "pull"; remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean }
  | {
      op: "push";
      remote: string;
      branch: string;
      setUpstream?: boolean;
      /** Normal force-push workflow: --force-with-lease=<branch>:<expect>. */
      forceWithLease?: { expect?: Hash };
    }
  | { op: "remote.add"; name: string; url: string }
  | { op: "remote.remove"; name: string }
  | { op: "remote.rename"; from: string; to: string }
  | { op: "remote.set-url"; name: string; url: string }
  | { op: "upstream.set"; branch: string; upstream: string | null }
  | { op: "worktree.add"; path: string; branch?: string; newBranch?: string; commitish?: string }
  | { op: "worktree.remove"; path: string; force?: boolean }
  | { op: "worktree.lock"; path: string; reason?: string }
  | { op: "worktree.unlock"; path: string }
  | { op: "worktree.prune"; dryRun?: boolean }
  | { op: "conflict.resolve"; path: string; resolution: "ours" | "theirs" | { content: string } }
  | { op: "clean"; paths: string[]; dryRun: boolean; directories?: boolean }
  | { op: "git.run"; args: string[] };

export type GitMutationOp = GitMutation["op"];

/** Optimistic-concurrency precondition supplied with a mutation. */
export interface MutationPrecondition {
  /** Fail with STALE_STATE unless the repository's RefsSnapshot.version still equals this. */
  refsVersion?: string;
  /** Fail with STALE_STATE unless this ref still points at this object. */
  ref?: { name: string; commit: Hash };
}

export interface MutationResult {
  op: GitMutationOp;
  /** Combined, credential-scrubbed output of the underlying command(s). */
  output: string;
  /** Exact git invocations (local adapter) or API calls (GitHub) performed. */
  invocations: string[];
  exitCode?: number;
  refsVersion?: string;
  /** For dry runs (clean, prune): the list of affected paths. */
  affected?: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "REF_NOT_FOUND",
  "COMMIT_NOT_FOUND",
  "UNSUPPORTED",
  "CONFIRMATION_REQUIRED",
  "STALE_STATE",
  "CONFLICT",
  "GIT_FAILED",
  "GIT_MISSING",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "OFFLINE",
  "CANCELLED",
  "TIMEOUT",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorShape {
  code: ErrorCode;
  message: string;
  /** Extra structured info: e.g. { capability }, { retryAfter }, { consequence, confirmToken }. */
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
  toJSON(): AppErrorShape {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
  static from(e: unknown): AppError {
    if (e instanceof AppError) return e;
    if (e && typeof e === "object" && "code" in e && "message" in e && typeof (e as AppErrorShape).code === "string") {
      const s = e as AppErrorShape;
      if ((ERROR_CODES as readonly string[]).includes(s.code)) return new AppError(s.code, s.message, s.details);
    }
    if (e instanceof DOMException && e.name === "AbortError") return new AppError("CANCELLED", "Request was cancelled");
    return new AppError("INTERNAL", e instanceof Error ? e.message : String(e));
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REF_NOT_FOUND: 404,
  COMMIT_NOT_FOUND: 404,
  UNSUPPORTED: 501,
  CONFIRMATION_REQUIRED: 428,
  STALE_STATE: 409,
  CONFLICT: 409,
  GIT_FAILED: 422,
  GIT_MISSING: 503,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  OFFLINE: 503,
  CANCELLED: 499,
  TIMEOUT: 504,
  INTERNAL: 500,
};

// ---------------------------------------------------------------------------
// Synchronization events
// ---------------------------------------------------------------------------

export type RepositoryEvent =
  | { type: "refs.changed"; repositoryId: string; version: string }
  | { type: "commits.added"; repositoryId: string; commits: Hash[] }
  | { type: "worktree.changed"; repositoryId: string; worktreeId: string }
  | { type: "status.changed"; repositoryId: string; worktreeId: string }
  | { type: "operation.started"; repositoryId: string; operationId: string; op: string }
  | { type: "operation.completed"; repositoryId: string; operationId: string; op: string; ok: boolean }
  | { type: "sync.failed"; repositoryId: string; reason: string }
  | { type: "sync.ok"; repositoryId: string; at: number }
  /** The server cannot prove continuity (gap, restart, overflow): clients must reconcile. */
  | { type: "resync"; repositoryId: string; reason: string }
  | { type: "access.revoked"; repositoryId: string };

/** Envelope delivered over SSE / MCP / BroadcastChannel. `seq` is monotonic per stream epoch. */
export interface EventEnvelope {
  /** Stream epoch: changes on server restart, letting clients detect lost history. */
  epoch: string;
  seq: number;
  at: number;
  event: RepositoryEvent;
}

/** Cursor format used for Last-Event-ID and ?cursor= : "<epoch>:<seq>". */
export function formatCursor(epoch: string, seq: number): string {
  return `${epoch}:${seq}`;
}
export function parseCursor(c: string | null | undefined): { epoch: string; seq: number } | null {
  if (!c) return null;
  const i = c.lastIndexOf(":");
  if (i <= 0) return null;
  const seq = Number(c.slice(i + 1));
  return Number.isSafeInteger(seq) && seq >= 0 ? { epoch: c.slice(0, i), seq } : null;
}

export interface SyncStatus {
  repositoryId: string;
  connection: "live" | "polling" | "connecting" | "offline";
  lastSuccessAt: number | null;
  lastError?: { at: number; message: string };
  refsVersion: string | null;
  stale: boolean;
  pendingOperations: number;
}
