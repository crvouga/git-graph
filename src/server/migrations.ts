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
  /** `t` qualifies a table name with the schema. */
  sql: (t: (table: string) => string) => string;
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
      await q.query(m.sql(db.t));
      await q.query(`insert into ${db.t("schema_migrations")} (version, name) values ($1, $2)`, [m.version, m.name]);
      applied.push(m.version);
    }
    return applied;
  });
}
