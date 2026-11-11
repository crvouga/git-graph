// A disposable PostgreSQL for tests: PGlite (Postgres compiled to WASM, in process) served over
// the wire protocol, so the server uses its real driver and SQL. One instance per test process;
// each test stack gets its own schema (the "allocated" schema the app must not create itself).
//
// PGlite is a single session, so every client shares one unnamed prepared statement and one
// transaction state. `@electric-sql/pglite-socket` locks per wire message, which lets another
// client (or an in-process `query`) run between a Parse and its Bind ("bind message supplies 2
// parameters, but prepared statement "" requires 1"). This server instead holds PGlite's lock
// from a connection's first message until it ends a message sequence (Sync or a simple Query)
// outside a transaction, so each client sees a private session.

import { PGlite } from "@electric-sql/pglite";
import { createServer, type Socket } from "node:net";

export interface TestDb {
  url: string;
  /** Allocate a fresh, empty schema (what crvouga/personal does for a real app). */
  allocateSchema(name?: string): Promise<string>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

let shared: Promise<TestDb> | null = null;
let n = 0;

const SSL_REQUEST = 80877103;
const CANCEL_REQUEST = 80877102;

/** One client connection: holds PGlite's lock while it is mid-sequence or inside a transaction. */
function serveConnection(pg: PGlite, socket: Socket): void {
  socket.setNoDelay(true);
  let buffer = Buffer.alloc(0);
  let started = false;
  let release: (() => void) | null = null;
  let chain = Promise.resolve();

  const acquire = () =>
    new Promise<void>((held) => {
      void pg.runExclusive(() => new Promise<void>((done) => { release = done; held(); }));
    });
  const unlock = () => { release?.(); release = null; };

  async function run(message: Buffer, type: number | null): Promise<void> {
    if (!release) await acquire();
    await pg.execProtocolRawStream(new Uint8Array(message), {
      onRawData: (data) => { if (data.length && socket.writable) socket.write(Buffer.from(data)); },
    });
    // 'S' Sync and 'Q' Query end a sequence; the startup message ends the handshake.
    if ((type === null || type === 0x53 || type === 0x51) && !pg.isInTransaction()) unlock();
  }

  /** Split complete messages off the buffer, in order. */
  function take(): Array<{ message: Buffer; type: number | null }> {
    const out: Array<{ message: Buffer; type: number | null }> = [];
    for (;;) {
      if (!started) {
        if (buffer.length < 8) break;
        const len = buffer.readInt32BE(0);
        if (buffer.length < len) break;
        const code = buffer.readInt32BE(4);
        const message = buffer.subarray(0, len);
        buffer = buffer.subarray(len);
        if (code === SSL_REQUEST) socket.write("N");
        else if (code !== CANCEL_REQUEST) { started = true; out.push({ message, type: null }); }
        continue;
      }
      if (buffer.length < 5) break;
      const len = 1 + buffer.readInt32BE(1);
      if (buffer.length < len) break;
      out.push({ message: buffer.subarray(0, len), type: buffer[0]! });
      buffer = buffer.subarray(len);
    }
    return out;
  }

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (const { message, type } of take()) {
      if (type === 0x58) { socket.end(); break; } // 'X' Terminate
      chain = chain.then(() => run(message, type)).catch(() => { socket.destroy(); });
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    chain = chain.then(async () => {
      if (!release) return;
      // A client that disconnects mid-transaction must not leave it open for the next one.
      if (pg.isInTransaction()) {
        await pg.execProtocolRawStream(new Uint8Array(simpleQuery("ROLLBACK")), { onRawData: () => {} }).catch(() => {});
      }
      unlock();
    });
  });
}

function simpleQuery(sql: string): Buffer {
  const body = Buffer.from(`${sql}\0`);
  const header = Buffer.alloc(5);
  header[0] = 0x51;
  header.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([header, body]);
}

export async function startTestDb(): Promise<TestDb> {
  const pg = await PGlite.create();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serveConnection(pg, socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const { port } = server.address() as { port: number };
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    async allocateSchema(name = `lanes_t${process.pid}_${++n}`) {
      await pg.exec(`create schema if not exists "${name}"`);
      return name;
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pg.close();
    },
  };
}

/** The process-wide test database (started on first use). */
export function testDb(): Promise<TestDb> {
  return (shared ??= startTestDb());
}
