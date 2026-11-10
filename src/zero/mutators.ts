// Mutators: every write the web client, the companion and the browser agent make.
//
// These are the client implementations (optimistic writes into the local Zero store). The server
// replaces each one (src/server/zero/mutators.ts) with SQL that also checks permissions; the
// arguments are validated by the same schemas on both sides.
//
// Two families:
//  - viewer intents: open a repository (demand), request a read, enqueue / confirm an operation;
//  - agent writes: a source agent (server, companion, browser tab) publishing repository state.

import { defineMutator, defineMutators } from "@rocicorp/zero";
import { z } from "zod";
import { demandId, readId } from "./rows.ts";
import { zql, type ZeroContext } from "./schema.ts";

const repoId = z.string().min(1).max(300);
const now = z.number().finite();
const jsonValue = z.json();
const errorJson = z.object({ code: z.string().max(64), message: z.string().max(4000), details: z.record(z.string(), jsonValue).optional() });

/** Port methods a viewer may ask an agent to run (results are cached in `reads`). */
export const READ_METHODS = ["commit", "diff", "file", "blame", "fileHistory", "search", "status", "worktrees", "remotes", "conflict", "repositories"] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

const refJson = z.object({
  name: z.string().max(1024),
  kind: z.enum(["head", "remote", "tag", "stash"]),
  short: z.string().max(1024),
  target: z.string().max(64),
  commit: z.string().max(64),
  remote: z.string().max(255).nullable().optional(),
  upstream: z.string().max(1024).nullable().optional(),
  ahead: z.number().int().nullable().optional(),
  behind: z.number().int().nullable().optional(),
  checked_out_at: z.string().max(4096).nullable().optional(),
  message: z.string().max(10_000).nullable().optional(),
  symbolic_target: z.string().max(1024).nullable().optional(),
});
const commitJson = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/),
  parents: z.array(z.string().max(64)).max(64),
  author_name: z.string().max(1000),
  author_email: z.string().max(1000),
  author_date: z.number(),
  committer_name: z.string().max(1000),
  committer_email: z.string().max(1000),
  committer_date: z.number(),
  subject: z.string().max(4000),
});
const syncJson = z.object({
  state: z.enum(["live", "polling", "offline"]).optional(),
  lastSuccessAt: z.number().nullable().optional(),
  lastError: z.string().max(2000).nullable().optional(),
  catchingUp: z.boolean().optional(),
});

export const args = {
  open: z.object({ repoId, depth: z.number().int().min(1).max(50_000), now }),
  visit: z.object({ repoId, name: z.string().max(500), path: z.string().max(4096).nullable().optional(), now }),
  readRequest: z.object({ repoId, method: z.enum(READ_METHODS), params: z.array(jsonValue).max(8), live: z.boolean(), personal: z.boolean().optional(), now }),
  opEnqueue: z.object({
    id: z.string().min(8).max(100),
    repoId: repoId.nullable(),
    agentId: z.string().max(100).nullable(),
    command: z.string().min(1).max(100),
    args: z.record(z.string(), jsonValue),
    title: z.string().max(500),
    now,
  }),
  opConfirm: z.object({ id: z.string().max(100), token: z.string().max(500), now }),
  opDismiss: z.object({ id: z.string().max(100), now }),
  agentClaim: z.object({ code: z.string().min(6).max(128), now }),
  agentRepo: z.object({
    agentId: z.string().min(1).max(100),
    id: repoId,
    provider: z.enum(["local", "browser"]),
    name: z.string().max(500),
    info: jsonValue,
    caps: jsonValue,
    now,
  }),
  agentRefs: z.object({ repoId, head: jsonValue, version: z.string().max(200), refs: z.array(refJson).max(100_000) }),
  agentCommits: z.object({ repoId, commits: z.array(commitJson).max(2000), complete: z.boolean().optional() }),
  agentState: z.object({ repoId, status: jsonValue.optional(), sync: syncJson.optional(), now }),
  agentDemand: z.object({ id: z.string().max(400), state: z.enum(["ok", "error", "pending"]), error: errorJson.nullable() }),
  agentRead: z.object({ id: z.string().max(600), state: z.enum(["ok", "error"]), result: jsonValue.optional(), error: errorJson.nullable(), now }),
  agentOp: z.object({
    id: z.string().max(100),
    state: z.enum(["running", "confirm", "ok", "error"]),
    result: jsonValue.optional(),
    error: errorJson.nullable().optional(),
    consequence: z.string().max(10_000).nullable().optional(),
    confirmToken: z.string().max(500).nullable().optional(),
    now,
  }),
  agentHeartbeat: z.object({ agentId: z.string().min(1).max(100), now }),
};

/** Id of the read a viewer asks for. Personal reads (e.g. "my GitHub repositories") are per account. */
export function readIdFor(ctx: ZeroContext | undefined, a: { repoId: string; method: string; params: readonly unknown[]; personal?: boolean }): string {
  return readId(a.repoId, a.method, a.params, a.personal ? (ctx?.accountId ?? "anon") : null);
}

const skip = (ctx: ZeroContext | undefined) => !!ctx?.skipLocalIngest;

export const mutators = defineMutators({
  repo: {
    /** "I am looking at this repository, with this much history": agents serve open demands. */
    open: defineMutator(args.open, async ({ tx, ctx, args: a }) => {
      const id = demandId(a.repoId, ctx?.accountId ?? null);
      const cur = await tx.run(zql.demands.where("id", id).one());
      const retry = cur?.state === "error";
      await tx.mutate.demands.upsert({
        id,
        repo_id: a.repoId,
        account_id: ctx?.accountId ?? null,
        depth: Math.max(a.depth, cur?.depth ?? 0),
        opened_at: a.now,
        state: retry ? "pending" : (cur?.state ?? "pending"),
        error: retry ? null : (cur?.error ?? null),
      });
    }),
    /** Recent repositories (signed in). */
    visit: defineMutator(args.visit, async ({ tx, ctx, args: a }) => {
      if (!ctx?.accountId) return;
      await tx.mutate.visits.upsert({ account_id: ctx.accountId, repo_id: a.repoId, name: a.name, path: a.path ?? null, visited_at: a.now });
    }),
  },
  read: {
    /** Ask the repository's agent for a read (commit details, a diff, a file…). Idempotent. */
    request: defineMutator(args.readRequest, async ({ tx, ctx, args: a }) => {
      const id = readIdFor(ctx, a);
      const cur = await tx.run(zql.reads.where("id", id).one());
      if (cur && cur.state !== "error" && !a.live) return;
      await tx.mutate.reads.upsert({
        id,
        repo_id: a.repoId,
        account_id: a.personal ? (ctx?.accountId ?? null) : null,
        method: a.method,
        params: a.params,
        live: a.live,
        state: cur && cur.state !== "error" ? cur.state : "pending",
        result: cur?.result ?? null,
        error: null,
        requested_at: a.now,
        fulfilled_at: cur?.fulfilled_at ?? null,
      });
    }),
  },
  op: {
    /** Queue a repository command (any registry mutation) for the agent that serves the repository. */
    enqueue: defineMutator(args.opEnqueue, async ({ tx, ctx, args: a }) => {
      if (!ctx?.accountId) throw new Error("Sign in to change repositories");
      await tx.mutate.operations.insert({
        id: a.id,
        repo_id: a.repoId,
        agent_id: a.agentId,
        account_id: ctx.accountId,
        command: a.command,
        args: a.args,
        title: a.title,
        state: "pending",
        confirm: null,
        consequence: null,
        confirm_token: null,
        result: null,
        error: null,
        created_at: a.now,
        updated_at: a.now,
      });
    }),
    /** The viewer accepted the consequence of a destructive operation: run it with the token. */
    confirm: defineMutator(args.opConfirm, async ({ tx, args: a }) => {
      await tx.mutate.operations.update({ id: a.id, state: "pending", confirm: a.token, updated_at: a.now });
    }),
    /** The viewer declined a confirmation (or dismissed a finished operation). */
    dismiss: defineMutator(args.opDismiss, async ({ tx, args: a }) => {
      const cur = await tx.run(zql.operations.where("id", a.id).one());
      if (cur?.state === "confirm") await tx.mutate.operations.update({ id: a.id, state: "cancelled", updated_at: a.now });
    }),
  },
  agent: {
    /** Bind a companion that showed this one-time code to the signed-in account (server only). */
    claim: defineMutator(args.agentClaim, async () => {}),
    heartbeat: defineMutator(args.agentHeartbeat, async () => {}),
    /** Register (or update) a local / browser repository served by this agent. */
    repo: defineMutator(args.agentRepo, async ({ tx, ctx, args: a }) => {
      if (skip(ctx) || !ctx?.accountId) return;
      const cur = await tx.run(zql.repos.where("id", a.id).one());
      const info = a.info as never;
      const caps = a.caps as never;
      if (cur) await tx.mutate.repos.update({ id: a.id, name: a.name, info, caps, agent_id: a.agentId, updated_at: a.now });
      else
        await tx.mutate.repos.insert({
          id: a.id,
          provider: a.provider,
          name: a.name,
          owner_account_id: ctx.accountId,
          agent_id: a.agentId,
          is_public: false,
          info,
          caps,
          head: { kind: "none" },
          refs_version: "",
          status: null,
          commit_count: 0,
          history_complete: false,
          sync: {},
          updated_at: a.now,
        });
      await tx.mutate.repo_access.upsert({ repo_id: a.id, account_id: ctx.accountId, permission: "admin", granted_at: a.now });
    }),
    /** Replace the repository's refs with a new snapshot. */
    refs: defineMutator(args.agentRefs, async ({ tx, ctx, args: a }) => {
      if (skip(ctx)) return;
      const keep = new Set(a.refs.map((r) => r.name));
      for (const old of await tx.run(zql.refs.where("repo_id", a.repoId))) if (!keep.has(old.name)) await tx.mutate.refs.delete({ repo_id: a.repoId, name: old.name });
      for (const r of a.refs) await tx.mutate.refs.upsert({ repo_id: a.repoId, ...r });
      await tx.mutate.repos.update({ id: a.repoId, head: a.head as never, refs_version: a.version });
    }),
    /** Add commits (idempotent; commits are immutable). */
    commits: defineMutator(args.agentCommits, async ({ tx, ctx, args: a }) => {
      if (skip(ctx)) return;
      for (const c of a.commits) await tx.mutate.commits.upsert({ repo_id: a.repoId, ...c });
      const cur = await tx.run(zql.repos.where("id", a.repoId).one());
      if (cur) await tx.mutate.repos.update({ id: a.repoId, commit_count: cur.commit_count + a.commits.length, ...(a.complete !== undefined ? { history_complete: a.complete } : {}) });
    }),
    /** Working-tree status and sync state. */
    state: defineMutator(args.agentState, async ({ tx, ctx, args: a }) => {
      if (skip(ctx)) return;
      const cur = await tx.run(zql.repos.where("id", a.repoId).one());
      if (!cur) return;
      await tx.mutate.repos.update({
        id: a.repoId,
        ...(a.status !== undefined ? { status: a.status as never } : {}),
        ...(a.sync !== undefined ? { sync: { ...cur.sync, ...a.sync } } : {}),
        updated_at: a.now,
      });
    }),
    demand: defineMutator(args.agentDemand, async ({ tx, ctx, args: a }) => {
      if (skip(ctx)) return;
      await tx.mutate.demands.update({ id: a.id, state: a.state, error: a.error });
    }),
    read: defineMutator(args.agentRead, async ({ tx, ctx, args: a }) => {
      if (skip(ctx)) return;
      await tx.mutate.reads.update({ id: a.id, state: a.state, result: a.result ?? null, error: a.error, fulfilled_at: a.now });
    }),
    op: defineMutator(args.agentOp, async ({ tx, ctx, args: a }) => {
      if (skip(ctx)) return;
      await tx.mutate.operations.update({
        id: a.id,
        state: a.state,
        ...(a.result !== undefined ? { result: a.result } : {}),
        ...(a.error !== undefined ? { error: a.error } : {}),
        ...(a.consequence !== undefined ? { consequence: a.consequence } : {}),
        ...(a.confirmToken !== undefined ? { confirm_token: a.confirmToken } : {}),
        updated_at: a.now,
      });
    }),
  },
});

export type Mutators = typeof mutators;
