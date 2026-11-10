// PostgreSQL access: raw, parameterized SQL over a small bounded pool.
//
// DATABASE_URL is opaque (it selects dev or prd and carries any TLS parameters): it is passed to
// the driver unchanged and never logged. Lanes may only touch its own allocated schema
// (DATABASE_SCHEMA, default "lanes"); every statement names it explicitly via `t()`.

import postgres from "postgres";
import { AppError } from "../core/types.ts";

export interface Queryable {
  /** Rows of a parameterized statement ($1, $2, …). Never interpolate values into `text`. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Quoted, schema-qualified table name, e.g. t("accounts") → "lanes"."accounts". */
  t(table: string): string;
  readonly schema: string;
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbOptions {
  schema: string;
  /** Pool size (small: one Node process). */
  max?: number;
  statementTimeoutMs?: number;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid SQL identifier "${name}" (lowercase letters, digits and _ only)`);
  return `"${name}"`;
}

/** Connection failures worth one more try; constraint errors and the like are not. */
function transient(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? "";
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "57P01", "57P03", "08006", "08001", "08004"].includes(code);
}

function wrap(e: unknown): never {
  if (e instanceof AppError) throw e;
  if (transient(e)) throw new AppError("OFFLINE", "The database is unavailable; try again shortly");
  throw e;
}

export function connectDb(url: string, opts: DbOptions): Db {
  const schema = quoteIdent(opts.schema);
  const sql = postgres(url, {
    max: opts.max ?? 5,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: false,
    connection: { statement_timeout: opts.statementTimeoutMs ?? 30_000, application_name: "lanes" },
  });
  const run = async <T>(q: { unsafe: typeof sql.unsafe }, text: string, params: unknown[] = []): Promise<T[]> =>
    (await q.unsafe(text, params as never[])) as unknown as T[];
  return {
    schema: opts.schema,
    t: (table) => `${schema}.${quoteIdent(table)}`,
    async query<T>(text: string, params?: unknown[]) {
      // Reads and idempotent writes only go through query(): retry a dropped connection once.
      try {
        return await run<T>(sql, text, params);
      } catch (e) {
        if (!transient(e)) throw e;
        await new Promise((r) => setTimeout(r, 250));
        return run<T>(sql, text, params).catch(wrap);
      }
    },
    async transaction<T>(fn: (q: Queryable) => Promise<T>) {
      try {
        return (await sql.begin((tx) => fn({ query: (text, params) => run(tx, text, params) }))) as T;
      } catch (e) {
        return wrap(e); // never retried: the caller decides
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
