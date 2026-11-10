// Localhost companion service. Binds 127.0.0.1 only and serves the shared /api/v1 over the Git CLI.
//
// Security model (the web app may be hosted on another origin):
//   - Host header must be 127.0.0.1 / localhost / [::1]           (DNS-rebinding protection)
//   - Requests carrying an Origin must match the allowlist           (else 403), CORS echoes only those
//   - Everything except GET /health, POST /pair and CORS preflights requires
//     "Authorization: Bearer <token>" (32 random bytes, stored in the 0600 config file)
//   - Browsers obtain the token by exchanging a one-time pairing code (120 s TTL, single use,
//     rate limited). Codes are created by the CLI through the authenticated POST /pair/code.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { AppError, HTTP_STATUS } from "../core/types.ts";
import { createApi } from "../core/api/router.ts";
import type { RepositoryResolver } from "../core/port.ts";
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_APP_ORIGIN, DEFAULT_PORT, configDir as defaultConfigDir, readConfig, updateConfig } from "./config.ts";
import { createLocalRuntime, type LocalRuntime } from "./runtime.ts";
import { gitVersion } from "./exec.ts";
import type { WatchOptions } from "./watch.ts";

export const COMPANION_VERSION = "0.1.0";
export const PAIR_TTL_MS = 120_000;

export interface CompanionOptions {
  port?: number;
  configDir?: string;
  /** Extra allowed origins (in addition to defaults and LANES_ALLOWED_ORIGINS). */
  allowedOrigins?: string[];
  /** Origin used to build deep links when the request has none. */
  appOrigin?: string;
  fallback?: RepositoryResolver;
  watch?: WatchOptions;
  pairRateLimit?: { max: number; windowMs: number };
  now?: () => number;
}

export interface Companion {
  app: Hono;
  runtime: LocalRuntime;
  allowedOrigins: Set<string>;
  token: () => string;
  createPairingCode(): { code: string; expiresAt: number };
  listen(port?: number): Promise<{ port: number; url: string; close: () => Promise<void> }>;
  close(): void;
}

function normOrigin(o: string): string | null {
  try {
    const u = new URL(o);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function resolveAllowedOrigins(extra: string[] = []): Set<string> {
  const env = (process.env.LANES_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const o of [...DEFAULT_ALLOWED_ORIGINS, ...env, ...extra]) {
    const n = normOrigin(o);
    if (n) out.add(n);
  }
  return out;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostOk(c: Context): boolean {
  const h = c.req.header("host");
  if (!h) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${h}`).hostname;
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function errorJson(c: Context, code: keyof typeof HTTP_STATUS, message: string) {
  return c.json({ error: { code, message } }, HTTP_STATUS[code] as 400);
}

export function createCompanion(opts: CompanionOptions = {}): Companion {
  const dir = opts.configDir ?? defaultConfigDir();
  const now = opts.now ?? Date.now;
  const runtime = createLocalRuntime({ configDir: dir, fallback: opts.fallback, watch: opts.watch });
  const allowed = resolveAllowedOrigins(opts.allowedOrigins);
  const appOrigin = opts.appOrigin ?? process.env.LANES_APP_ORIGIN ?? DEFAULT_APP_ORIGIN;
  const token = readConfig(dir).token;
  const codes = new Map<string, number>();
  const pairAttempts: number[] = [];
  const limit = opts.pairRateLimit ?? { max: 10, windowMs: 60_000 };

  const createPairingCode = () => {
    for (const [k, exp] of codes) if (exp <= now()) codes.delete(k);
    // 10 chars of an unambiguous alphabet (~50 bits); combined with rate limiting and the TTL.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(10);
    let code = "";
    for (const b of bytes) code += alphabet[b % alphabet.length];
    const expiresAt = now() + PAIR_TTL_MS;
    codes.set(code, expiresAt);
    return { code, expiresAt };
  };

  const app = new Hono();

  app.onError((err, c) => {
    const e = AppError.from(err);
    return c.json({ error: e.toJSON() }, (HTTP_STATUS[e.code] ?? 500) as 400);
  });

  // 1. DNS-rebinding protection.
  app.use("*", async (c, next) => {
    if (!hostOk(c)) return errorJson(c, "FORBIDDEN", "Host not allowed: the companion only answers to 127.0.0.1 / localhost");
    await next();
  });

  // 2. Origin allowlist + CORS (no wildcard). Preflights never need auth.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const n = normOrigin(origin);
      if (!n || !allowed.has(n)) return errorJson(c, "FORBIDDEN", `Origin ${origin} is not allowed. Start the companion with --allow-origin ${origin} to permit it.`);
      c.header("Access-Control-Allow-Origin", n);
      c.header("Vary", "Origin");
      c.header("Access-Control-Expose-Headers", "ETag");
      if (c.req.method === "OPTIONS") {
        c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        c.header("Access-Control-Allow-Headers", "authorization, content-type, last-event-id, x-client, if-none-match");
        c.header("Access-Control-Max-Age", "600");
        if (c.req.header("access-control-request-private-network") === "true") c.header("Access-Control-Allow-Private-Network", "true");
        return c.body(null, 204);
      }
    } else if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  });

  app.get("/health", async (c) => {
    const v = await gitVersion();
    return c.json({ name: "lanes-companion", version: COMPANION_VERSION, gitVersion: v.ok ? v.version.join(".") : null, ...(v.ok ? {} : { problem: v.problem }) });
  });

  app.post("/pair", async (c) => {
    const origin = c.req.header("origin");
    if (!origin) return errorJson(c, "FORBIDDEN", "Pairing must come from an allowed browser origin");
    const t = now();
    while (pairAttempts.length && pairAttempts[0]! <= t - limit.windowMs) pairAttempts.shift();
    if (pairAttempts.length >= limit.max) {
      c.header("Retry-After", String(Math.ceil(limit.windowMs / 1000)));
      return errorJson(c, "RATE_LIMITED", "Too many pairing attempts; wait a minute and create a new code");
    }
    pairAttempts.push(t);
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
    const exp = code ? codes.get(code) : undefined;
    if (code) codes.delete(code); // single use, even when expired
    if (!exp || exp <= t) return errorJson(c, "UNAUTHENTICATED", "Invalid or expired pairing code. Run `git-graph pair` for a new one.");
    return c.json({ token, expiresAt: null });
  });

  // 3. Bearer token for everything else.
  app.use("*", async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m || !safeEqual(m[1]!.trim(), token)) {
      c.header("WWW-Authenticate", 'Bearer realm="lanes-companion"');
      return errorJson(c, "UNAUTHENTICATED", "Missing or invalid companion token. Pair this browser with `git-graph open` or `git-graph pair`.");
    }
    await next();
  });

  app.post("/pair/code", (c) => {
    const { code, expiresAt } = createPairingCode();
    return c.json({ code, expiresAt, ttlSeconds: PAIR_TTL_MS / 1000 });
  });

  app.route(
    "/api/v1",
    createApi({
      registry: runtime.registry,
      resolver: () => runtime.local,
      appOrigin: (c) => {
        const o = c.req.header("origin");
        const n = o ? normOrigin(o) : null;
        return n && allowed.has(n) ? n : appOrigin;
      },
      hub: runtime.hub,
      onSubscribe: (key) => runtime.acquire(key).release,
    }),
  );

  return {
    app,
    runtime,
    allowedOrigins: allowed,
    token: () => token,
    createPairingCode,
    async listen(port = opts.port ?? DEFAULT_PORT) {
      return new Promise((resolveListen, reject) => {
        const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info: AddressInfo) => {
          const actual = info.port;
          resolveListen({
            port: actual,
            url: `http://127.0.0.1:${actual}`,
            close: () =>
              new Promise<void>((res) => {
                runtime.close();
                server.close(() => res());
                (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
              }),
          });
        });
        server.on("error", reject);
      });
    },
    close() {
      runtime.close();
    },
  };
}

/** Run the companion in the foreground (used by `git-graph serve` and dist/companion/companion.mjs). */
export async function serveCompanion(opts: CompanionOptions & { quiet?: boolean } = {}) {
  const companion = createCompanion(opts);
  const dir = opts.configDir ?? defaultConfigDir();
  const v = await gitVersion();
  if (!v.ok && !opts.quiet) console.error(`warning: ${v.problem}`);
  const port = opts.port ?? (process.env.LANES_PORT ? Number(process.env.LANES_PORT) : DEFAULT_PORT);
  const l = await companion.listen(port);
  updateConfig((c) => {
    c.port = l.port;
  }, dir);
  if (!opts.quiet) {
    console.error(`Lanes companion listening on ${l.url} (git ${v.version.join(".")})`);
    console.error(`Allowed origins: ${[...companion.allowedOrigins].join(", ")}`);
  }
  const stop = () => {
    void l.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { companion, ...l };
}
