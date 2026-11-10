// Zero on the hosted server:
//
//   /internal/zero/query, /internal/zero/mutate   called by zero-cache (X-Api-Key). The caller is
//       the browser's session cookie (forwarded by zero-cache) or a companion's bearer token.
//   /agent-api/v1/*                                companion registration (token + pairing code)
//   /zero/*                                        reverse proxy to zero-cache (HTTP + WebSocket),
//       so browsers sync with the same origin and send the session cookie.
//
// zero-cache runs as a child process (or externally with ZERO_CACHE_URL).

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { mustGetMutator, mustGetQuery } from "@rocicorp/zero";
import { handleMutateRequest, handleQueryRequest } from "@rocicorp/zero/server";
import { zeroPostgresJS } from "@rocicorp/zero/server/adapters/postgresjs";
import { Hono, type Context } from "hono";
import { AppError } from "../../core/types.ts";
import { queries } from "../../zero/queries.ts";
import { schema, type ZeroContext } from "../../zero/schema.ts";
import type { ServerConfig, ZeroConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { zeroPublication } from "../migrations.ts";
import { errorResponse, TokenBuckets, clientIp } from "../security.ts";
import { createServerMutators, hashSecret } from "./mutators.ts";

type Log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface ZeroServerOptions {
  config: ServerConfig;
  zero: ZeroConfig;
  db: Db;
  /** The signed-in account of the request's session cookie (null when signed out). */
  sessionAccount: (c: Context) => string | null;
  kick: (repoId: string | null) => void;
  log: Log;
}

export interface Caller {
  ctx: ZeroContext;
  /** The Zero userID the client connected with ("" when signed out). */
  userID: string;
}

const CLAIM_TTL_MS = 10 * 60_000;

function eq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createZeroRoutes(o: ZeroServerOptions): Hono {
  const { db, zero } = o;
  const t = db.t;
  const dbProvider = zeroPostgresJS(schema, db.sql as unknown as Parameters<typeof zeroPostgresJS>[1]);
  const serverMutators = createServerMutators({ t, kick: o.kick });
  const buckets = new TokenBuckets(10, 0.2);

  async function caller(c: Context): Promise<Caller> {
    const auth = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) {
      const [agent] = await db.query<{ id: string; account_id: string | null }>(`select id, account_id from ${t("agents")} where token_hash = $1`, [hashSecret(m[1]!.trim())]);
      if (!agent) throw new AppError("UNAUTHENTICATED", "Unknown companion token. Run `git-graph pair` again.");
      return { ctx: { accountId: agent.account_id, agentId: agent.id }, userID: `agent:${agent.id}` };
    }
    const accountId = o.sessionAccount(c);
    return { ctx: { accountId, agentId: null }, userID: accountId ?? "" };
  }

  const r = new Hono();

  r.use("/internal/zero/*", async (c, next) => {
    const key = c.req.header("x-api-key") ?? "";
    if (!eq(key, zero.apiKey)) return errorResponse(c, new AppError("FORBIDDEN", "zero-cache only"));
    await next();
  });

  r.post("/internal/zero/query", async (c) => {
    const { ctx, userID } = await caller(c);
    const result = await handleQueryRequest({ handler: (name, args) => mustGetQuery(queries, name).fn({ args, ctx }), schema, request: c.req.raw, userID: userID || null });
    return c.json(result);
  });

  r.post("/internal/zero/mutate", async (c) => {
    const { ctx, userID } = await caller(c);
    const result = await handleMutateRequest({
      dbProvider,
      handler: (transact) => transact((tx, name, args) => mustGetMutator(serverMutators, name).fn({ args, tx, ctx })),
      request: c.req.raw,
      userID: userID || null,
    });
    return c.json(result);
  });

  // --- companion registration (bearer-authenticated, not a browser surface) ---

  /** A new companion: an agent token (kept by the companion) and a one-time pairing code. */
  r.post("/agent-api/v1/register", async (c) => {
    if (buckets.take(`ip:${clientIp(c, o.config.trustProxy)}`) > 0) return errorResponse(c, new AppError("RATE_LIMITED", "Too many registrations; try again later"));
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.slice(0, 100) : "Companion";
    const id = `companion-${randomBytes(9).toString("base64url")}`;
    const token = randomBytes(32).toString("base64url");
    const code = randomBytes(12).toString("base64url");
    const now = Date.now();
    await db.query(
      `insert into ${t("agents")} (id, account_id, kind, name, token_hash, claim_hash, claim_expires_at, created_at) values ($1, null, 'companion', $2, $3, $4, $5, $6)`,
      [id, name, hashSecret(token), hashSecret(code), now + CLAIM_TTL_MS, now],
    );
    return c.json({ agentId: id, token, code, pairUrl: `${o.config.appOrigin}/#claim=${code}`, expiresAt: now + CLAIM_TTL_MS });
  });

  async function agentOf(c: Context) {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    if (!m) throw new AppError("UNAUTHENTICATED", "Missing companion token");
    const [agent] = await db.query<{ id: string; account_id: string | null; name: string }>(`select id, account_id, name from ${t("agents")} where token_hash = $1`, [hashSecret(m[1]!.trim())]);
    if (!agent) throw new AppError("UNAUTHENTICATED", "Unknown companion token. Run `git-graph pair` again.");
    return agent;
  }

  /** Who this companion belongs to. */
  r.get("/agent-api/v1/me", async (c) => {
    const a = await agentOf(c);
    // accountId goes into the companion's Zero context: its synced queries filter by owner locally too.
    return c.json({ agentId: a.id, name: a.name, paired: !!a.account_id, accountId: a.account_id, userID: `agent:${a.id}`, cacheURL: `${o.config.appOrigin}/zero` });
  });

  /** A fresh pairing code. The current account (if any) stays bound until the code is claimed. */
  r.post("/agent-api/v1/pair", async (c) => {
    const a = await agentOf(c);
    const code = randomBytes(12).toString("base64url");
    const now = Date.now();
    await db.query(`update ${t("agents")} set claim_hash = $2, claim_expires_at = $3 where id = $1`, [a.id, hashSecret(code), now + CLAIM_TTL_MS]);
    return c.json({ agentId: a.id, code, pairUrl: `${o.config.appOrigin}/#claim=${code}`, expiresAt: now + CLAIM_TTL_MS });
  });

  r.onError((err, c) => errorResponse(c, AppError.from(err)));
  return r;
}

// ---------------------------------------------------------------------------------------------
// zero-cache process and proxy
// ---------------------------------------------------------------------------------------------

export interface ZeroCacheHandle {
  /** Base URL zero-cache listens on (loopback). */
  url: string;
  close(): Promise<void>;
}

/** Start zero-cache as a child process pointed at this server's /internal/zero endpoints. */
export function startZeroCache(o: { zero: ZeroConfig; serverPort: number; schema: string; log: Log }): ZeroCacheHandle {
  const z = o.zero;
  const require = createRequire(import.meta.url);
  // The CLI ships inside the package; resolve it from the installed module, not the bundle.
  const cli = process.env.ZERO_CACHE_BIN || join(dirname(require.resolve("@rocicorp/zero")), "cli.js");
  mkdirSync(dirname(z.replicaFile), { recursive: true });
  const base = `http://127.0.0.1:${o.serverPort}/internal/zero`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV,
    ZERO_UPSTREAM_DB: z.upstreamDb,
    ...(z.cvrDb ? { ZERO_CVR_DB: z.cvrDb } : {}),
    ...(z.changeDb ? { ZERO_CHANGE_DB: z.changeDb } : {}),
    ZERO_APP_ID: z.appId,
    ZERO_APP_PUBLICATIONS: zeroPublication(o.schema),
    ZERO_REPLICA_FILE: z.replicaFile,
    ZERO_PORT: String(z.port),
    ZERO_QUERY_URL: `${base}/query`,
    ZERO_MUTATE_URL: `${base}/mutate`,
    ZERO_QUERY_API_KEY: z.apiKey,
    ZERO_MUTATE_API_KEY: z.apiKey,
    ZERO_QUERY_FORWARD_COOKIES: "true",
    ZERO_MUTATE_FORWARD_COOKIES: "true",
    ZERO_ENABLE_CRUD_MUTATIONS: "false",
    ZERO_ADMIN_PASSWORD: z.adminPassword,
    ZERO_LOG_LEVEL: z.logLevel,
    ZERO_LOG_FORMAT: "json",
    ...(z.numSyncWorkers ? { ZERO_NUM_SYNC_WORKERS: String(z.numSyncWorkers) } : {}),
  };
  let child: ChildProcess | null = null;
  let stopping = false;
  let restarts = 0;
  const launch = () => {
    child = spawn(process.execPath, [cli], { env, stdio: ["ignore", "inherit", "inherit"] });
    o.log("info", "zero-cache started", { port: z.port, pid: child.pid });
    child.on("exit", (code, sig) => {
      if (stopping) return;
      const wait = Math.min(30_000, 1000 * 2 ** restarts++);
      o.log("error", "zero-cache exited; restarting", { code, signal: sig, retryInMs: wait });
      setTimeout(() => !stopping && launch(), wait).unref();
    });
  };
  launch();
  return {
    url: `http://127.0.0.1:${z.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        stopping = true;
        const c = child;
        if (!c || c.exitCode !== null) return resolve();
        c.once("exit", () => resolve());
        c.kill("SIGTERM");
        setTimeout(() => {
          c.kill("SIGKILL");
          resolve();
        }, 10_000).unref();
      }),
  };
}

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

/** Plain HTTP requests under /zero (zero-cache's keepalive, statz, …). */
export function zeroHttpProxy(target: () => string | null) {
  return async (c: Context) => {
    const base = target();
    if (!base) return errorResponse(c, new AppError("OFFLINE", "Sync is not configured on this server"));
    const url = new URL(c.req.url);
    const headers = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      if (!HOP.has(k)) headers.set(k, v);
    });
    const init: RequestInit & { duplex?: string } = { method: c.req.method, headers, redirect: "manual" };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      init.body = c.req.raw.body;
      init.duplex = "half";
    }
    const res = await fetch(`${base}${url.pathname}${url.search}`, init).catch(() => null);
    if (!res) return errorResponse(c, new AppError("OFFLINE", "Sync is starting; try again shortly"));
    return new Response(res.body, { status: res.status, headers: res.headers });
  };
}

/** WebSocket upgrades under /zero: piped to zero-cache byte for byte. */
export function zeroUpgradeProxy(target: () => string | null) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (!req.url?.startsWith("/zero/")) return false;
    const base = target();
    if (!base) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return true;
    }
    const u = new URL(base);
    const upstream: Socket = connect(Number(u.port || 80), u.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]!;
        if (k.toLowerCase() === "host") lines.push(`Host: ${u.host}`);
        else lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const end = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", end);
    socket.on("error", end);
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    return true;
  };
}
