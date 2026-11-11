// Conversions between Zero rows and the core domain types (core/types.ts).

import type { Commit, HeadState, Ref, RefKind, RefsSnapshot } from "../core/types.ts";
import type { ErrorJson } from "./schema.ts";

export interface RefRow {
  repo_id: string;
  name: string;
  kind: string;
  short: string;
  target: string;
  commit: string;
  remote?: string | null;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
  checked_out_at?: string | null;
  message?: string | null;
  symbolic_target?: string | null;
}

export interface CommitRow {
  repo_id: string;
  hash: string;
  parents: readonly string[];
  author_name: string;
  author_email: string;
  /** Unix milliseconds. */
  author_date: number;
  committer_name: string;
  committer_email: string;
  committer_date: number;
  subject: string;
}

const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function refToRow(repoId: string, r: Ref): RefRow {
  return {
    repo_id: repoId,
    name: r.name,
    kind: r.kind,
    short: r.short,
    target: r.target,
    commit: r.commit,
    remote: r.remote ?? null,
    upstream: r.upstream ?? null,
    ahead: r.ahead ?? null,
    behind: r.behind ?? null,
    checked_out_at: r.checkedOutAt ?? null,
    message: r.message ?? null,
    symbolic_target: r.symbolicTarget ?? null,
  };
}

export function rowToRef(r: RefRow): Ref {
  const out: Ref = { name: r.name, kind: r.kind as RefKind, short: r.short, target: r.target, commit: r.commit };
  const remote = opt(r.remote);
  if (remote !== undefined) out.remote = remote;
  const upstream = opt(r.upstream);
  if (upstream !== undefined) out.upstream = upstream;
  const ahead = opt(r.ahead);
  if (ahead !== undefined) out.ahead = ahead;
  const behind = opt(r.behind);
  if (behind !== undefined) out.behind = behind;
  const at = opt(r.checked_out_at);
  if (at !== undefined) out.checkedOutAt = at;
  const message = opt(r.message);
  if (message !== undefined) out.message = message;
  const sym = opt(r.symbolic_target);
  if (sym !== undefined) out.symbolicTarget = sym;
  return out;
}

export function commitToRow(repoId: string, c: Commit): CommitRow {
  return {
    repo_id: repoId,
    hash: c.hash,
    parents: c.parents,
    author_name: c.author.name,
    author_email: c.author.email,
    author_date: c.author.date * 1000,
    committer_name: c.committer.name,
    committer_email: c.committer.email,
    committer_date: c.committer.date * 1000,
    subject: c.subject,
  };
}

export function rowToCommit(r: CommitRow): Commit {
  return {
    hash: r.hash,
    parents: [...r.parents],
    author: { name: r.author_name, email: r.author_email, date: Math.round(r.author_date / 1000) },
    committer: { name: r.committer_name, email: r.committer_email, date: Math.round(r.committer_date / 1000) },
    subject: r.subject,
  };
}

/** Sort refs deterministically (the order RefsSnapshot consumers expect is stable, not semantic). */
export function snapshotOf(head: HeadState, version: string, rows: readonly RefRow[]): RefsSnapshot {
  const refs = rows.map(rowToRef).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { head, refs, version };
}

/** Stable JSON (sorted keys) for ids derived from structured parameters. */
export function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/** FNV-1a 64-bit as hex: a short deterministic id (not a security boundary). */
export function shortHash(s: string): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x01000193 | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Id of a cached read. Immutable reads (a commit, a commit's diff, a file at a hash) are shared by
 * everyone who can see the repository; `account` scopes per-person reads (e.g. "my repositories").
 */
export function readId(repoId: string, method: string, params: readonly unknown[], account?: string | null): string {
  return `${repoId}|${method}|${shortHash(stableJson(params))}${account ? `|${account}` : ""}`;
}

/** Id of a viewer's demand for a repository ("anon" for signed-out viewers). */
export function demandId(repoId: string, accountId: string | null): string {
  return `${repoId}|${accountId ?? "anon"}`;
}

export function errorJson(e: { code: string; message: string; details?: Record<string, unknown> }): ErrorJson {
  return e.details ? { code: e.code, message: e.message, details: e.details } : { code: e.code, message: e.message };
}
