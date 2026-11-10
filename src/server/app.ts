// The hosted Lanes server: SPA hosting, GitHub sign-in, the shared /api/v1 (GitHub repositories
// only), webhooks and real-time sync over SSE.

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createApi } from "../core/api/router.ts";
import { createRepoRegistry } from "../core/commands/repo-commands.ts";
import { EventHub } from "../core/sync/hub.ts";
import { AppError, type SyncStatus } from "../core/types.ts";
import { PublicityCache } from "../github/adapter.ts";
import { GitHubClient } from "../github/client.ts";
import { HistoryStateCache } from "../github/history.ts";
import { Auth } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { GitHubResolver, makeAdapter, parseGitHubKey, type GitHubEnv } from "./resolver.ts";
import { clientIp, csrfGuard, errorResponse, rateLimit, securityHeaders, TokenBuckets } from "./security.ts";
import { SessionStore } from "./session.ts";
import { StaticSite } from "./static.ts";
import { Poller } from "./sync/poller.ts";
import { Reconciler } from "./sync/reconciler.ts";
import { SubscriptionRegistry, type Principal } from "./sync/subscriptions.ts";
import { Webhooks } from "./sync/webhooks.ts";

export interface ServerApp {
  app: Hono;
  config: ServerConfig;
  hub: EventHub;
  github: GitHubClient;
  sessions: SessionStore;
  auth: Auth;
  registry: SubscriptionRegistry;
  reconciler: Reconciler;
  poller: Poller;
  webhooks: Webhooks;
  close(): Promise<void>;
}

type Env = { Variables: { principal: Principal; resolver: GitHubResolver } };

function defaultLog(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra ?? {}) });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function createServerApp(config: ServerConfig): ServerApp {
  const log = config.log ?? defaultLog;
  const now = Date.now;
  const fetchFn = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const hub = new EventHub();
  const registry = new SubscriptionRegistry(hub);
  const sessions = new SessionStore({
    secret: config.sessionSecret,
    dataDir: config.dataDir,
    idleTtlMs: config.sessionIdleTtlMs,
    absoluteTtlMs: config.sessionAbsoluteTtlMs,
  });

  // Late-bound to break the construction cycle (client → auth → client).
  let auth: Auth | null = null;
  const github = new GitHubClient({
    apiUrl: config.githubApiUrl,
    webUrl: config.githubWebUrl,
    fetch: fetchFn,
    onUnauthorized: (tid) => {
      for (const s of sessions.findByTokenId(tid)) auth?.endSession(s, "GitHub rejected the token");
    },
  });
  const historyCache = new HistoryStateCache(256, 2_000_000);
  const publicity = new PublicityCache();

  let reconciler: Reconciler | null = null;
  let poller: Poller | null = null;
  const env: GitHubEnv = {
    api: github,
    hub,
    historyCache,
    publicity,
    publicToken: config.publicToken,
    onMutated: (key) => {
      poller?.bump(key);
      reconciler?.request(key).catch(() => {});
    },
  };

  reconciler = new Reconciler({
    hub,
    registry,
    coalesceMs: config.coalesceMs,
    log,
    adapterFor: (repo, token, anonymous) => {
      const { owner, name } = parseGitHubKey(repo);
      return makeAdapter(env, owner, name, anonymous ? null : token, { infoFreshMs: 0 });
    },
  });
  const rec = reconciler;
  poller = new Poller({
    reconciler: rec,
    registry,
    config: config.poller,
    budget: (repo) => {
      const tid = rec.state(repo).lastTokenId;
      return tid ? github.budgetById(tid) : null;
    },
  });
  const poll = poller;

  const authInst = new Auth({
    config,
    sessions,
    github,
    fetch: fetchFn,
    now,
    log,
    onSessionEnded: (s, userId) => {
      // Only this session's streams: the same user may be signed in elsewhere.
      void userId;
      registry.revoke((p) => !!p && p.sessionKey === s.key);
    },
  });
  auth = authInst;

  const dropAuthorization = (repo: string) => {
    publicity.invalidate(repo);
    try {
      const { owner, name } = parseGitHubKey(repo);
      github.invalidateRepo(owner, name);
    } catch {
      /* not a GitHub key */
    }
    historyCache.clear();
  };

  const webhooks = new Webhooks({
    secret: config.webhookSecret,
    dataDir: config.dataDir,
    hub,
    reconciler: rec,
    log,
    onAccessChanged: dropAuthorization,
    onActivity: (repo) => poll.bump(repo),
    onUserRevoked: (userId, login) => {
      log("info", "app authorization revoked", { login });
      for (const s of sessions.findByUserId(userId)) authInst.endSession(s, "app authorization revoked");
      registry.revoke((p) => p?.userId === userId);
    },
  });

  const principalOf = (c: Context): Principal => {
    const existing = c.get("principal") as Principal | undefined;
    if (existing) return existing;
    const s = authInst.readSession(c);
    const p: Principal = { sessionKey: s?.key ?? null, userId: s?.user?.id ?? null, token: () => authInst.accessToken(s) };
    c.set("principal", p);
    return p;
  };

  /** One resolver per request, so the adapter (and its memoized access check) is shared. */
  const resolverOf = (c: Context): GitHubResolver => {
    const hit = c.get("resolver") as GitHubResolver | undefined;
    if (hit) return hit;
    const r = new GitHubResolver(env, principalOf(c).token);
    c.set("resolver", r);
    return r;
  };

  const authorizeRead = async (c: Context, key: string) => {
    const r = new GitHubResolver(env, principalOf(c).token, { infoFreshMs: 0 });
    await (await r.resolve(key)).info({ signal: c.req.raw.signal });
  };

  const app = new Hono<Env>();
  const site = new StaticSite(config.staticDir);
  const apiBuckets = new TokenBuckets(config.apiRateLimit.capacity, config.apiRateLimit.refillPerSec);
  const authBuckets = new TokenBuckets(config.authRateLimit.capacity, config.authRateLimit.refillPerSec);
  const rlKey = (c: Context) => {
    const s = authInst.readSession(c);
    return s?.user ? `s:${s.key}` : `ip:${clientIp(c, config.trustProxy)}`;
  };

  app.use("*", securityHeaders(config.appOrigin));
  app.onError((err, c) => {
    const e = AppError.from(err);
    if (e.code === "INTERNAL") log("error", "unhandled error", { error: err instanceof Error ? err.message : String(err), path: new URL(c.req.url).pathname });
    return errorResponse(c, e);
  });

  app.get("/health", (c) => c.json({ ok: true, epoch: hub.epoch }));

  // --- auth ---
  app.use("/auth/*", csrfGuard(config.appOrigin));
  app.use("/auth/*", rateLimit(authBuckets, (c) => `ip:${clientIp(c, config.trustProxy)}`, "auth"));
  app.route("/auth", authInst.routes());

  // --- webhooks (signature-verified instead of CSRF) ---
  app.post("/webhooks/github", (c) => webhooks.handle(c));

  // --- API ---
  app.use("/api/*", csrfGuard(config.appOrigin));
  app.use("/api/*", rateLimit(apiBuckets, rlKey, "api"));
  app.use("/api/*", bodyLimit({ maxSize: 10 * 1024 * 1024, onError: (c) => errorResponse(c, new AppError("BAD_REQUEST", "Request body too large")) }));
  app.use("/api/*", (c, next) => registry.als.run(principalOf(c), () => next()));

  app.get("/api/v1/session", (c) => authInst.sessionInfo(c));

  // Prove read access before any repository route runs. Without this, the shared command layer
  // reports a failed capability lookup as UNSUPPORTED (501); callers must see the same 404 for
  // "private" and "missing", and UNSUPPORTED only for non-GitHub keys.
  const preAuthorize = async (c: Context, next: () => Promise<void>) => {
    const key = c.req.param("id") ?? "";
    parseGitHubKey(key);
    if (!c.req.path.endsWith("/events") && !c.req.path.endsWith("/sync")) {
      await (await resolverOf(c).resolve(key)).info({ signal: c.req.raw.signal });
    }
    await next();
  };
  app.use("/api/v1/repositories/:id", preAuthorize);
  app.use("/api/v1/repositories/:id/*", preAuthorize);

  app.get("/api/v1/repositories/:id/sync", async (c) => {
    const key = c.req.param("id");
    await authorizeRead(c, key);
    const s = rec.state(key);
    const p = poll.info(key);
    const t = now();
    const covered = s.lastWebhookAt !== null && t - s.lastWebhookAt < config.poller.coverageWindowMs;
    const subscribers = registry.interestCount(key);
    const status: SyncStatus & Record<string, unknown> = {
      repositoryId: key,
      connection: subscribers === 0 ? "offline" : covered ? "live" : "polling",
      lastSuccessAt: s.lastSuccessAt,
      ...(s.lastError ? { lastError: s.lastError } : {}),
      refsVersion: s.lastVersion,
      stale: !!s.lastError || (s.lastSuccessAt !== null && t - s.lastSuccessAt > 2 * config.poller.maxMs),
      pendingOperations: 0,
      subscribers,
      webhook: { covered, lastDeliveryAt: s.lastWebhookAt, configured: !!config.webhookSecret },
      poll: p,
      reconciles: s.reconciles,
      changes: s.changes,
    };
    c.header("Cache-Control", "no-store");
    return c.json(status);
  });

  const api = createApi({
    registry: createRepoRegistry(),
    resolver: (c) => resolverOf(c),
    appOrigin: () => config.appOrigin,
    hub: registry.guardedHub(),
    authorizeEvents: authorizeRead,
    onSubscribe: (key, c) => registry.addInterest(key, principalOf(c)),
    heartbeatMs: config.heartbeatMs,
  });
  app.route("/api/v1", api);

  // --- SPA ---
  app.notFound((c) => {
    const r = site.serve(c);
    if (r) return r;
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/")) return errorResponse(c, new AppError("NOT_FOUND", `No route ${c.req.method} ${path}`));
    return c.text("Not found", 404);
  });

  return {
    app: app as unknown as Hono,
    config,
    hub,
    github,
    sessions,
    auth: authInst,
    registry,
    reconciler: rec,
    poller: poll,
    webhooks,
    async close() {
      poll.close();
      rec.close();
      webhooks.close();
      sessions.close();
    },
  };
}
