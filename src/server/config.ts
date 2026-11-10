// Server configuration from environment variables. Every variable is documented in .env.example
// and docs/deploy.md.

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
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
  /** Test hook: fetch used for GitHub calls. */
  fetch?: typeof fetch;
  /** Log function (defaults to console.log with JSON lines). Never receives tokens. */
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

const DEFAULT_POLLER: PollerConfig = { fastMs: 15_000, coveredMs: 60_000, maxMs: 5 * 60_000, coverageWindowMs: 30 * 60_000, jitter: 0.2 };

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): ServerConfig {
  const env = withVaultAliases(rawEnv);
  const production = env.NODE_ENV === "production";
  const port = num(env.PORT, 8787);
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
  // Sign-in needs both halves; a deploy missing either is broken, not "anonymous".
  if (!!env.GITHUB_CLIENT_ID !== !!env.GITHUB_CLIENT_SECRET) {
    throw new Error(`${env.GITHUB_CLIENT_ID ? "GITHUB_CLIENT_SECRET" : "GITHUB_CLIENT_ID"} is missing (both GitHub App credentials are needed for sign-in)`);
  }
  if (production && !/^(1|true|yes)$/i.test(env.ALLOW_ANONYMOUS_ONLY ?? "")) {
    const missing = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_WEBHOOK_SECRET"].filter((k) => !env[k]);
    if (missing.length) throw new Error(`${missing.join(", ")} must be set in production (from Vault LANES_${missing[0]}), or set ALLOW_ANONYMOUS_ONLY=1 to run without sign-in and webhooks`);
  }
  const tp = (env.TRUST_PROXY ?? "").trim().toLowerCase();
  const trustProxy = tp === "true" || tp === "yes" ? 1 : tp === "false" || tp === "" ? 0 : Math.max(0, Math.floor(num(tp, 0)));
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
  };
}

/** Config for tests / embedding: defaults with overrides, no env. */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base = loadConfig({ NODE_ENV: "test", APP_ORIGIN: "http://localhost:8787" });
  return { ...base, ...overrides, poller: { ...base.poller, ...(overrides.poller ?? {}) } };
}
