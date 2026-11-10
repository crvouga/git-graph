// Schema migrations for Lanes' allocated PostgreSQL schema. Deterministic, committed, append-only
// and additive (expand/migrate/contract): never edit or reorder an applied migration, and never
// add a destructive one here; those need a reviewed plan and run by hand.
//
// The schema itself is allocated by crvouga/personal; migrations only create objects inside it.
// They run at boot (MIGRATE_ON_BOOT, default on) and via `pnpm db:migrate`.

import type { Db } from "./db.ts";

export interface Migration {
  version: number;
  name: string;
  /** `t` qualifies a table name with the schema; `schema` is the bare schema name. */
  sql: (t: (table: string) => string, schema: string) => string;
}

/** The publication zero-cache replicates (ZERO_APP_PUBLICATIONS). */
export function zeroPublication(schema: string): string {
  return `${schema}_zero`;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "accounts and GitHub links",
    sql: (t) => `
      create table ${t("accounts")} (
        id uuid primary key default gen_random_uuid(),
        oidc_issuer text not null,
        oidc_subject text not null,
        email text,
        name text,
        picture text,
        created_at timestamptz not null default now(),
        last_login_at timestamptz not null default now(),
        unique (oidc_issuer, oidc_subject)
      );
      create table ${t("github_links")} (
        account_id uuid primary key references ${t("accounts")} (id) on delete cascade,
        github_user_id bigint not null unique,
        github_login text not null,
        github_name text,
        github_avatar_url text,
        token_id text not null,
        access_token text not null,
        access_token_expires_at timestamptz,
        refresh_token text,
        refresh_token_expires_at timestamptz,
        version integer not null default 1,
        linked_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index github_links_token_id on ${t("github_links")} (token_id);
    `,
  },
  {
    // Everything the web client shows is replicated to it by Zero (zero-cache) from these tables.
    // Times are Unix milliseconds (double precision) so they map to Zero numbers unchanged.
    version: 2,
    name: "zero sync: repositories, history, reads, operations, agents",
    sql: (t, schema) => `
      create table ${t("agents")} (
        id text primary key,
        account_id uuid references ${t("accounts")} (id) on delete cascade,
        kind text not null,
        name text not null default '',
        token_hash text,
        claim_hash text,
        claim_expires_at double precision,
        created_at double precision not null,
        last_seen_at double precision
      );
      create index agents_claim_hash on ${t("agents")} (claim_hash);
      create table ${t("repos")} (
        id text primary key,
        provider text not null,
        name text not null default '',
        owner_account_id uuid references ${t("accounts")} (id) on delete cascade,
        agent_id text,
        is_public boolean not null default false,
        info jsonb,
        caps jsonb,
        head jsonb not null default '{"kind":"none"}',
        refs_version text not null default '',
        status jsonb,
        commit_count integer not null default 0,
        history_complete boolean not null default false,
        sync jsonb not null default '{}',
        updated_at double precision not null
      );
      create table ${t("repo_access")} (
        repo_id text not null references ${t("repos")} (id) on delete cascade,
        account_id uuid not null references ${t("accounts")} (id) on delete cascade,
        permission text,
        granted_at double precision not null,
        primary key (repo_id, account_id)
      );
      create table ${t("demands")} (
        id text primary key,
        repo_id text not null,
        account_id uuid references ${t("accounts")} (id) on delete cascade,
        depth integer not null,
        opened_at double precision not null,
        state text not null default 'pending',
        error jsonb
      );
      create index demands_repo on ${t("demands")} (repo_id);
      create table ${t("refs")} (
        repo_id text not null references ${t("repos")} (id) on delete cascade,
        name text not null,
        kind text not null,
        short text not null,
        target text not null,
        commit text not null,
        remote text,
        upstream text,
        ahead integer,
        behind integer,
        checked_out_at text,
        message text,
        symbolic_target text,
        primary key (repo_id, name)
      );
      create table ${t("commits")} (
        repo_id text not null references ${t("repos")} (id) on delete cascade,
        hash text not null,
        parents jsonb not null,
        author_name text not null,
        author_email text not null,
        author_date double precision not null,
        committer_name text not null,
        committer_email text not null,
        committer_date double precision not null,
        subject text not null,
        primary key (repo_id, hash)
      );
      create index commits_by_date on ${t("commits")} (repo_id, committer_date desc, hash);
      create table ${t("reads")} (
        id text primary key,
        repo_id text not null,
        account_id uuid references ${t("accounts")} (id) on delete cascade,
        method text not null,
        params jsonb not null,
        live boolean not null default false,
        state text not null default 'pending',
        result jsonb,
        error jsonb,
        requested_at double precision not null,
        fulfilled_at double precision
      );
      create index reads_pending on ${t("reads")} (state, repo_id);
      create table ${t("operations")} (
        id text primary key,
        repo_id text,
        agent_id text,
        account_id uuid not null references ${t("accounts")} (id) on delete cascade,
        command text not null,
        args jsonb not null,
        title text not null default '',
        state text not null default 'pending',
        confirm text,
        consequence text,
        confirm_token text,
        result jsonb,
        error jsonb,
        created_at double precision not null,
        updated_at double precision not null
      );
      create index operations_pending on ${t("operations")} (state, repo_id);
      create table ${t("visits")} (
        account_id uuid not null references ${t("accounts")} (id) on delete cascade,
        repo_id text not null,
        name text not null,
        path text,
        visited_at double precision not null,
        primary key (account_id, repo_id)
      );
      -- What zero-cache replicates. Column lists keep credentials (tokens, hashes) in PostgreSQL.
      create publication ${zeroPublication(schema)} for table
        ${t("accounts")} (id, email, name, picture),
        ${t("github_links")} (account_id, github_login, github_name, github_avatar_url),
        ${t("agents")} (id, account_id, kind, name, created_at, last_seen_at),
        ${t("repos")}, ${t("repo_access")}, ${t("demands")}, ${t("refs")}, ${t("commits")},
        ${t("reads")}, ${t("operations")}, ${t("visits")};
    `,
  },
];

/** Apply pending migrations. Safe to run concurrently (advisory lock) and repeatedly. */
export async function migrate(db: Db): Promise<number[]> {
  const exists = await db.query<{ ok: number }>("select 1 as ok from pg_namespace where nspname = $1", [db.schema]);
  if (!exists.length) {
    throw new Error(`database schema "${db.schema}" does not exist: it must be allocated by crvouga/personal (a [database] request), not created by the app`);
  }
  return db.transaction(async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtext($1))", [`lanes-migrate:${db.schema}`]);
    await q.query(`create table if not exists ${db.t("schema_migrations")} (version integer primary key, name text not null, applied_at timestamptz not null default now())`);
    const done = new Set((await q.query<{ version: number }>(`select version from ${db.t("schema_migrations")}`)).map((r) => Number(r.version)));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await q.query(m.sql(db.t, db.schema));
      await q.query(`insert into ${db.t("schema_migrations")} (version, name) values ($1, $2)`, [m.version, m.name]);
      applied.push(m.version);
    }
    return applied;
  });
}
