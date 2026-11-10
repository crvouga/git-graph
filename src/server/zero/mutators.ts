// Server implementations of the shared mutators (src/zero/mutators.ts): permission checks and
// SQL. A mutator that throws is rejected and the client's optimistic write is rolled back.
//
// Who may do what:
//  - anyone (signed out included) may open a GitHub repository; local / browser repositories are
//    opened by their owner only;
//  - reads and operations need read access to the repository (operations: signed in; GitHub
//    then enforces write permission with the person's own token when the agent runs them);
//  - agent writes come from the owner of a local / browser repository (a companion only for the
//    repositories bound to its own agent id); GitHub repositories are written by the server only.

import { createHash } from "node:crypto";
import { defineMutator, defineMutators } from "@rocicorp/zero";
import type { PostgresJsTransaction } from "@rocicorp/zero/server/adapters/postgresjs";
import { parseRepoKey } from "../../core/types.ts";
import { args, mutators, readIdFor } from "../../zero/mutators.ts";
import { demandId } from "../../zero/rows.ts";
import type { ZeroContext } from "../../zero/schema.ts";
import type { Queryable } from "../db.ts";
import * as store from "./store.ts";

export interface ServerMutatorEnv {
  t: store.T;
  /** Called after a write that gives an agent new work (flushed after the transaction commits). */
  kick: (repoId: string | null) => void;
  now?: () => number;
}

interface ServerTx {
  location: "server" | "client";
  dbTransaction: { wrappedTransaction: PostgresJsTransaction };
}

function sqlOf(tx: unknown): Queryable {
  const pg = (tx as ServerTx).dbTransaction.wrappedTransaction;
  return { query: async <T>(text: string, params: unknown[] = []) => (await pg.unsafe(text, params as never[])) as unknown as T[] };
}

export function hashSecret(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

class Rejected extends Error {}
const reject = (msg: string): never => {
  throw new Rejected(msg);
};

function requireAccount(ctx: ZeroContext | undefined): string {
  return ctx?.accountId ?? reject("Sign in first");
}

export function createServerMutators(env: ServerMutatorEnv) {
  const { t } = env;
  const now = () => (env.now ?? Date.now)();

  /** The caller may write agent data for this repository. */
  async function assertAgentOf(q: Queryable, ctx: ZeroContext | undefined, repoId: string) {
    const account = requireAccount(ctx);
    const r = await store.repoOwner(q, t, repoId);
    if (!r || r.owner_account_id !== account || (ctx?.agentId && r.agent_id !== ctx.agentId)) reject("Not your repository");
  }

  return defineMutators(mutators, {
    repo: {
      open: defineMutator(args.open, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        const ref = parseRepoKey(a.repoId) ?? reject("Invalid repository");
        const account = ctx?.accountId ?? null;
        const id = demandId(a.repoId, account);
        let state = "pending";
        let error: unknown = null;
        if (ref.provider !== "github") {
          if (!account || !(await store.canRead(q, t, a.repoId, account))) {
            state = "error";
            error = { code: "NOT_FOUND", message: account ? "This repository is not available to your account. Open it again from the computer that has it." : "Sign in to open local repositories" };
          }
        }
        await q.query(
          `insert into ${t("demands")} (id, repo_id, account_id, depth, opened_at, state, error) values ($1, $2, $3, $4, $5, $6, $7::text::jsonb)
           on conflict (id) do update set depth = greatest(${t("demands")}.depth, excluded.depth), opened_at = excluded.opened_at,
             state = case when ${t("demands")}.state = 'error' or excluded.state = 'error' then excluded.state else ${t("demands")}.state end,
             error = case when ${t("demands")}.state = 'error' or excluded.state = 'error' then excluded.error else ${t("demands")}.error end`,
          [id, a.repoId, account, a.depth, a.now, state, error === null ? null : JSON.stringify(error)],
        );
        env.kick(a.repoId);
      }),
      visit: defineMutator(args.visit, async ({ tx, ctx, args: a }) => {
        if (!ctx?.accountId) return;
        await sqlOf(tx).query(
          `insert into ${t("visits")} (account_id, repo_id, name, path, visited_at) values ($1, $2, $3, $4, $5)
           on conflict (account_id, repo_id) do update set name = excluded.name, path = excluded.path, visited_at = excluded.visited_at`,
          [ctx.accountId, a.repoId, a.name, a.path ?? null, a.now],
        );
      }),
    },
    read: {
      request: defineMutator(args.readRequest, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        if (a.personal) requireAccount(ctx);
        else if (!(await store.canRead(q, t, a.repoId, ctx?.accountId ?? null))) reject("Repository not found");
        const id = readIdFor(ctx, a);
        await q.query(
          `insert into ${t("reads")} (id, repo_id, account_id, method, params, live, state, requested_at) values ($1, $2, $3, $4, $5::text::jsonb, $6, 'pending', $7)
           on conflict (id) do update set requested_at = excluded.requested_at, live = excluded.live,
             state = case when excluded.live or ${t("reads")}.state = 'error' then 'pending' else ${t("reads")}.state end`,
          [id, a.repoId, a.personal ? ctx!.accountId : null, a.method, JSON.stringify(a.params), a.live, a.now],
        );
        env.kick(a.repoId);
      }),
    },
    op: {
      enqueue: defineMutator(args.opEnqueue, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        const account = requireAccount(ctx);
        if (a.repoId) {
          if (!(await store.canRead(q, t, a.repoId, account))) reject("Repository not found");
        } else {
          const [agent] = await q.query<{ account_id: string | null }>(`select account_id from ${t("agents")} where id = $1`, [a.agentId]);
          if (!agent || agent.account_id !== account) reject("That companion is not connected to your account");
        }
        await q.query(
          `insert into ${t("operations")} (id, repo_id, agent_id, account_id, command, args, title, state, created_at, updated_at) values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, 'pending', $8, $8)`,
          [a.id, a.repoId, a.agentId, account, a.command, JSON.stringify(a.args), a.title, a.now],
        );
        env.kick(a.repoId);
      }),
      confirm: defineMutator(args.opConfirm, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        const account = requireAccount(ctx);
        const rows = await q.query<{ repo_id: string | null }>(
          `update ${t("operations")} set state = 'pending', confirm = $3, updated_at = $4 where id = $1 and account_id = $2 and state = 'confirm' returning repo_id`,
          [a.id, account, a.token, a.now],
        );
        if (rows[0]) env.kick(rows[0].repo_id);
      }),
      dismiss: defineMutator(args.opDismiss, async ({ tx, ctx, args: a }) => {
        await sqlOf(tx).query(`update ${t("operations")} set state = 'cancelled', updated_at = $3 where id = $1 and account_id = $2 and state = 'confirm'`, [a.id, requireAccount(ctx), a.now]);
      }),
    },
    agent: {
      claim: defineMutator(args.agentClaim, async ({ tx, ctx, args: a }) => {
        const account = requireAccount(ctx);
        const rows = await sqlOf(tx).query<{ id: string }>(
          `update ${t("agents")} set account_id = $2, claim_hash = null, claim_expires_at = null where claim_hash = $1 and claim_expires_at > $3 returning id`,
          [hashSecret(a.code), account, now()],
        );
        if (!rows.length) reject("That pairing code is invalid or expired. Run `git-graph pair` again.");
      }),
      heartbeat: defineMutator(args.agentHeartbeat, async ({ tx, ctx, args: a }) => {
        const account = requireAccount(ctx);
        const q = sqlOf(tx);
        if (ctx?.agentId) {
          if (ctx.agentId !== a.agentId) reject("Wrong agent");
          await q.query(`update ${t("agents")} set last_seen_at = $2 where id = $1`, [a.agentId, a.now]);
          return;
        }
        // A browser tab serving folders: its agent row is created on first use.
        const rows = await q.query<{ account_id: string | null }>(
          `insert into ${t("agents")} (id, account_id, kind, name, created_at, last_seen_at) values ($1, $2, 'browser', 'Browser', $3, $3)
           on conflict (id) do update set last_seen_at = excluded.last_seen_at returning account_id`,
          [a.agentId, account, a.now],
        );
        if (rows[0]?.account_id !== account) reject("Wrong agent");
      }),
      repo: defineMutator(args.agentRepo, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        const account = requireAccount(ctx);
        const ref = parseRepoKey(a.id);
        if (!ref || ref.provider !== a.provider) reject("Invalid repository id");
        if (ctx?.agentId ? ctx.agentId !== a.agentId : !a.agentId.startsWith("browser-")) reject("Wrong agent");
        if (!ctx?.agentId) {
          await q.query(
            `insert into ${t("agents")} (id, account_id, kind, name, created_at, last_seen_at) values ($1, $2, 'browser', 'Browser', $3, $3) on conflict (id) do nothing`,
            [a.agentId, account, a.now],
          );
          const [ag] = await q.query<{ account_id: string | null }>(`select account_id from ${t("agents")} where id = $1`, [a.agentId]);
          if (ag?.account_id !== account) reject("Wrong agent");
        }
        const cur = await store.repoOwner(q, t, a.id);
        if (cur && cur.owner_account_id !== account) reject("Repository id already in use");
        await q.query(
          `insert into ${t("repos")} (id, provider, name, owner_account_id, agent_id, info, caps, updated_at) values ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8)
           on conflict (id) do update set name = excluded.name, agent_id = excluded.agent_id, info = excluded.info, caps = excluded.caps, updated_at = excluded.updated_at`,
          [a.id, a.provider, a.name, account, a.agentId, JSON.stringify(a.info), JSON.stringify(a.caps), a.now],
        );
        await store.grantAccess(q, t, a.id, account, "admin", a.now);
      }),
      refs: defineMutator(args.agentRefs, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        await assertAgentOf(q, ctx, a.repoId);
        const refs = a.refs.map((r) => ({
          name: r.name,
          kind: r.kind,
          short: r.short,
          target: r.target,
          commit: r.commit,
          ...(r.remote ? { remote: r.remote } : {}),
          ...(r.upstream ? { upstream: r.upstream } : {}),
          ...(r.ahead != null ? { ahead: r.ahead } : {}),
          ...(r.behind != null ? { behind: r.behind } : {}),
          ...(r.checked_out_at ? { checkedOutAt: r.checked_out_at } : {}),
          ...(r.message ? { message: r.message } : {}),
          ...(r.symbolic_target ? { symbolicTarget: r.symbolic_target } : {}),
        }));
        await store.writeRefs(q, t, a.repoId, { head: a.head as never, refs, version: a.version });
      }),
      commits: defineMutator(args.agentCommits, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        await assertAgentOf(q, ctx, a.repoId);
        await store.writeCommitRows(q, t, a.repoId, a.commits, a.complete);
      }),
      state: defineMutator(args.agentState, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        await assertAgentOf(q, ctx, a.repoId);
        await store.writeState(q, t, a.repoId, { ...(a.status !== undefined ? { status: a.status } : {}), ...(a.sync ? { sync: a.sync } : {}) }, a.now);
      }),
      demand: defineMutator(args.agentDemand, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        const [d] = await q.query<{ repo_id: string }>(`select repo_id from ${t("demands")} where id = $1`, [a.id]);
        if (!d) return;
        await assertAgentOf(q, ctx, d.repo_id);
        await store.writeDemand(q, t, a.id, a.state, a.error as never);
      }),
      read: defineMutator(args.agentRead, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        const [r] = await q.query<{ repo_id: string }>(`select repo_id from ${t("reads")} where id = $1`, [a.id]);
        if (!r) return;
        await assertAgentOf(q, ctx, r.repo_id);
        await store.writeRead(q, t, a.id, a.state === "ok" ? { ok: true, value: a.result ?? null } : { ok: false, error: (a.error ?? { code: "INTERNAL", message: "Failed" }) as never }, a.now);
      }),
      op: defineMutator(args.agentOp, async ({ tx, ctx, args: a }) => {
        const q = sqlOf(tx);
        const [op] = await q.query<{ repo_id: string | null; agent_id: string | null }>(`select repo_id, agent_id from ${t("operations")} where id = $1`, [a.id]);
        if (!op) return;
        if (op.repo_id) await assertAgentOf(q, ctx, op.repo_id);
        else if (!ctx?.agentId || op.agent_id !== ctx.agentId) reject("Not your operation");
        await store.writeOp(
          q,
          t,
          a.id,
          {
            state: a.state,
            ...(a.result !== undefined ? { result: a.result } : {}),
            ...(a.error !== undefined ? { error: a.error as never } : {}),
            ...(a.consequence !== undefined ? { consequence: a.consequence } : {}),
            ...(a.confirmToken !== undefined ? { confirmToken: a.confirmToken } : {}),
          },
          a.now,
        );
      }),
    },
  });
}
