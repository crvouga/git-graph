// Server configuration from environment variables. Every variable is documented in .env.example
// and docs/deploy.md.

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withVaultAliases } from "./vault-keys.ts";

export interface RateLimitConfig {
  /** Bucket size (burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export interface PollerConfig {
  /** Poll interval when a repository has no webhook coverage or recent activity. */
  fastMs: number;
  /** Poll interval when webhooks are known to be delivered for the repository. */
  coveredMs: number;
  /** Upper bound of the idle back-off. */
  maxMs: number;
  /** A webhook within this window counts as coverage. */
  coverageWindowMs: number;
  /** ± fraction of random jitter. */
  jitter: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  appOrigin: string;
  production: boolean;
  sessionSecret: string;
  githubClientId: string | null;
  githubClientSecret: string | null;
  githubAppSlug: string | null;
  webhookSecret: string | null;
  githubApiUrl: string;
  githubWebUrl: string;
  publicToken: string | null;
  oauthScopes: string;
  /** Auth relay (OIDC) sign-in. Enabled when issuer, client id, database and token key are set. */
  oidc: { issuer: string; clientId: string; redirectUri: string; scopes: string; idpHint: string } | null;
  /** Opaque PostgreSQL connection URL (Vault DATABASE_URL). Never logged. */
  databaseUrl: string | null;
  /** Lanes' allocated schema (never `public` or a PostgreSQL system schema). */
  databaseSchema: string;
  databasePoolMax: number;
  /** Queries pipelined per connection (tests set 1: PGlite's socket server answers one at a time). */
  databaseMaxPipeline?: number;
  migrateOnBoot: boolean;
  /** Encrypts GitHub tokens stored in PostgreSQL (≥ 32 bytes). */
  tokenEncryptionKey: string | null;
  staticDir: string;
  /** Number of trusted reverse-proxy hops for X-Forwarded-For (0 = ignore the header). */
  trustProxy: number;
  sessionIdleTtlMs: number;
  sessionAbsoluteTtlMs: number;
  apiRateLimit: RateLimitConfig;
  authRateLimit: RateLimitConfig;
  poller: PollerConfig;
  /** Coalescing window for webhook-triggered ref reconciliation. */
  coalesceMs: number;
  /** SSE heartbeat. */
  heartbeatMs: number;
  /** Zero sync (enabled with DATABASE_URL): the web client reads everything through it. */
  zero: ZeroConfig | null;
  /** Test hook: fetch used for GitHub calls. */
  fetch?: typeof fetch;
  /** Log function (defaults to console.log with JSON lines). Never receives tokens. */
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

export interface ZeroConfig {
  /** Internal URL of an external zero-cache (the production sidecar); null = run it as a child process. */
  cacheUrl: string | null;
  /** Port of the embedded zero-cache (loopback only; browsers reach it through /zero). */
  port: number;
  /** Direct (unpooled) PostgreSQL URL zero-cache replicates from. Never logged. */
  upstreamDb: string;
  cvrDb: string | null;
  changeDb: string | null;
  /** zero-cache app id: names its PostgreSQL schemas (<appId>, <appId>_0, <appId>_0/cdc, <appId>_0/cvr). */
  appId: string;
  /** Shared secret zero-cache sends to /internal/zero/* (X-Api-Key). Required with cacheUrl. */
  apiKey: string;
  adminPassword: string;
  /** SQLite replica (a disposable cache: rebuilt from PostgreSQL when missing). */
  replicaFile: string;
  logLevel: string;
  numSyncWorkers: number | null;
}

const DEFAULT_POLLER: PollerConfig = { fastMs: 15_000, coveredMs: 60_000, maxMs: 5 * 60_000, coverageWindowMs: 30 * 60_000, jitter: 0.2 };

/** Schemas that are shared with other apps or owned by PostgreSQL itself. */
const RESERVED_SCHEMAS = new Set(["public", "information_schema", "pg_catalog", "pg_toast"]);
const SCHEMA_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** A dedicated PostgreSQL schema: a lowercase identifier that is not a system or shared schema. */
function schemaName(value: string, variable: string): string {
  if (!SCHEMA_IDENT.test(value)) throw new Error(`${variable} must be a lowercase PostgreSQL identifier (a-z, 0-9, _, not starting with a digit), got "${value}"`);
  if (RESERVED_SCHEMAS.has(value) || value.startsWith("pg_")) {
    throw new Error(`${variable} must not be a system or shared schema ("${value}"); use a dedicated schema such as "lanes"`);
  }
  return value;
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): ServerConfig {
  const env = withVaultAliases(rawEnv);
  const production = env.NODE_ENV === "production";
  const port = num(env.PORT, 8787);
  const databaseUrl = env.DATABASE_URL || null;
  // Lanes may only write inside its own allocated schema. Never `public` or a PostgreSQL schema.
  const databaseSchema = schemaName(env.DATABASE_SCHEMA || "lanes", "DATABASE_SCHEMA");
  if (production && !env.APP_ORIGIN) throw new Error("APP_ORIGIN must be set in production (the public origin, e.g. https://lanes.chrisvouga.dev)");
  const appOrigin = (env.APP_ORIGIN || `http://localhost:${port}`).replace(/\/+$/, "");
  try {
    const u = new URL(appOrigin);
    if (u.origin !== appOrigin) throw new Error();
  } catch {
    throw new Error(`APP_ORIGIN must be an origin like https://git-graph.example.com (got "${appOrigin}")`);
  }
  let sessionSecret = env.SESSION_SECRET ?? "";
  if (Buffer.byteLength(sessionSecret) < 32) {
    if (production) throw new Error("SESSION_SECRET (Vault LANES_SESSION_SECRET) must be set to at least 32 bytes in production (e.g. `openssl rand -base64 48`)");
    sessionSecret = randomBytes(48).toString("base64");
  }
  // Each integration needs all of its parts; a deploy with only some is broken, not "anonymous".
  const groups: [string, string[]][] = [
    ["GitHub App", ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]],
    ["auth relay sign-in", ["OIDC_ISSUER", "OIDC_CLIENT_ID", "TOKEN_ENCRYPTION_KEY"]],
  ];
  for (const [what, keys] of groups) {
    const set = keys.filter((k) => env[k]);
    if (set.length && set.length < keys.length) throw new Error(`${keys.filter((k) => !env[k]).join(", ")} missing: ${what} needs ${keys.join(", ")}`);
  }
  // DATABASE_URL alone enables Zero sync (signed-out browsing); sign-in also needs it.
  if (env.OIDC_ISSUER && !env.DATABASE_URL) throw new Error("DATABASE_URL missing: auth relay sign-in needs OIDC_ISSUER, OIDC_CLIENT_ID, DATABASE_URL, TOKEN_ENCRYPTION_KEY");
  if (env.OIDC_ISSUER && !env.GITHUB_CLIENT_ID) throw new Error("GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET missing: connecting GitHub needs the GitHub App");
  if (env.TOKEN_ENCRYPTION_KEY && Buffer.byteLength(env.TOKEN_ENCRYPTION_KEY) < 32) throw new Error("TOKEN_ENCRYPTION_KEY (Vault LANES_TOKEN_ENCRYPTION_KEY) must be at least 32 bytes");
  if (production && !/^(1|true|yes)$/i.test(env.ALLOW_ANONYMOUS_ONLY ?? "")) {
    const missing = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "DATABASE_URL", "TOKEN_ENCRYPTION_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_WEBHOOK_SECRET"].filter((k) => !env[k]);
    if (missing.length) throw new Error(`${missing.join(", ")} must be set in production (see docs/deploy.md), or set ALLOW_ANONYMOUS_ONLY=1 to run without sign-in and webhooks`);
  }
  const tp = (env.TRUST_PROXY ?? "").trim().toLowerCase();
  const trustProxy = tp === "true" || tp === "yes" ? 1 : tp === "false" || tp === "" ? 0 : Math.max(0, Math.floor(num(tp, 0)));

  const zeroEnabled = !!databaseUrl && !/^(0|false|no)$/i.test(env.ZERO ?? "");
  let zero: ZeroConfig | null = null;
  if (zeroEnabled) {
    const cacheUrl = (env.ZERO_CACHE_URL || "").replace(/\/+$/, "") || null;
    if (cacheUrl) {
      let parsed: URL;
      try {
        parsed = new URL(cacheUrl);
      } catch {
        throw new Error(`ZERO_CACHE_URL must be an http(s) URL (got "${cacheUrl}")`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`ZERO_CACHE_URL must be an http(s) URL (got "${cacheUrl}")`);
      // An external zero-cache must know the same key; a random per-boot key would break it.
      if (!env.ZERO_API_KEY) throw new Error("ZERO_API_KEY must be set when ZERO_CACHE_URL points at an external zero-cache (the server and the sidecar must share it)");
    }
    if (env.ZERO_API_KEY && env.ZERO_API_KEY.length < 16) throw new Error("ZERO_API_KEY must be at least 16 characters (openssl rand -base64 32)");
    const appId = schemaName(env.ZERO_APP_ID || "lanes_zero", "ZERO_APP_ID");
    const zeroSchemas = new Set([appId, `${appId}_0`, `${appId}_0/cdc`, `${appId}_0/cvr`]);
    if (zeroSchemas.has(databaseSchema)) throw new Error(`ZERO_APP_ID must not collide with DATABASE_SCHEMA ("${databaseSchema}"): zero-cache keeps its own state in <ZERO_APP_ID> schemas`);
    zero = {
      cacheUrl,
      port: num(env.ZERO_PORT, 4848),
      upstreamDb: env.ZERO_UPSTREAM_DB || databaseUrl!,
      cvrDb: env.ZERO_CVR_DB || null,
      changeDb: env.ZERO_CHANGE_DB || null,
      appId,
      apiKey: env.ZERO_API_KEY || randomBytes(24).toString("base64url"),
      adminPassword: env.ZERO_ADMIN_PASSWORD || randomBytes(24).toString("base64url"),
      replicaFile: env.ZERO_REPLICA_FILE || join(tmpdir(), `lanes-zero-${port}`, "replica.db"),
      logLevel: env.ZERO_LOG_LEVEL || "warn",
      numSyncWorkers: env.ZERO_NUM_SYNC_WORKERS ? num(env.ZERO_NUM_SYNC_WORKERS, 1) : null,
    };
  }

  return {
    port,
    host: env.HOST || "0.0.0.0",
    appOrigin,
    production,
    sessionSecret,
    githubClientId: env.GITHUB_CLIENT_ID || null,
    githubClientSecret: env.GITHUB_CLIENT_SECRET || null,
    githubAppSlug: env.GITHUB_APP_SLUG || null,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || null,
    githubApiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
    githubWebUrl: (env.GITHUB_WEB_URL || "https://github.com").replace(/\/+$/, ""),
    publicToken: env.GITHUB_PUBLIC_TOKEN || null,
    oauthScopes: env.GITHUB_OAUTH_SCOPES ?? "read:user",
    oidc: env.OIDC_ISSUER
      ? {
          issuer: env.OIDC_ISSUER.replace(/\/+$/, ""),
          clientId: env.OIDC_CLIENT_ID!,
          redirectUri: env.OIDC_REDIRECT_URI || `${appOrigin}/auth/callback`,
          scopes: env.OIDC_SCOPES || "openid email profile",
          idpHint: env.OIDC_IDP_HINT ?? "google",
        }
      : null,
    databaseUrl,
    databaseSchema,
    databasePoolMax: num(env.DATABASE_POOL_MAX, 5),
    migrateOnBoot: !/^(0|false|no)$/i.test(env.MIGRATE_ON_BOOT ?? ""),
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY || null,
    staticDir: resolve(process.cwd(), env.STATIC_DIR || "dist/web"),
    trustProxy,
    sessionIdleTtlMs: num(env.SESSION_IDLE_TTL_HOURS, 24 * 7) * 3600_000,
    sessionAbsoluteTtlMs: num(env.SESSION_ABSOLUTE_TTL_HOURS, 24 * 30) * 3600_000,
    apiRateLimit: { capacity: num(env.RATE_LIMIT_API_BURST, 300), refillPerSec: num(env.RATE_LIMIT_API_PER_SEC, 30) },
    authRateLimit: { capacity: num(env.RATE_LIMIT_AUTH_BURST, 20), refillPerSec: num(env.RATE_LIMIT_AUTH_PER_SEC, 0.2) },
    poller: {
      ...DEFAULT_POLLER,
      fastMs: num(env.POLL_FAST_SECONDS, DEFAULT_POLLER.fastMs / 1000) * 1000,
      maxMs: num(env.POLL_MAX_SECONDS, DEFAULT_POLLER.maxMs / 1000) * 1000,
    },
    coalesceMs: 150,
    heartbeatMs: 15_000,
    zero,
  };
}

/** Config for tests / embedding: defaults with overrides, no env. */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base = loadConfig({ NODE_ENV: "test", APP_ORIGIN: "http://localhost:8787" });
  return { ...base, ...overrides, poller: { ...base.poller, ...(overrides.poller ?? {}) } };
}
