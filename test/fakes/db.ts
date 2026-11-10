// A disposable PostgreSQL for tests: PGlite (Postgres compiled to WASM, in process) served over
// the wire protocol, so the server uses its real driver and SQL. One instance per test process;
// each test stack gets its own schema (the "allocated" schema the app must not create itself).

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export interface TestDb {
  url: string;
  /** Allocate a fresh, empty schema (what crvouga/personal does for a real app). */
  allocateSchema(name?: string): Promise<string>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

let shared: Promise<TestDb> | null = null;
let n = 0;

export async function startTestDb(): Promise<TestDb> {
  const pg = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1", maxConnections: 100 });
  await server.start();
  (server as unknown as { server?: { unref(): void } }).server?.unref();
  const url = `postgres://postgres@127.0.0.1:${(server as unknown as { port: number }).port}/postgres`;
  return {
    url,
    async allocateSchema(name = `lanes_t${process.pid}_${++n}`) {
      await pg.exec(`create schema if not exists "${name}"`);
      return name;
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    async close() {
      await server.stop();
      await pg.close();
    },
  };
}

/** The process-wide test database (started on first use). */
export function testDb(): Promise<TestDb> {
  return (shared ??= startTestDb());
}
