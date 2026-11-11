// The server's source agent for GitHub repositories. It reads its work from PostgreSQL (open
// demands, pending reads and operations for github:* keys), serves it through the GitHub adapter
// and writes the results back with SQL; zero-cache replicates them to every viewer.
//
// Change detection is the existing machinery: each served repository is registered as an
// interest, so the poller and webhooks reconcile it and publish `refs.changed` on the hub, which
// the adapter's subscribe() turns into a syncer refresh.

import { createRepoRegistry } from "../../core/commands/repo-commands.ts";
import { AgentHost, type DemandJob, type OperationRow, type ReadRow } from "../../agent/host.ts";
import { AppError } from "../../core/types.ts";
import type { Db } from "../db.ts";
import { GitHubResolver, makeAdapter, parseGitHubKey, type GitHubEnv } from "../resolver.ts";
import type { Principal, SubscriptionRegistry } from "../sync/subscriptions.ts";
import * as store from "./store.ts";

type Log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface GitHubAgentOptions {
  db: Db;
  env: GitHubEnv;
  registry: SubscriptionRegistry;
  /** The account's GitHub token (refreshed), or null when GitHub is not connected. */
  githubToken: (accountId: string) => Promise<string | null>;
  appOrigin: string;
  log: Log;
  pollMs?: number;
  /** GitHub webhooks are configured: repositories update as soon as GitHub reports a change. */
  webhooks?: boolean;
  idleMs?: number;
  now?: () => number;
}

export class GitHubAgent {
  readonly host: AgentHost;
  private readonly o: GitHubAgentOptions;
  private readonly interests = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<void> | null = null;
  private again = false;
  private closed = false;

  constructor(o: GitHubAgentOptions) {
    this.o = o;
    const t = o.db.t;
    this.host = new AgentHost({
      writer: new store.SqlWriter(o.db, t, o.now),
      registry: createRepoRegistry(),
      appOrigin: o.appOrigin,
      idleMs: o.idleMs,
      live: !!o.webhooks,
      now: o.now,
      log: o.log,
      portFor: (repoId, demand) => this.portFor(repoId, demand),
      opPort: (op) => this.adapterFor(op.repoId!, op.accountId),
      authorize: (d) => this.authorize(d),
      accountRead: async (r) => {
        if (!r.accountId) throw new AppError("UNAUTHENTICATED", "Sign in to list your repositories");
        const resolver = new GitHubResolver(o.env, () => o.githubToken(r.accountId!));
        return resolver.list((r.params[0] as { query?: string; limit?: number }) ?? {});
      },
    });
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private async adapterFor(repoId: string, accountId: string | null) {
    const { owner, name } = parseGitHubKey(repoId);
    const token = accountId ? await this.o.githubToken(accountId) : null;
    return makeAdapter(this.o.env, owner, name, token, { infoFreshMs: 0 });
  }

  /** The adapter used to publish a repository: the viewer's token, or any account with access. */
  private async portFor(repoId: string, demand: DemandJob | null) {
    let account = demand?.accountId ?? null;
    if (!account) {
      const [row] = await this.o.db.query<{ account_id: string; is_public: boolean }>(
        `select a.account_id, r.is_public from ${this.o.db.t("repo_access")} a join ${this.o.db.t("repos")} r on r.id = a.repo_id where a.repo_id = $1 order by a.granted_at desc limit 1`,
        [repoId],
      );
      if (row && !row.is_public) account = row.account_id;
    }
    return this.adapterFor(repoId, account);
  }

  /** Prove this viewer can read the repository; record public visibility / their access. */
  private async authorize(d: DemandJob) {
    const { db } = this.o;
    const t = db.t;
    const { owner, name } = parseGitHubKey(d.repoId);
    const adapter = await this.adapterFor(d.repoId, d.accountId);
    let info;
    try {
      info = await adapter.info();
    } catch (e) {
      const err = AppError.from(e);
      if (d.accountId && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) await store.revokeAccess(db, t, d.repoId, d.accountId).catch(() => {});
      throw err;
    }
    const now = this.now();
    await store.ensureRepo(db, t, d.repoId, "github", `${owner}/${name}`, now);
    const isPublic = info.visibility === "public";
    await store.setPublic(db, t, d.repoId, isPublic);
    if (d.accountId && !isPublic) await store.grantAccess(db, t, d.repoId, d.accountId, info.permission ?? "read", now);
  }

  start() {
    this.timer = setInterval(() => this.kick(), this.o.pollMs ?? 1000);
    (this.timer as { unref?: () => void }).unref?.();
    this.kick();
  }

  /** New work may be waiting (a mutator wrote a demand, read or operation). */
  kick() {
    if (this.closed || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.poll();
    }, 15);
  }

  /** Read the agent's work from PostgreSQL. */
  poll(): Promise<void> {
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.polling = (async () => {
      try {
        do {
          this.again = false;
          await this.pollOnce();
        } while (this.again && !this.closed);
      } catch (e) {
        this.o.log("warn", "github agent poll failed", { error: AppError.from(e).message });
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  private async pollOnce() {
    const { db } = this.o;
    const t = db.t;
    const now = this.now();
    const idle = this.o.idleMs ?? 15 * 60_000;
    const demands = await db.query<{ id: string; repo_id: string; account_id: string | null; depth: number; opened_at: number; state: string }>(
      `select id, repo_id, account_id, depth, opened_at, state from ${t("demands")} where repo_id like 'github:%' and opened_at > $1`,
      [now - idle],
    );
    this.host.setDemands(demands.map((d) => ({ id: d.id, repoId: d.repo_id, accountId: d.account_id, depth: d.depth, openedAt: Number(d.opened_at), state: d.state })));
    const reads = await db.query<{ id: string; repo_id: string; account_id: string | null; method: string; params: unknown[]; live: boolean; state: string; requested_at: number; fulfilled_at: number | null }>(
      `select id, repo_id, account_id, method, params, live, state, requested_at, fulfilled_at from ${t("reads")}
       where (repo_id like 'github:%' or repo_id = 'github') and (state = 'pending' or (live and requested_at > $1)) order by requested_at desc limit 500`,
      [now - 10 * 60_000],
    );
    this.host.setReads(
      reads.map(
        (r): ReadRow => ({
          id: r.id,
          repoId: r.repo_id,
          accountId: r.account_id,
          method: r.method,
          params: r.params,
          live: r.live,
          state: r.state,
          requestedAt: Number(r.requested_at),
          fulfilledAt: r.fulfilled_at === null ? null : Number(r.fulfilled_at),
        }),
      ),
    );
    const ops = await db.query<{ id: string; repo_id: string; agent_id: string | null; account_id: string; command: string; args: Record<string, unknown>; confirm: string | null; state: string }>(
      `select id, repo_id, agent_id, account_id, command, args, confirm, state from ${t("operations")} where state = 'pending' and repo_id like 'github:%' order by created_at limit 100`,
    );
    this.host.setOperations(ops.map((op): OperationRow => ({ id: op.id, repoId: op.repo_id, agentId: op.agent_id, accountId: op.account_id, command: op.command, args: op.args, confirm: op.confirm, state: op.state })));
    this.syncInterests(demands);
  }

  /** Keep the poller/webhook machinery watching exactly the repositories being viewed. */
  private syncInterests(demands: { repo_id: string; account_id: string | null }[]) {
    const want = new Map<string, string | null>();
    for (const d of demands) if (!want.has(d.repo_id) || d.account_id) want.set(d.repo_id, d.account_id);
    for (const [repo, release] of this.interests) {
      if (!want.has(repo)) {
        release();
        this.interests.delete(repo);
      }
    }
    for (const [repo, account] of want) {
      if (this.interests.has(repo)) continue;
      const principal: Principal = { sessionKey: null, accountId: account, userId: null, token: () => (account ? this.o.githubToken(account) : Promise.resolve(null)) };
      this.interests.set(repo, this.o.registry.addInterest(repo, principal));
    }
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    for (const release of this.interests.values()) release();
    this.interests.clear();
    this.host.close();
  }
}
