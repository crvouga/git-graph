// A source agent that talks to the hosted server only through Zero: it watches its work
// (demands, reads, operations) with synced queries and publishes with mutators. Used by the
// companion (Node, token-authenticated) and by a browser tab serving folders it opened.

import type { Zero } from "@rocicorp/zero";
import type { Capabilities, Commit, RefsSnapshot, RepoInfo, WorkingTreeStatus } from "../core/types.ts";
import { AppError } from "../core/types.ts";
import { mutators } from "../zero/mutators.ts";
import { queries } from "../zero/queries.ts";
import { commitToRow, refToRow } from "../zero/rows.ts";
import type { ErrorJson, RepoSync, Schema, ZeroContext } from "../zero/schema.ts";
import { AgentHost, type AgentHostOptions } from "./host.ts";
import type { AgentWriter, OperationPatch } from "./syncer.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentZero = Zero<Schema, any, ZeroContext>;

type Mutation = { client: Promise<{ type: string }>; server: Promise<{ type: string; error?: { message: string } }> };

export interface ZeroWriterOptions {
  agentId: string;
  provider: "local" | "browser";
  /** Wait for the server to apply each write (backpressure). False when running offline. */
  awaitServer: boolean;
  now?: () => number;
}

export class ZeroWriter implements AgentWriter {
  private readonly z: AgentZero;
  private readonly o: ZeroWriterOptions;

  constructor(z: AgentZero, o: ZeroWriterOptions) {
    this.z = z;
    this.o = o;
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private async send(m: unknown): Promise<void> {
    const r = (this.z.mutate as unknown as (m: unknown) => Mutation)(m);
    const res = await (this.o.awaitServer ? r.server : r.client);
    if (res.type === "error") throw new AppError("UPSTREAM_ERROR", (res as { error?: { message: string } }).error?.message ?? "The server rejected an update");
  }

  repo(repoId: string, info: RepoInfo, caps: Capabilities) {
    return this.send(mutators.agent.repo({ agentId: this.o.agentId, id: repoId, provider: this.o.provider, name: info.name, info: info as never, caps: caps as never, now: this.now() }));
  }
  refs(repoId: string, snap: RefsSnapshot) {
    const refs = snap.refs.map((r) => {
      const { repo_id: _, ...row } = refToRow(repoId, r);
      return row as never;
    });
    return this.send(mutators.agent.refs({ repoId, head: snap.head as never, version: snap.version, refs }));
  }
  commits(repoId: string, commits: Commit[], complete?: boolean) {
    const rows = commits.map((c) => {
      const { repo_id: _, ...row } = commitToRow(repoId, c);
      return { ...row, parents: [...row.parents] };
    });
    return this.send(mutators.agent.commits({ repoId, commits: rows, ...(complete !== undefined ? { complete } : {}) }));
  }
  state(repoId: string, patch: { status?: WorkingTreeStatus | null; sync?: RepoSync }) {
    return this.send(mutators.agent.state({ repoId, ...(patch.status !== undefined ? { status: patch.status as never } : {}), ...(patch.sync ? { sync: patch.sync } : {}), now: this.now() }));
  }
  demand(id: string, state: "ok" | "error" | "pending", error: ErrorJson | null) {
    return this.send(mutators.agent.demand({ id, state, error: error as never }));
  }
  read(id: string, r: { ok: true; value: unknown } | { ok: false; error: ErrorJson }) {
    return this.send(mutators.agent.read(r.ok ? { id, state: "ok", result: r.value as never, error: null, now: this.now() } : { id, state: "error", error: r.error as never, now: this.now() }));
  }
  op(id: string, p: OperationPatch) {
    return this.send(
      mutators.agent.op({
        id,
        state: p.state,
        ...(p.result !== undefined ? { result: p.result as never } : {}),
        ...(p.error !== undefined ? { error: p.error as never } : {}),
        ...(p.consequence !== undefined ? { consequence: p.consequence } : {}),
        ...(p.confirmToken !== undefined ? { confirmToken: p.confirmToken } : {}),
        now: this.now(),
      }),
    );
  }
}

export interface ZeroAgentOptions extends Omit<AgentHostOptions, "writer"> {
  zero: AgentZero;
  agentId: string;
  provider: "local" | "browser";
  awaitServer: boolean;
  /** Heartbeat interval (ms) so viewers can tell the agent is online. 0 = none. */
  heartbeatMs?: number;
}

/** Runs an AgentHost fed by the agent's synced queries. Returns a stop function. */
export function startZeroAgent(o: ZeroAgentOptions): { host: AgentHost; writer: ZeroWriter; stop: () => void } {
  const writer = new ZeroWriter(o.zero, { agentId: o.agentId, provider: o.provider, awaitServer: o.awaitServer, now: o.now });
  const host = new AgentHost({ ...o, writer });
  const z = o.zero;
  const views = [
    z.materialize(queries.agent.demands({ agentId: o.agentId })),
    z.materialize(queries.agent.reads({ agentId: o.agentId })),
    z.materialize(queries.agent.operations({ agentId: o.agentId })),
  ] as const;
  views[0].addListener((rows) =>
    host.setDemands(rows.map((d) => ({ id: d.id, repoId: d.repo_id, accountId: d.account_id ?? null, depth: d.depth, openedAt: d.opened_at, state: d.state }))),
  );
  views[1].addListener((rows) =>
    host.setReads(
      rows.map((r) => ({
        id: r.id,
        repoId: r.repo_id,
        accountId: r.account_id ?? null,
        method: r.method,
        params: r.params as unknown[],
        live: r.live,
        state: r.state,
        requestedAt: r.requested_at,
        fulfilledAt: r.fulfilled_at ?? null,
      })),
    ),
  );
  views[2].addListener((rows) =>
    host.setOperations(
      rows.map((op) => ({
        id: op.id,
        repoId: op.repo_id ?? null,
        agentId: op.agent_id ?? null,
        accountId: op.account_id,
        command: op.command,
        args: op.args as Record<string, unknown>,
        confirm: op.confirm ?? null,
        state: op.state,
      })),
    ),
  );
  let hb: ReturnType<typeof setInterval> | null = null;
  const beat = () => void (z.mutate as unknown as (m: unknown) => unknown)(mutators.agent.heartbeat({ agentId: o.agentId, now: Date.now() }));
  if (o.heartbeatMs) {
    beat();
    hb = setInterval(beat, o.heartbeatMs);
    (hb as { unref?: () => void }).unref?.();
  }
  return {
    host,
    writer,
    stop: () => {
      if (hb) clearInterval(hb);
      for (const v of views) v.destroy();
      host.close();
    },
  };
}
