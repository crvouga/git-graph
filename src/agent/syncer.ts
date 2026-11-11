// RepoSyncer: publishes one repository's state through an AgentWriter, from any RepositoryPort
// (GitHub adapter on the server, the git CLI adapter in the companion, the .git reader in a tab).
//
//   ensure(depth)  info, capabilities, refs, then history pages until `depth` commits are written
//   refresh()      re-read refs; when they changed, walk the changed tips down to known commits;
//                  re-read the working-tree status
//   fulfill(read)  run a port read and store the result
//   run(op)        execute a registry command (with the destructive-confirmation round-trip)
//
// All work on one repository is serialized. Writes are idempotent, so a restarted agent simply
// re-publishes what it does not remember.

import { executeCommand, type CommandRegistry } from "../core/commands/registry.ts";
import type { RepositoryPort } from "../core/port.ts";
import { AppError, type Capabilities, type Commit, type HistoryPage, type HistoryQuery, type RefsSnapshot, type RepoInfo, type WorkingTreeStatus } from "../core/types.ts";
import type { ErrorJson, RepoSync } from "../zero/schema.ts";
import { errorJson, stableJson } from "../zero/rows.ts";

/** Everything in display order: all refs, newest first. */
export const ALL_HISTORY: HistoryQuery = { refs: [], includeRemotes: true, includeTags: true, includeStashes: true, firstParent: false, order: "date" };

const PAGE = 500;
/** Largest single write (commits per mutation). */
const BATCH = 500;
/** How far a refresh walks down one changed ref before giving up on finding known commits. */
const REFRESH_WALK = 5000;
/** Read results larger than this (JSON) are replaced by an error. */
export const MAX_READ_BYTES = 6 * 1024 * 1024;

export interface ReadJob {
  id: string;
  method: string;
  params: readonly unknown[];
}

export interface OperationJob {
  id: string;
  command: string;
  args: Record<string, unknown>;
  confirm: string | null;
}

export interface OperationPatch {
  state: "running" | "confirm" | "ok" | "error";
  result?: unknown;
  error?: ErrorJson | null;
  consequence?: string | null;
  confirmToken?: string | null;
}

/** Where an agent publishes. Implemented over SQL (server) and over Zero mutators (clients). */
export interface AgentWriter {
  /** Repository identity for agent-owned (local / browser) repositories; no-op for GitHub. */
  repo(repoId: string, info: RepoInfo, caps: Capabilities): Promise<void>;
  refs(repoId: string, snap: RefsSnapshot): Promise<void>;
  commits(repoId: string, commits: Commit[], complete?: boolean): Promise<void>;
  state(repoId: string, patch: { status?: WorkingTreeStatus | null; sync?: RepoSync }): Promise<void>;
  demand(id: string, state: "ok" | "error" | "pending", error: ErrorJson | null): Promise<void>;
  read(id: string, result: { ok: true; value: unknown } | { ok: false; error: ErrorJson }): Promise<void>;
  op(id: string, patch: OperationPatch): Promise<void>;
}

export interface SyncerOptions {
  repoId: string;
  port: RepositoryPort;
  writer: AgentWriter;
  registry: CommandRegistry;
  appOrigin: string;
  /** Called after a refresh that changed refs or status (live reads re-run). */
  onChanged?: () => void;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  /** Debounce for change events (ms). */
  debounceMs?: number;
  /** Whether changes are pushed to this agent (webhooks, watchers). Default: the port's watch capability. */
  live?: boolean;
}

export class RepoSyncer {
  readonly repoId: string;
  port: RepositoryPort;
  private readonly o: SyncerOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private info: RepoInfo | null = null;
  private caps: Capabilities | null = null;
  private refs: RefsSnapshot | null = null;
  private statusDigest = "";
  private readonly known = new Set<string>();
  private cursor: string | null = null;
  private written = 0;
  private complete = false;
  private started = false;
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  lastError: AppError | null = null;

  constructor(o: SyncerOptions) {
    this.o = o;
    this.repoId = o.repoId;
    this.port = o.port;
  }

  /** Serialize work on this repository. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  get capabilities(): Capabilities | null {
    return this.caps;
  }

  /** Make sure the repository is published with at least `depth` commits of history. */
  ensure(depth: number): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      if (!this.started) {
        // Read the first page while the repository, refs and status are published: on a large
        // history git takes a while to produce it, and it is what the viewer is waiting for.
        const first = this.cursor === null && !this.complete ? this.port.history(ALL_HISTORY, null, PAGE).then((p) => ({ p }), (e: unknown) => ({ e })) : null;
        await this.start();
        await this.fill(depth, first);
      } else await this.fill(depth);
    });
  }

  private async start() {
    const [info, caps, refs] = await Promise.all([this.port.info(), this.port.capabilities(), this.port.refs()]);
    this.info = info;
    this.caps = caps;
    await this.o.writer.repo(this.repoId, info, caps);
    await this.o.writer.refs(this.repoId, refs);
    this.refs = refs;
    if (caps.workingTree.available) await this.publishStatus();
    await this.o.writer.state(this.repoId, { sync: { state: (this.o.live ?? caps.watch.available) ? "live" : "polling", lastSuccessAt: Date.now(), lastError: null } });
    this.started = true;
    this.unsub = this.port.subscribe((e) => {
      if (e.type === "sync.failed") return void this.o.writer.state(this.repoId, { sync: { lastError: e.reason } }).catch(() => {});
      if (e.type === "refs.changed" || e.type === "commits.added" || e.type === "status.changed" || e.type === "worktree.changed" || e.type === "resync") this.schedule();
    });
  }

  private async fill(depth: number, first?: Promise<{ p: HistoryPage } | { e: unknown }> | null) {
    while (!this.complete && this.written < depth && !this.closed) {
      let page: HistoryPage;
      if (first) {
        const r = await first;
        first = null;
        if ("e" in r) throw r.e;
        page = r.p;
      } else page = await this.port.history(ALL_HISTORY, this.cursor, Math.min(PAGE, Math.max(100, depth - this.written)));
      this.cursor = page.cursor;
      const fresh = page.commits.filter((c) => !this.known.has(c.hash));
      this.complete = page.cursor === null;
      await this.writeCommits(fresh, this.complete ? true : undefined);
      this.written += page.commits.length;
      if (!page.commits.length && !this.complete) break;
    }
  }

  private async writeCommits(commits: Commit[], complete?: boolean) {
    if (!commits.length) {
      if (complete !== undefined) await this.o.writer.commits(this.repoId, [], complete);
      return;
    }
    for (let i = 0; i < commits.length; i += BATCH) {
      const batch = commits.slice(i, i + BATCH);
      await this.o.writer.commits(this.repoId, batch, i + BATCH >= commits.length ? complete : undefined);
      for (const c of batch) this.known.add(c.hash);
    }
  }

  private async publishStatus(): Promise<boolean> {
    let status: WorkingTreeStatus | null = null;
    try {
      status = await this.port.status();
    } catch (e) {
      if (AppError.from(e).code !== "UNSUPPORTED") throw e;
    }
    const digest = stableJson(status);
    if (digest === this.statusDigest) return false;
    this.statusDigest = digest;
    await this.o.writer.state(this.repoId, { status });
    return true;
  }

  /** Debounced refresh after a change event. */
  schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch((e) => this.o.log?.("warn", "refresh failed", { repo: this.repoId, error: AppError.from(e).message }));
    }, this.o.debounceMs ?? 50);
  }

  /** Re-read refs (and status); publish new commits reachable from changed refs. */
  refresh(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.started || this.closed) return false;
      let changed = false;
      try {
        const next = await this.port.refs();
        if (next.version !== this.refs?.version) {
          const before = new Map((this.refs?.refs ?? []).map((r) => [r.name, r.commit]));
          await this.ingestTips(next.refs.filter((r) => before.get(r.name) !== r.commit && !this.known.has(r.commit)).map((r) => r.name));
          await this.o.writer.refs(this.repoId, next);
          this.refs = next;
          changed = true;
        }
        if (this.caps?.workingTree.available && (await this.publishStatus())) changed = true;
        await this.o.writer.state(this.repoId, { sync: { lastSuccessAt: Date.now(), lastError: null } });
        this.lastError = null;
      } catch (e) {
        const err = AppError.from(e);
        this.lastError = err;
        await this.o.writer.state(this.repoId, { sync: { lastError: err.message } }).catch(() => {});
        throw err;
      }
      if (changed) this.o.onChanged?.();
      return changed;
    });
  }

  /** Walk each changed ref until a page is entirely made of commits we already published. */
  private async ingestTips(names: string[]) {
    for (const name of names) {
      let cursor: string | null = null;
      let walked = 0;
      for (;;) {
        const page = await this.port.history({ ...ALL_HISTORY, refs: [name] }, cursor, 200);
        const fresh = page.commits.filter((c) => !this.known.has(c.hash));
        await this.writeCommits(fresh);
        walked += page.commits.length;
        cursor = page.cursor;
        if (!fresh.length || !cursor || walked >= REFRESH_WALK) break;
      }
    }
  }

  /** Run a port read for a viewer. Not serialized: a long history ingest must not delay it. */
  fulfill(job: ReadJob): Promise<void> {
    return (async () => {
      let out: { ok: true; value: unknown } | { ok: false; error: ErrorJson };
      try {
        const value = await callPort(this.port, job.method, job.params);
        out = { ok: true, value: value ?? null };
        if (JSON.stringify(out.value).length > MAX_READ_BYTES) out = { ok: false, error: { code: "UNSUPPORTED", message: "This result is too large to show here" } };
      } catch (e) {
        out = { ok: false, error: errorJson(AppError.from(e).toJSON()) };
      }
      await this.o.writer.read(job.id, out);
    })();
  }

  /** Execute a queued command against this repository. */
  run(job: OperationJob, port: RepositoryPort = this.port): Promise<void> {
    return this.serial(async () => {
      await this.o.writer.op(job.id, { state: "running" });
      const res = await executeCommand(
        this.o.registry,
        { repo: port, appOrigin: this.o.appOrigin, actor: "ui" },
        { command: job.command, args: { ...job.args, repo: port.key }, ...(job.confirm ? { confirm: job.confirm } : {}) },
      );
      if (res.ok) await this.o.writer.op(job.id, { state: "ok", result: (res.result ?? null) as unknown, error: null });
      else if (res.error.code === "CONFIRMATION_REQUIRED")
        await this.o.writer.op(job.id, { state: "confirm", consequence: String(res.error.details?.consequence ?? res.error.message), confirmToken: String(res.error.details?.confirmToken ?? ""), error: null });
      else await this.o.writer.op(job.id, { state: "error", error: errorJson(res.error) });
    }).then(() => void this.refresh().catch(() => {}));
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsub?.();
    this.unsub = null;
  }
}

/** Dispatch a read by method name (the RPC surface of RepositoryPort). */
export async function callPort(port: RepositoryPort, method: string, p: readonly unknown[]): Promise<unknown> {
  switch (method) {
    case "commit":
      return port.commit(String(p[0]));
    case "diff":
      return port.diff(p[0] as never, (p[1] as never) ?? undefined);
    case "file":
      return port.file(String(p[0]), String(p[1]));
    case "blame":
      return port.blame(String(p[0]), String(p[1]));
    case "fileHistory":
      return port.fileHistory(String(p[0]), (p[1] as string | null) ?? null, Number(p[2] ?? 100));
    case "search":
      return port.search(p[0] as never);
    case "status":
      return port.status();
    case "worktrees":
      return port.worktrees();
    case "remotes":
      return port.remotes();
    case "conflict":
      return port.conflict(String(p[0]));
    default:
      throw new AppError("BAD_REQUEST", `Unknown read "${method}"`);
  }
}
