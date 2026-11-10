// SQL for the Zero-synced tables. Used by the server mutators (inside the mutation transaction)
// and by the server's own GitHub agent. Raw, parameterized SQL; every table name goes through t().

import type { Queryable } from "../db.ts";
import type { Capabilities, Commit, RefsSnapshot, RepoInfo, WorkingTreeStatus } from "../../core/types.ts";
import { AppError } from "../../core/types.ts";
import type { AgentWriter, OperationPatch } from "../../agent/syncer.ts";
import { commitToRow, refToRow } from "../../zero/rows.ts";
import type { ErrorJson, RepoSync } from "../../zero/schema.ts";

export type T = (table: string) => string;

const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export interface RepoOwner {
  provider: string;
  owner_account_id: string | null;
  agent_id: string | null;
  is_public: boolean;
}

export async function repoOwner(q: Queryable, t: T, repoId: string): Promise<RepoOwner | null> {
  const [r] = await q.query<RepoOwner>(`select provider, owner_account_id, agent_id, is_public from ${t("repos")} where id = $1`, [repoId]);
  return r ?? null;
}

/** Can this viewer read the repository? (Mirrors the ZQL rule in src/zero/queries.ts.) */
export async function canRead(q: Queryable, t: T, repoId: string, accountId: string | null): Promise<boolean> {
  const [r] = await q.query<{ ok: boolean }>(
    `select (r.is_public or exists (select 1 from ${t("repo_access")} a where a.repo_id = r.id and a.account_id = $2)) as ok from ${t("repos")} r where r.id = $1`,
    [repoId, accountId],
  );
  return !!r?.ok;
}

export async function ensureRepo(q: Queryable, t: T, repoId: string, provider: string, name: string, now: number) {
  await q.query(`insert into ${t("repos")} (id, provider, name, updated_at) values ($1, $2, $3, $4) on conflict (id) do nothing`, [repoId, provider, name, now]);
}

export async function grantAccess(q: Queryable, t: T, repoId: string, accountId: string, permission: string | null, now: number) {
  await q.query(
    `insert into ${t("repo_access")} (repo_id, account_id, permission, granted_at) values ($1, $2, $3, $4)
     on conflict (repo_id, account_id) do update set permission = excluded.permission`,
    [repoId, accountId, permission, now],
  );
}

export async function revokeAccess(q: Queryable, t: T, repoId: string, accountId: string) {
  await q.query(`delete from ${t("repo_access")} where repo_id = $1 and account_id = $2`, [repoId, accountId]);
}

export async function setPublic(q: Queryable, t: T, repoId: string, isPublic: boolean) {
  await q.query(`update ${t("repos")} set is_public = $2 where id = $1 and is_public <> $2`, [repoId, isPublic]);
}

export async function writeRepo(q: Queryable, t: T, repoId: string, info: RepoInfo, caps: Capabilities, now: number) {
  await q.query(`update ${t("repos")} set name = $2, info = $3::text::jsonb, caps = $4::text::jsonb, updated_at = $5 where id = $1`, [repoId, info.name, j(info), j(caps), now]);
}

export async function writeRefs(q: Queryable, t: T, repoId: string, snap: RefsSnapshot) {
  const rows = snap.refs.map((r) => refToRow(repoId, r));
  await q.query(`delete from ${t("refs")} where repo_id = $1 and not (name = any($2::text[]))`, [repoId, rows.map((r) => r.name)]);
  if (rows.length) {
    const cols = ["repo_id", "name", "kind", "short", "target", "commit", "remote", "upstream", "ahead", "behind", "checked_out_at", "message", "symbolic_target"] as const;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const params: unknown[] = [];
      const values = chunk.map((r) => `(${cols.map((c) => `$${params.push((r as unknown as Record<string, unknown>)[c] ?? null)}`).join(", ")})`);
      await q.query(
        `insert into ${t("refs")} (${cols.map((c) => `"${c}"`).join(", ")}) values ${values.join(", ")}
         on conflict (repo_id, name) do update set ${cols
           .filter((c) => c !== "repo_id" && c !== "name")
           .map((c) => `"${c}" = excluded."${c}"`)
           .join(", ")}`,
        params,
      );
    }
  }
  await q.query(`update ${t("repos")} set head = $2::text::jsonb, refs_version = $3 where id = $1`, [repoId, j(snap.head), snap.version]);
}

export interface CommitInput {
  hash: string;
  parents: readonly string[];
  author_name: string;
  author_email: string;
  author_date: number;
  committer_name: string;
  committer_email: string;
  committer_date: number;
  subject: string;
}

export async function writeCommitRows(q: Queryable, t: T, repoId: string, commits: readonly CommitInput[], complete?: boolean) {
  if (commits.length) {
    const cols = ["repo_id", "hash", "parents", "author_name", "author_email", "author_date", "committer_name", "committer_email", "committer_date", "subject"] as const;
    for (let i = 0; i < commits.length; i += 500) {
      const chunk = commits.slice(i, i + 500);
      const params: unknown[] = [];
      const values = chunk.map(
        (c) =>
          `($${params.push(repoId)}, $${params.push(c.hash)}, $${params.push(JSON.stringify(c.parents))}::text::jsonb, $${params.push(c.author_name)}, $${params.push(c.author_email)}, $${params.push(c.author_date)}, $${params.push(c.committer_name)}, $${params.push(c.committer_email)}, $${params.push(c.committer_date)}, $${params.push(c.subject)})`,
      );
      await q.query(`insert into ${t("commits")} (${cols.join(", ")}) values ${values.join(", ")} on conflict (repo_id, hash) do nothing`, params);
    }
  }
  await q.query(
    `update ${t("repos")} set commit_count = (select count(*) from ${t("commits")} where repo_id = $1)${complete !== undefined ? ", history_complete = $2" : ""} where id = $1`,
    complete !== undefined ? [repoId, complete] : [repoId],
  );
}

export async function writeState(q: Queryable, t: T, repoId: string, patch: { status?: WorkingTreeStatus | null | unknown; sync?: RepoSync }, now: number) {
  const sets: string[] = ["updated_at = $2"];
  const params: unknown[] = [repoId, now];
  if (patch.status !== undefined) sets.push(`status = $${params.push(j(patch.status))}::text::jsonb`);
  if (patch.sync) sets.push(`sync = sync || $${params.push(j(patch.sync))}::text::jsonb`);
  await q.query(`update ${t("repos")} set ${sets.join(", ")} where id = $1`, params);
}

export async function writeDemand(q: Queryable, t: T, id: string, state: string, error: ErrorJson | null) {
  await q.query(`update ${t("demands")} set state = $2, error = $3::text::jsonb where id = $1`, [id, state, j(error)]);
}

export async function writeRead(q: Queryable, t: T, id: string, r: { ok: true; value: unknown } | { ok: false; error: ErrorJson }, now: number) {
  await q.query(`update ${t("reads")} set state = $2, result = $3::text::jsonb, error = $4::text::jsonb, fulfilled_at = $5 where id = $1`, [
    id,
    r.ok ? "ok" : "error",
    r.ok ? j(r.value) : null,
    r.ok ? null : j(r.error),
    now,
  ]);
}

export async function writeOp(q: Queryable, t: T, id: string, p: OperationPatch, now: number) {
  const sets = ["state = $2", "updated_at = $3"];
  const params: unknown[] = [id, p.state, now];
  if (p.result !== undefined) sets.push(`result = $${params.push(j(p.result))}::text::jsonb`);
  if (p.error !== undefined) sets.push(`error = $${params.push(j(p.error))}::text::jsonb`);
  if (p.consequence !== undefined) sets.push(`consequence = $${params.push(p.consequence)}`);
  if (p.confirmToken !== undefined) sets.push(`confirm_token = $${params.push(p.confirmToken)}`);
  await q.query(`update ${t("operations")} set ${sets.join(", ")} where id = $1`, params);
}

/** AgentWriter over SQL: the server's GitHub agent publishes directly to PostgreSQL. */
export class SqlWriter implements AgentWriter {
  private readonly q: Queryable;
  private readonly t: T;
  private readonly now: () => number;
  constructor(q: Queryable, t: T, now: () => number = Date.now) {
    this.q = q;
    this.t = t;
    this.now = now;
  }
  async repo(repoId: string, info: RepoInfo, caps: Capabilities) {
    await writeRepo(this.q, this.t, repoId, info, caps, this.now());
    if (info.visibility) await setPublic(this.q, this.t, repoId, info.visibility === "public");
  }
  refs(repoId: string, snap: RefsSnapshot) {
    return writeRefs(this.q, this.t, repoId, snap);
  }
  commits(repoId: string, commits: Commit[], complete?: boolean) {
    return writeCommitRows(this.q, this.t, repoId, commits.map((c) => commitToRow(repoId, c)), complete);
  }
  state(repoId: string, patch: { status?: WorkingTreeStatus | null; sync?: RepoSync }) {
    return writeState(this.q, this.t, repoId, patch, this.now());
  }
  demand(id: string, state: "ok" | "error" | "pending", error: ErrorJson | null) {
    return writeDemand(this.q, this.t, id, state, error);
  }
  read(id: string, r: { ok: true; value: unknown } | { ok: false; error: ErrorJson }) {
    return writeRead(this.q, this.t, id, r, this.now());
  }
  op(id: string, p: OperationPatch) {
    return writeOp(this.q, this.t, id, p, this.now());
  }
}

export function forbidden(message = "Not allowed"): AppError {
  return new AppError("FORBIDDEN", message);
}
