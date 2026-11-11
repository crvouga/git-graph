// Synced queries. Read permissions live here, in ZQL, using only the server-verified context:
// a repository (and everything under it) is visible when it is a verified-public GitHub
// repository, or when the viewer has an access row (private GitHub repos they can read, and the
// local / browser repositories they own).

import { defineQueries, defineQuery } from "@rocicorp/zero";
import { z } from "zod";
import { demandId } from "./rows.ts";
import { zql, type ZeroContext } from "./schema.ts";

const NOBODY = "00000000-0000-0000-0000-000000000000";
const me = (ctx: ZeroContext | undefined) => ctx?.accountId ?? NOBODY;

type RepoQuery = ReturnType<typeof zql.repos.where>;
/** Restrict a repos query to what the viewer may read. */
function visibleRepos(q: RepoQuery, ctx: ZeroContext | undefined): RepoQuery {
  const account = me(ctx);
  return q.where(({ or, cmp, exists }) => or(cmp("is_public", true), exists("access", (a) => a.where("account_id", account))));
}

const repoArgs = z.object({ repoId: z.string().min(1).max(300) });
const MAX_WINDOW = 50_000;

export const queries = defineQueries({
  repo: {
    /** One repository row (info, capabilities, HEAD, working-tree status, sync state). */
    byId: defineQuery(repoArgs, ({ args, ctx }) => visibleRepos(zql.repos.where("id", args.repoId), ctx).one()),
    refs: defineQuery(repoArgs, ({ args, ctx }) =>
      zql.refs.where("repo_id", args.repoId).whereExists("repo", (r) => visibleRepos(r, ctx)),
    ),
    /** The newest `limit` commits by committer date: the window the graph is computed from. */
    commits: defineQuery(repoArgs.extend({ limit: z.number().int().min(1).max(MAX_WINDOW) }), ({ args, ctx }) =>
      zql.commits
        .where("repo_id", args.repoId)
        .whereExists("repo", (r) => visibleRepos(r, ctx))
        .orderBy("committer_date", "desc")
        .orderBy("hash", "asc")
        .limit(args.limit),
    ),
    commit: defineQuery(repoArgs.extend({ hash: z.string().regex(/^[0-9a-f]{40,64}$/) }), ({ args, ctx }) =>
      zql.commits
        .where("repo_id", args.repoId)
        .where("hash", args.hash)
        .whereExists("repo", (r) => visibleRepos(r, ctx))
        .one(),
    ),
    /** Commits whose hash starts with `prefix` (short hashes in links and find). */
    commitsByPrefix: defineQuery(repoArgs.extend({ prefix: z.string().regex(/^[0-9a-f]{4,64}$/) }), ({ args, ctx }) =>
      zql.commits
        .where("repo_id", args.repoId)
        .where("hash", "LIKE", `${args.prefix}%`)
        .whereExists("repo", (r) => visibleRepos(r, ctx))
        .limit(5),
    ),
    /** The viewer's own demand for a repository: tells why a repository cannot be shown. */
    demand: defineQuery(repoArgs, ({ args, ctx }) => zql.demands.where("id", demandId(args.repoId, ctx?.accountId ?? null)).one()),
  },
  reads: {
    /** A cached repository read (commit details, diff, file, blame…). */
    byId: defineQuery(z.object({ id: z.string().min(1).max(600) }), ({ args, ctx }) =>
      zql.reads
        .where("id", args.id)
        .where(({ or, cmp, exists }) =>
          or(cmp("account_id", me(ctx)), exists("repo", (r) => visibleRepos(r, ctx))),
        )
        .one(),
    ),
  },
  operations: {
    byId: defineQuery(z.object({ id: z.string().min(1).max(100) }), ({ args, ctx }) => zql.operations.where("id", args.id).where("account_id", me(ctx)).one()),
    /** The viewer's recent operations (status line, confirmations). */
    recent: defineQuery(z.object({}), ({ ctx }) => zql.operations.where("account_id", me(ctx)).orderBy("created_at", "desc").limit(20)),
  },
  me: {
    account: defineQuery(z.object({}), ({ ctx }) => zql.accounts.where("id", me(ctx)).related("github").one()),
    visits: defineQuery(z.object({}), ({ ctx }) => zql.visits.where("account_id", me(ctx)).orderBy("visited_at", "desc").limit(30)),
    agents: defineQuery(z.object({}), ({ ctx }) => zql.agents.where("account_id", me(ctx)).orderBy("last_seen_at", "desc")),
  },
  /**
   * What a source agent (companion or browser tab) has to do. An agent only sees repositories its
   * account owns; a companion only those bound to its own agent id.
   */
  agent: {
    repos: defineQuery(z.object({ agentId: z.string().min(1).max(100) }), ({ args, ctx }) =>
      zql.repos.where("agent_id", ctx?.agentId ?? args.agentId).where("owner_account_id", me(ctx)),
    ),
    demands: defineQuery(z.object({ agentId: z.string().min(1).max(100) }), ({ args, ctx }) =>
      zql.demands.whereExists("repo", (r) => r.where("agent_id", ctx?.agentId ?? args.agentId).where("owner_account_id", me(ctx))),
    ),
    reads: defineQuery(z.object({ agentId: z.string().min(1).max(100) }), ({ args, ctx }) =>
      zql.reads
        .where(({ or, cmp }) => or(cmp("state", "pending"), cmp("live", true)))
        .whereExists("repo", (r) => r.where("agent_id", ctx?.agentId ?? args.agentId).where("owner_account_id", me(ctx)))
        .orderBy("requested_at", "desc")
        .limit(500),
    ),
    operations: defineQuery(z.object({ agentId: z.string().min(1).max(100) }), ({ args, ctx }) =>
      zql.operations
        .where("state", "pending")
        .where(({ or, cmp, exists }) =>
          or(
            cmp("agent_id", ctx?.agentId ?? args.agentId),
            exists("repo", (r) => r.where("agent_id", ctx?.agentId ?? args.agentId).where("owner_account_id", me(ctx))),
          ),
        )
        .where("account_id", me(ctx))
        .orderBy("created_at", "asc"),
    ),
  },
});
