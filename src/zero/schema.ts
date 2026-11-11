// The Zero schema: the tables the web client, the companion and the browser agent sync.
// PostgreSQL tables live in the "lanes" schema (src/server/migrations.ts) and are replicated by
// zero-cache through the `lanes_zero` publication; column names match PostgreSQL (snake_case).
//
// Shared by the browser, the server and the companion: pure data, no Node or DOM imports.

import { boolean, createBuilder, createSchema, json, number, relationships, string, table, type ColumnBuilder } from "@rocicorp/zero";
import type { Capabilities, FileStatus, HeadState, RepoInfo, WorkingTreeStatus } from "../core/types.ts";

/** PostgreSQL schema Zero replicates. DATABASE_SCHEMA must equal this when Zero is enabled. */
export const ZERO_PG_SCHEMA = "lanes";
const pg = (name: string) => `${ZERO_PG_SCHEMA}.${name}`;

/** How an agent reports the freshness of a repository. */
export interface RepoSync {
  /** live: change notifications; polling: periodic checks; offline: no agent is serving it. */
  state?: "live" | "polling" | "offline";
  lastSuccessAt?: number | null;
  lastError?: string | null;
  /** The agent is busy catching up (history still being ingested). */
  catchingUp?: boolean;
}

export interface ErrorJson {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** A JSON column typed as T (Zero's json<T> only accepts JSON-shaped aliases; core types are interfaces). */
function jsonOf<T>() {
  return json() as unknown as ColumnBuilder<{ type: "json"; optional: false; customType: T }>;
}

const accounts = table("accounts").from(pg("accounts")).columns({ id: string(), email: string().optional(), name: string().optional(), picture: string().optional() }).primaryKey("id");

const githubLinks = table("github_links")
  .from(pg("github_links"))
  .columns({ account_id: string(), github_login: string(), github_name: string().optional(), github_avatar_url: string().optional() })
  .primaryKey("account_id");

const agents = table("agents")
  .from(pg("agents"))
  .columns({ id: string(), account_id: string().optional(), kind: string(), name: string(), created_at: number(), last_seen_at: number().optional() })
  .primaryKey("id");

const repos = table("repos")
  .from(pg("repos"))
  .columns({
    id: string(),
    provider: string(),
    name: string(),
    owner_account_id: string().optional(),
    agent_id: string().optional(),
    is_public: boolean(),
    info: jsonOf<RepoInfo>().optional(),
    caps: jsonOf<Capabilities>().optional(),
    head: jsonOf<HeadState>(),
    refs_version: string(),
    status: jsonOf<WorkingTreeStatus>().optional(),
    commit_count: number(),
    history_complete: boolean(),
    sync: jsonOf<RepoSync>(),
    updated_at: number(),
  })
  .primaryKey("id");

const repoAccess = table("repo_access")
  .from(pg("repo_access"))
  .columns({ repo_id: string(), account_id: string(), permission: string().optional(), granted_at: number() })
  .primaryKey("repo_id", "account_id");

const demands = table("demands")
  .from(pg("demands"))
  .columns({
    id: string(),
    repo_id: string(),
    account_id: string().optional(),
    depth: number(),
    opened_at: number(),
    state: string(),
    error: jsonOf<ErrorJson>().optional(),
  })
  .primaryKey("id");

const refs = table("refs")
  .from(pg("refs"))
  .columns({
    repo_id: string(),
    name: string(),
    kind: string(),
    short: string(),
    target: string(),
    commit: string(),
    remote: string().optional(),
    upstream: string().optional(),
    ahead: number().optional(),
    behind: number().optional(),
    checked_out_at: string().optional(),
    message: string().optional(),
    symbolic_target: string().optional(),
  })
  .primaryKey("repo_id", "name");

const commits = table("commits")
  .from(pg("commits"))
  .columns({
    repo_id: string(),
    hash: string(),
    parents: jsonOf<string[]>(),
    author_name: string(),
    author_email: string(),
    author_date: number(),
    committer_name: string(),
    committer_email: string(),
    committer_date: number(),
    subject: string(),
  })
  .primaryKey("repo_id", "hash");

const reads = table("reads")
  .from(pg("reads"))
  .columns({
    id: string(),
    repo_id: string(),
    account_id: string().optional(),
    method: string(),
    params: jsonOf<unknown[]>(),
    live: boolean(),
    state: string(),
    result: jsonOf<unknown>().optional(),
    error: jsonOf<ErrorJson>().optional(),
    requested_at: number(),
    fulfilled_at: number().optional(),
  })
  .primaryKey("id");

const operations = table("operations")
  .from(pg("operations"))
  .columns({
    id: string(),
    repo_id: string().optional(),
    agent_id: string().optional(),
    account_id: string(),
    command: string(),
    args: jsonOf<Record<string, unknown>>(),
    title: string(),
    state: string(),
    confirm: string().optional(),
    consequence: string().optional(),
    confirm_token: string().optional(),
    result: jsonOf<unknown>().optional(),
    error: jsonOf<ErrorJson>().optional(),
    created_at: number(),
    updated_at: number(),
  })
  .primaryKey("id");

const visits = table("visits")
  .from(pg("visits"))
  .columns({ account_id: string(), repo_id: string(), name: string(), path: string().optional(), visited_at: number() })
  .primaryKey("account_id", "repo_id");

const repoRelationships = relationships(repos, ({ many }) => ({
  access: many({ sourceField: ["id"], destField: ["repo_id"], destSchema: repoAccess }),
}));
const accountRelationships = relationships(accounts, ({ one }) => ({
  github: one({ sourceField: ["id"], destField: ["account_id"], destSchema: githubLinks }),
}));
const refRelationships = relationships(refs, ({ one }) => ({ repo: one({ sourceField: ["repo_id"], destField: ["id"], destSchema: repos }) }));
const commitRelationships = relationships(commits, ({ one }) => ({ repo: one({ sourceField: ["repo_id"], destField: ["id"], destSchema: repos }) }));
const readRelationships = relationships(reads, ({ one }) => ({ repo: one({ sourceField: ["repo_id"], destField: ["id"], destSchema: repos }) }));
const demandRelationships = relationships(demands, ({ one }) => ({ repo: one({ sourceField: ["repo_id"], destField: ["id"], destSchema: repos }) }));
const operationRelationships = relationships(operations, ({ one }) => ({ repo: one({ sourceField: ["repo_id"], destField: ["id"], destSchema: repos }) }));

export const schema = createSchema({
  tables: [accounts, githubLinks, agents, repos, repoAccess, demands, refs, commits, reads, operations, visits],
  relationships: [repoRelationships, accountRelationships, refRelationships, commitRelationships, readRelationships, demandRelationships, operationRelationships],
});

export type Schema = typeof schema;
export const zql = createBuilder(schema);

/** Server-verified identity, attached to every query and mutation. */
export interface ZeroContext {
  /** Signed-in Lanes account (null when signed out). */
  accountId: string | null;
  /** Set when the caller is a source agent (companion) authenticated by its token. */
  agentId: string | null;
  /**
   * Client-side only: skip writing ingested repository data into this client's own store (the
   * companion holds nothing in memory; the server applies the writes).
   */
  skipLocalIngest?: boolean;
  /**
   * Client-side only (the web app's own store): every repository row there already passed the
   * server's visibility check, so queries skip re-checking it per row. The server always builds
   * its own context from the session and never sets this.
   */
  trustedStore?: boolean;
}

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: Schema;
    context: ZeroContext;
  }
}

export type FileStatusJson = FileStatus;
