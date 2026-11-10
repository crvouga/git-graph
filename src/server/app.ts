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
import { AccountStore } from "./accounts.ts";
import { Auth } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { connectDb, type Db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { Oidc } from "./oidc.ts";
import { TokenBox } from "./token-box.ts";
import { GitHubResolver, makeAdapter, parseGitHubKey, type GitHubEnv } from "./resolver.ts";
import { clientIp, csrfGuard, errorResponse, rateLimit, securityHeaders, TokenBuckets } from "./security.ts";
import { SessionStore } from "./session.ts";
import { StaticSite } from "./static.ts";
import { Poller } from "./sync/poller.ts";
import { Reconciler } from "./sync/reconciler.ts";
import { SubscriptionRegistry, type Principal } from "./sync/subscriptions.ts";
import { Webhooks } from "./sync/webhooks.ts";
import { GitHubAgent } from "./zero/github-agent.ts";
import { createZeroRoutes, startZeroCache, zeroHttpProxy, zeroUpgradeProxy, type ZeroCacheHandle } from "./zero/server.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

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
  db: Db | null;
  accounts: AccountStore | null;
  /** The server's GitHub source agent (null without a database). */
  githubAgent: GitHubAgent | null;
  /** Start the embedded zero-cache once the HTTP server listens on `port` (no-op with ZERO_CACHE_URL). */
  startZero(port: number): void;
  /** Node `upgrade` handler: WebSocket sync under /zero. Returns false for other paths. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Resolves when the database is migrated (immediately without a database). */
  ready(): Promise<void>;
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
    idleTtlMs: config.sessionIdleTtlMs,
    absoluteTtlMs: config.sessionAbsoluteTtlMs,
  });

  // Durable state: PostgreSQL (accounts, connected GitHub, and every Zero-synced table).
  const signInConfigured = !!(config.oidc && config.databaseUrl && config.tokenEncryptionKey);
  const db = config.databaseUrl ? connectDb(config.databaseUrl, { schema: config.databaseSchema, max: config.databasePoolMax }) : null;
  const accounts = db && signInConfigured ? new AccountStore(db, new TokenBox(config.tokenEncryptionKey!)) : null;
  const oidc = signInConfigured ? new Oidc({ ...config.oidc!, fetch: config.fetch }) : null;
  // Migrate at boot, retrying with back-off: a database outage must not crash-loop the server
  // (the health check never touches the database); sign-in waits for it instead.
  let closed = false;
  let readyResolve!: () => void;
  const readyPromise = new Promise<void>((r) => (readyResolve = r));
  if (!db || !config.migrateOnBoot) readyResolve();
  else {
    void (async () => {
      for (let attempt = 0; !closed; attempt++) {
        try {
          const applied = await migrate(db);
          log("info", "database ready", { schema: db.schema, applied });
          readyResolve();
          return;
        } catch (e) {
          const wait = Math.min(60_000, 1000 * 2 ** attempt);
          log("error", "database migration failed; retrying", { error: e instanceof Error ? e.message : String(e), retryInMs: wait });
          await new Promise((r) => setTimeout(r, wait).unref?.());
        }
      }
    })();
  }
  const ready = () =>
    Promise.race([readyPromise, new Promise<never>((_, rej) => setTimeout(() => rej(new AppError("OFFLINE", "The database is not ready yet")), 10_000).unref?.())]);

  // Late-bound to break the construction cycle (client → auth → client).
  let auth: Auth | null = null;
  const github = new GitHubClient({
    apiUrl: config.githubApiUrl,
    webUrl: config.githubWebUrl,
    fetch: fetchFn,
    onUnauthorized: (tid) => void auth?.tokenRejected(tid),
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
    accounts,
    oidc,
    github,
    fetch: fetchFn,
    now,
    log,
    ready,
    // Only this session's streams: the same person may be signed in elsewhere.
    onSessionEnded: (s) => registry.revoke((p) => !!p && p.sessionKey === s.key),
    onGitHubDisconnected: (githubUserId, accountId) => {
      registry.revoke((p) => !!p && (p.userId === githubUserId || (accountId !== null && p.accountId === accountId)));
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
    hub,
    reconciler: rec,
    log,
    onAccessChanged: dropAuthorization,
    onActivity: (repo) => poll.bump(repo),
    onUserRevoked: (userId, login) => {
      log("info", "app authorization revoked", { login });
      // The person stays signed in to Lanes; their GitHub connection is gone.
      void accounts?.unlinkGitHubUser(userId).catch((e) => log("error", "unlink after revocation failed", { error: e instanceof Error ? e.message : String(e) }));
      registry.revoke((p) => p?.userId === userId);
    },
  });

  const ANONYMOUS: Principal = { sessionKey: null, accountId: null, userId: null, token: async () => null };
  /** Set by the /api middleware (resolving it reads the account). */
  const principalOf = (c: Context): Principal => (c.get("principal") as Principal | undefined) ?? ANONYMOUS;

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
    return s?.accountId ? `s:${s.key}` : `ip:${clientIp(c, config.trustProxy)}`;
  };

  app.use("*", securityHeaders(config.appOrigin));
  app.use("*", async (c, next) => {
    await next();
    authInst.commit(c);
    const path = c.req.path;
    if (path.startsWith("/auth/") || (c.res.headers.get("content-type") ?? "").includes("text/html")) authInst.commitBoot(c);
  });
  app.onError((err, c) => {
    const e = AppError.from(err);
    if (e.code === "INTERNAL") log("error", "unhandled error", { error: err instanceof Error ? err.message : String(err), path: new URL(c.req.url).pathname });
    return errorResponse(c, e);
  });

  app.get("/health", (c) => c.json({ ok: true, epoch: hub.epoch }));

  // --- Zero sync: the web client's only data path ---
  let githubAgent: GitHubAgent | null = null;
  let zeroCache: ZeroCacheHandle | null = null;
  const zeroTarget = () => config.zero?.cacheUrl ?? zeroCache?.url ?? null;
  if (db && config.zero) {
    githubAgent = new GitHubAgent({
      db,
      env,
      registry,
      githubToken: (accountId) =>
        accounts
          ? authInst.githubToken(accountId).catch((e) => {
              log("warn", "GitHub token unavailable", { error: AppError.from(e).message });
              return null;
            })
          : Promise.resolve(null),
      appOrigin: config.appOrigin,
      webhooks: !!config.webhookSecret,
      log,
    });
    const agent = githubAgent;
    void readyPromise.then(() => !closed && agent.start());
    app.route(
      "/",
      createZeroRoutes({
        config,
        zero: config.zero,
        db,
        sessionAccount: (c) => authInst.readSession(c)?.accountId ?? null,
        kick: () => agent.kick(),
        log,
      }),
    );
  }
  app.all("/zero/*", zeroHttpProxy(zeroTarget));

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
  app.use("/api/*", async (c, next) => {
    const p = await authInst.principal(c);
    c.set("principal", p);
    return registry.als.run(p, () => next());
  });

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
    db,
    accounts,
    githubAgent,
    startZero(port: number) {
      if (!db || !config.zero || config.zero.cacheUrl || zeroCache) return;
      zeroCache = startZeroCache({ zero: config.zero, serverPort: port, schema: config.databaseSchema, log });
    },
    upgrade: zeroUpgradeProxy(zeroTarget),
    ready: () => readyPromise,
    async close() {
      closed = true;
      githubAgent?.close();
      await zeroCache?.close();
      poll.close();
      rec.close();
      webhooks.close();
      await db?.close();
    },
  };
}
