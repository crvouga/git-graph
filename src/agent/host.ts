// AgentHost: turns the work an agent sees (open demands, pending reads, queued operations) into
// RepoSyncer calls. The same host runs on the server (GitHub, fed by SQL), in the companion and in
// a browser tab (fed by Zero queries); only the inputs, the writer and `portFor` differ.

import type { CommandRegistry } from "../core/commands/registry.ts";
import type { RepositoryPort } from "../core/port.ts";
import { AppError } from "../core/types.ts";
import { errorJson } from "../zero/rows.ts";
import { RepoSyncer, type AgentWriter, type OperationJob, type ReadJob } from "./syncer.ts";

export interface DemandJob {
  id: string;
  repoId: string;
  accountId: string | null;
  depth: number;
  openedAt: number;
  state: string;
}

export interface ReadRow extends ReadJob {
  repoId: string;
  accountId: string | null;
  live: boolean;
  state: string;
  requestedAt: number;
  fulfilledAt: number | null;
}

export interface OperationRow extends OperationJob {
  repoId: string | null;
  agentId: string | null;
  accountId: string;
  state: string;
}

type Log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface AgentHostOptions {
  writer: AgentWriter;
  registry: CommandRegistry;
  appOrigin: string;
  /** The port serving a repository (throws an AppError when it cannot be served). */
  portFor(repoId: string, demand: DemandJob | null): Promise<RepositoryPort>;
  /** Check that a viewer may read the repository before serving their demand. */
  authorize?(d: DemandJob): Promise<void>;
  /** Reads without a repository behind them (e.g. "repositories" for an account). */
  accountRead?(job: ReadRow): Promise<unknown>;
  /** The port an operation runs with (server: the requester's own GitHub token). Default: the repository's. */
  opPort?(op: OperationRow): Promise<RepositoryPort>;
  /** Operations without a repository (companion: open / clone / init). */
  agentOperation?(job: OperationRow): Promise<unknown>;
  /** Close a repository nobody has opened for this long (ms). */
  idleMs?: number;
  /** Re-check repositories whose port cannot notify changes, this often (ms; 0 = never). */
  pollMs?: number;
  /** Live reads are re-run on change while requested within this window (ms). */
  liveWindowMs?: number;
  readConcurrency?: number;
  /** Changes are pushed to this agent (e.g. GitHub webhooks), so repositories are "live". */
  live?: boolean;
  now?: () => number;
  log?: Log;
}

interface Entry {
  syncer: RepoSyncer | null;
  port: Promise<RepositoryPort> | null;
  depth: number;
  ensured: number;
  openedAt: number;
  error: AppError | null;
}

export class AgentHost {
  private readonly o: AgentHostOptions;
  private readonly repos = new Map<string, Entry>();
  private readonly readsInFlight = new Set<string>();
  /** Last served request time per read id (avoid re-running reads the store has not caught up on). */
  private readonly readsServed = new Map<string, number>();
  private readonly opsInFlight = new Set<string>();
  private readonly liveReads = new Map<string, ReadRow>();
  private readonly demandsSeen = new Map<string, string>();
  private readQueue: ReadRow[] = [];
  private readRunning = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(o: AgentHostOptions) {
    this.o = o;
    this.timer = setInterval(() => this.tick(), Math.min(o.pollMs || 30_000, 30_000));
    (this.timer as { unref?: () => void }).unref?.();
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) {
    this.o.log?.(level, msg, extra);
  }

  private entry(repoId: string): Entry {
    let e = this.repos.get(repoId);
    if (!e) {
      e = { syncer: null, port: null, depth: 0, ensured: 0, openedAt: 0, error: null };
      this.repos.set(repoId, e);
    }
    return e;
  }

  private async syncer(repoId: string, demand: DemandJob | null): Promise<RepoSyncer> {
    const e = this.entry(repoId);
    if (e.syncer) return e.syncer;
    e.port ??= this.o.portFor(repoId, demand);
    let port: RepositoryPort;
    try {
      port = await e.port;
    } catch (err) {
      e.port = null;
      throw err;
    }
    e.syncer ??= new RepoSyncer({
      repoId,
      port,
      writer: this.o.writer,
      registry: this.o.registry,
      appOrigin: this.o.appOrigin,
      log: this.o.log,
      onChanged: () => this.rerunLive(repoId),
      ...(this.o.live !== undefined ? { live: this.o.live } : {}),
    });
    return e.syncer;
  }

  /** The set of open demands for the repositories this agent serves. */
  setDemands(rows: readonly DemandJob[]): void {
    if (this.closed) return;
    const byRepo = new Map<string, DemandJob[]>();
    for (const d of rows) {
      const list = byRepo.get(d.repoId) ?? [];
      list.push(d);
      byRepo.set(d.repoId, list);
    }
    for (const [repoId, list] of byRepo) {
      const e = this.entry(repoId);
      e.openedAt = Math.max(e.openedAt, ...list.map((d) => d.openedAt));
      e.depth = Math.max(...list.map((d) => d.depth));
      for (const d of list) {
        const key = `${d.state}|${d.openedAt}`;
        if (this.demandsSeen.get(d.id) === key) continue;
        this.demandsSeen.set(d.id, key);
        if (d.state === "pending" || d.state === "ok") void this.serve(d);
      }
    }
  }

  private async serve(d: DemandJob) {
    const e = this.entry(d.repoId);
    try {
      await this.o.authorize?.(d);
      const s = await this.syncer(d.repoId, d);
      if (d.state !== "ok") await this.o.writer.demand(d.id, "ok", null);
      if (e.depth > e.ensured) {
        const target = e.depth;
        await s.ensure(target);
        e.ensured = Math.max(e.ensured, target);
      } else if (d.state === "ok") {
        // Re-opened by a viewer: catch up with anything a missed notification would have shown.
        s.schedule();
      }
      e.error = null;
    } catch (err) {
      const ae = AppError.from(err);
      e.error = ae;
      this.log("warn", "demand failed", { repo: d.repoId, account: d.accountId, code: ae.code, error: ae.message });
      await this.o.writer.demand(d.id, "error", errorJson(ae.toJSON())).catch(() => {});
      this.demandsSeen.delete(d.id);
    }
  }

  /** Reads to serve: pending ones run now; live ones are remembered and re-run on change. */
  setReads(rows: readonly ReadRow[]): void {
    if (this.closed) return;
    for (const r of rows) {
      if (r.live) this.liveReads.set(r.id, r);
      if (r.state !== "pending") continue;
      if (this.readsInFlight.has(r.id) || this.readsServed.get(r.id) === r.requestedAt) continue;
      this.enqueueRead(r);
    }
  }

  private enqueueRead(r: ReadRow) {
    this.readsInFlight.add(r.id);
    this.readQueue.push(r);
    this.pumpReads();
  }

  private pumpReads() {
    const max = this.o.readConcurrency ?? 4;
    while (this.readRunning < max && this.readQueue.length) {
      const r = this.readQueue.shift()!;
      this.readRunning++;
      void this.runRead(r).finally(() => {
        this.readRunning--;
        this.readsInFlight.delete(r.id);
        this.readsServed.set(r.id, r.requestedAt);
        if (this.readsServed.size > 5000) this.readsServed.delete(this.readsServed.keys().next().value!);
        this.pumpReads();
      });
    }
  }

  private async runRead(r: ReadRow) {
    try {
      if (this.o.accountRead && r.method === "repositories") {
        const value = await this.o.accountRead(r);
        await this.o.writer.read(r.id, { ok: true, value });
        return;
      }
      const s = await this.syncer(r.repoId, null);
      await s.fulfill(r);
    } catch (e) {
      await this.o.writer.read(r.id, { ok: false, error: errorJson(AppError.from(e).toJSON()) }).catch(() => {});
    }
  }

  private rerunLive(repoId: string) {
    const cutoff = this.now() - (this.o.liveWindowMs ?? 10 * 60_000);
    for (const [id, r] of this.liveReads) {
      if (r.requestedAt < cutoff) {
        this.liveReads.delete(id);
        continue;
      }
      if (r.repoId === repoId && !this.readsInFlight.has(id)) this.enqueueRead(r);
    }
  }

  /** Queued operations (state "pending"). Each (id, confirm token) runs once. */
  setOperations(rows: readonly OperationRow[]): void {
    if (this.closed) return;
    for (const op of rows) {
      if (op.state !== "pending") continue;
      const key = `${op.id}|${op.confirm ?? ""}`;
      if (this.opsInFlight.has(key)) continue;
      this.opsInFlight.add(key);
      void this.runOp(op);
    }
  }

  private async runOp(op: OperationRow) {
    try {
      if (!op.repoId) {
        if (!this.o.agentOperation) throw new AppError("UNSUPPORTED", "This agent does not run repository-less commands");
        await this.o.writer.op(op.id, { state: "running" });
        const result = await this.o.agentOperation(op);
        await this.o.writer.op(op.id, { state: "ok", result: (result ?? null) as unknown, error: null });
        return;
      }
      const s = await this.syncer(op.repoId, null);
      await s.run(op, this.o.opPort ? await this.o.opPort(op) : undefined);
    } catch (e) {
      await this.o.writer.op(op.id, { state: "error", error: errorJson(AppError.from(e).toJSON()) }).catch(() => {});
    }
  }

  /** Refresh a repository now (e.g. a webhook said it changed). */
  refresh(repoId: string): void {
    this.repos.get(repoId)?.syncer?.schedule();
  }

  /** Repositories currently served (open demand, not idle). */
  active(): string[] {
    return [...this.repos.entries()].filter(([, e]) => e.syncer).map(([k]) => k);
  }

  private tick() {
    const t = this.now();
    const idle = this.o.idleMs ?? 15 * 60_000;
    for (const [repoId, e] of this.repos) {
      if (e.openedAt && t - e.openedAt > idle) {
        e.syncer?.close();
        this.repos.delete(repoId);
        continue;
      }
      if (this.o.pollMs && e.syncer && !e.syncer.capabilities?.watch.available) e.syncer.schedule();
    }
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const e of this.repos.values()) e.syncer?.close();
    this.repos.clear();
  }
}
