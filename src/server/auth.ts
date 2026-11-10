// Sign-in and the GitHub connection.
//
//  1. Sign in through the shared auth relay (Google via OIDC; oidc.ts). The account is keyed by
//     the relay's (issuer, subject) and stored in PostgreSQL (accounts.ts).
//  2. Connect GitHub: the GitHub App's OAuth flow (authorization code + S256 PKCE, single-use
//     state) links a GitHub account to the signed-in account. Its user-to-server tokens are stored
//     encrypted and refreshed here; they give access to private repositories and live sync.
//
// Sessions are sealed cookies (session.ts) holding the account id and in-flight transactions.
// Handlers change the request's Session object; `commit` (run after every request) re-issues the
// cookie when it changed or ended.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { generateCookie, getCookie } from "hono/cookie";
import { AppError } from "../core/types.ts";
import type { GitHubClient } from "../github/client.ts";
import type { Account, AccountStore, GitHubLink, GitHubTokens } from "./accounts.ts";
import type { ServerConfig } from "./config.ts";
import type { Oidc } from "./oidc.ts";
import type { CookieView, PendingAuth, Session, SessionStore } from "./session.ts";
import { errorResponse } from "./security.ts";
import type { Principal } from "./sync/subscriptions.ts";

const PENDING_TTL_MS = 10 * 60_000;
/** Concurrent sign-in tabs kept per browser; the oldest is dropped. */
const MAX_PENDING = 3;
/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface AuthOptions {
  config: ServerConfig;
  sessions: SessionStore;
  /** Null when sign-in is not configured (no database / relay). */
  accounts: AccountStore | null;
  oidc: Oidc | null;
  github: GitHubClient;
  fetch: typeof fetch;
  now: () => number;
  log: NonNullable<ServerConfig["log"]>;
  /** Resolves once the database is migrated (sign-in waits for it). */
  ready: () => Promise<void>;
  /** A session signed out (close its event streams). */
  onSessionEnded: (s: Session) => void;
  /** A GitHub connection went away (close streams that used it). */
  onGitHubDisconnected: (githubUserId: number, accountId: string | null) => void;
}

/** Validate a post-login redirect: same-origin relative path only. */
export function safeReturnTo(raw: string | undefined, appOrigin: string): string | null {
  if (raw === undefined || raw === "") return "/";
  if (raw.length > 1024 || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\x00-\x1f\\]/.test(raw)) return null;
  try {
    const u = new URL(raw, appOrigin);
    if (u.origin !== appOrigin) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function page(status: number, title: string, text: string): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font:16px system-ui;margin:3rem auto;max-width:36rem;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to Lanes</a></p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

/** What this request's cookie held, and any session it created. */
interface RequestSession {
  hadCookie: boolean;
  view: CookieView | null;
  created: Session | null;
}

export class Auth {
  readonly cookieName: string;
  private readonly o: AuthOptions;
  private readonly secure: boolean;
  /** Keyed by account id: concurrent requests share a single GitHub token refresh. */
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly requests = new WeakMap<Request, RequestSession>();

  constructor(o: AuthOptions) {
    this.o = o;
    const origin = new URL(o.config.appOrigin);
    this.secure = origin.protocol === "https:";
    // __Host- requires Secure. Plain-http dev origins add the port: localhost ports share cookies.
    this.cookieName = this.secure ? "__Host-lanes_session" : `lanes_session_${origin.port || "80"}`;
  }

  /** Relay sign-in is configured. */
  get loginEnabled(): boolean {
    return !!(this.o.oidc && this.o.accounts);
  }

  /** Connecting GitHub is configured. */
  get githubEnabled(): boolean {
    return this.loginEnabled && !!(this.o.config.githubClientId && this.o.config.githubClientSecret);
  }

  // --- cookie session ----------------------------------------------------------------------

  private request(c: Context): RequestSession {
    let r = this.requests.get(c.req.raw);
    if (!r) {
      const raw = getCookie(c, this.cookieName);
      r = { hadCookie: !!raw, view: this.o.sessions.open(raw), created: null };
      this.requests.set(c.req.raw, r);
    }
    return r;
  }

  readSession(c: Context): Session | null {
    const r = this.request(c);
    return r.view?.session ?? r.created;
  }

  private ensureSession(c: Context): Session {
    const r = this.request(c);
    const s = r.view?.session ?? r.created;
    if (s) return s;
    return (r.created = this.o.sessions.create());
  }

  /** After a request: write the session cookie if it changed, needs its idle timeout slid, or ended. */
  commit(c: Context): void {
    const r = this.requests.get(c.req.raw);
    if (!r) return;
    const s = r.view?.session ?? r.created;
    if (!s || this.o.sessions.isEnded(s)) {
      if (r.hadCookie) this.writeCookie(c, null);
      return;
    }
    const v = r.view;
    if (!v || v.cookieKey !== s.key || v.cookieRev !== s.rev || this.o.now() - v.cookieSeenAt >= this.o.sessions.touchMs) {
      this.writeCookie(c, this.o.sessions.seal(s));
    }
  }

  private writeCookie(c: Context, value: string | null) {
    const header = generateCookie(this.cookieName, value ?? "", {
      path: "/",
      httpOnly: true,
      secure: this.secure,
      sameSite: "Lax",
      maxAge: value === null ? 0 : Math.floor(this.o.config.sessionAbsoluteTtlMs / 1000),
    });
    try {
      c.res.headers.append("set-cookie", header);
    } catch {
      // Immutable headers: Hono's setter copies the response into a mutable one.
      c.res = new Response(c.res.body, c.res);
      c.res.headers.append("set-cookie", header);
    }
  }

  /** Name of the readable (not HttpOnly) cookie that tells the web client who it is at startup. */
  get bootCookieName(): string {
    return this.secure ? "__Host-lanes_boot" : this.cookieName.replace("session", "boot");
  }

  /**
   * After an HTML or /auth response: keep the boot cookie in step with the session. Its value is
   * "<account id or empty>.<login enabled><github enabled>", read synchronously by the web client
   * to start Zero with the right user (no session request, nothing to wait for). Not a credential.
   */
  commitBoot(c: Context): void {
    const s = this.readSession(c);
    const uid = s && !this.o.sessions.isEnded(s) ? (s.accountId ?? "") : "";
    const want = `${uid}.${this.loginEnabled ? 1 : 0}${this.githubEnabled ? 1 : 0}`;
    if (getCookie(c, this.bootCookieName) === want) return;
    const header = generateCookie(this.bootCookieName, want, {
      path: "/",
      httpOnly: false,
      secure: this.secure,
      sameSite: "Lax",
      maxAge: Math.floor(this.o.config.sessionAbsoluteTtlMs / 1000),
    });
    try {
      c.res.headers.append("set-cookie", header);
    } catch {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.append("set-cookie", header);
    }
  }

  expiresAt(s: Session): number {
    return Math.min(s.lastSeenAt + this.o.config.sessionIdleTtlMs, s.createdAt + this.o.config.sessionAbsoluteTtlMs);
  }

  /** Sign a session out (logout). The account and its GitHub link stay. */
  endSession(s: Session, reason: string) {
    if (s.accountId) this.o.log("info", "signed out", { reason });
    this.o.sessions.destroy(s);
    this.o.onSessionEnded(s);
  }

  private addPending(s: Session, p: PendingAuth) {
    const t = this.o.now();
    s.pending = [...s.pending.filter((x) => t - x.createdAt < PENDING_TTL_MS), p].slice(-MAX_PENDING);
    this.o.sessions.changed(s);
  }

  /**
   * Take the transaction this callback answers; single use. A state that matches nothing (forged,
   * replayed, expired) also clears every pending transaction of that kind.
   */
  private takePending(s: Session | null, kind: PendingAuth["kind"], state: string): PendingAuth | null {
    if (!s || !s.pending.some((p) => p.kind === kind)) return null;
    const t = this.o.now();
    const hit = state ? s.pending.find((p) => p.kind === kind && eq(p.state, state)) : undefined;
    s.pending = hit ? s.pending.filter((p) => p !== hit) : s.pending.filter((p) => p.kind !== kind);
    this.o.sessions.changed(s);
    return hit && t - hit.createdAt <= PENDING_TTL_MS ? hit : null;
  }

  // --- accounts and GitHub tokens ----------------------------------------------------------------

  async account(s: Session | null): Promise<Account | null> {
    if (!s?.accountId || !this.o.accounts) return null;
    return this.o.accounts.get(s.accountId);
  }

  /** The principal for API calls and event streams, resolved once per request. */
  async principal(c: Context): Promise<Principal> {
    const s = this.readSession(c);
    const account = await this.account(s).catch(() => null); // database trouble: act anonymously
    const accountId = account?.id ?? null;
    return {
      sessionKey: s?.key ?? null,
      accountId,
      userId: account?.github?.id ?? null,
      token: () => (accountId && account?.github ? this.githubToken(accountId) : Promise.resolve(null)),
    };
  }

  /** The account's GitHub access token, refreshed when close to expiry. Null when not connected. */
  async githubToken(accountId: string): Promise<string | null> {
    const link = await this.o.accounts!.githubLink(accountId);
    if (!link) return null;
    const g = link.tokens;
    if (g.accessTokenExpiresAt === null || this.o.now() < g.accessTokenExpiresAt - REFRESH_SKEW_MS) return g.accessToken;
    let p = this.refreshing.get(accountId);
    if (!p) {
      p = this.refresh(accountId, link).finally(() => this.refreshing.delete(accountId));
      this.refreshing.set(accountId, p);
    }
    return p;
  }

  private async disconnect(accountId: string, githubUserId: number, why: string): Promise<never> {
    await this.o.accounts!.unlinkGitHub(accountId).catch(() => {});
    this.o.log("info", "GitHub disconnected", { reason: why });
    this.o.onGitHubDisconnected(githubUserId, accountId);
    throw new AppError("UNAUTHENTICATED", "Your GitHub connection expired; connect GitHub again");
  }

  private async refresh(accountId: string, link: GitHubLink): Promise<string> {
    const g = link.tokens;
    if (!g.refreshToken || (g.refreshTokenExpiresAt !== null && this.o.now() >= g.refreshTokenExpiresAt)) return this.disconnect(accountId, link.id, "no refresh token");
    let r: TokenResponse;
    try {
      r = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: g.refreshToken });
    } catch (e) {
      // Network trouble: keep the connection, surface a retryable error.
      throw new AppError("UPSTREAM_ERROR", `Could not renew the GitHub connection: ${AppError.from(e).message}`);
    }
    if (!r.access_token) return this.disconnect(accountId, link.id, `refresh rejected: ${r.error ?? "unknown"}`);
    const tokens = this.tokens(r);
    if (!(await this.o.accounts!.updateTokens(accountId, link.version, tokens))) {
      // Someone else stored newer tokens first: use theirs.
      const now = await this.o.accounts!.githubLink(accountId);
      if (!now) throw new AppError("UNAUTHENTICATED", "GitHub is no longer connected");
      return now.tokens.accessToken;
    }
    return tokens.accessToken;
  }

  /** GitHub rejected a token outright: forget the connections that use it. */
  async tokenRejected(tokenId: string): Promise<void> {
    if (!this.o.accounts) return;
    const ids = await this.o.accounts.unlinkToken(tokenId).catch(() => [] as number[]);
    for (const id of ids) {
      this.o.log("info", "GitHub disconnected", { reason: "GitHub rejected the token" });
      this.o.onGitHubDisconnected(id, null);
    }
  }

  private tokens(r: TokenResponse): GitHubTokens {
    const t = this.o.now();
    return {
      accessToken: r.access_token!,
      accessTokenExpiresAt: r.expires_in ? t + r.expires_in * 1000 : null,
      refreshToken: r.refresh_token ?? null,
      refreshTokenExpiresAt: r.refresh_token_expires_in ? t + r.refresh_token_expires_in * 1000 : null,
    };
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const res = await this.o.fetch(`${this.o.config.githubWebUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "lanes-git-graph" },
      body: JSON.stringify({ client_id: this.o.config.githubClientId, client_secret: this.o.config.githubClientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new AppError("UPSTREAM_ERROR", `GitHub token endpoint answered HTTP ${res.status}`);
    return (await res.json()) as TokenResponse;
  }

  /** Best effort: tell GitHub to revoke a token we are dropping. */
  private async revokeAtGitHub(accessToken: string) {
    const cfg = this.o.config;
    const basic = Buffer.from(`${cfg.githubClientId}:${cfg.githubClientSecret}`).toString("base64");
    await this.o
      .fetch(`${cfg.githubApiUrl}/applications/${encodeURIComponent(cfg.githubClientId!)}/token`, {
        method: "DELETE",
        headers: { authorization: `Basic ${basic}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "lanes-git-graph" },
        body: JSON.stringify({ access_token: accessToken }),
        signal: AbortSignal.timeout(5_000),
      })
      .catch(() => {});
  }

  // --- routes ------------------------------------------------------------------------------

  /** GET /api/v1/session */
  async sessionInfo(c: Context) {
    const s = this.readSession(c);
    const account = await this.account(s);
    c.header("Cache-Control", "no-store");
    return c.json({
      authenticated: !!account,
      user: account ? { name: account.name, email: account.email, avatarUrl: account.picture } : null,
      github: account ? (account.github ? { connected: true, login: account.github.login, name: account.github.name, avatarUrl: account.github.avatarUrl } : { connected: false }) : null,
      expiresAt: account && s ? this.expiresAt(s) : null,
      loginUrl: this.loginEnabled ? "/auth/login" : null,
      githubConnectUrl: this.githubEnabled ? "/auth/github/connect" : null,
      appSlug: this.o.config.githubAppSlug,
    });
  }

  routes(): Hono {
    const r = new Hono();
    const cfg = this.o.config;
    const githubCallback = `${cfg.appOrigin}/auth/github/callback`;

    r.get("/login", async (c) => {
      if (!this.loginEnabled) return errorResponse(c, new AppError("UNSUPPORTED", "Sign-in is not configured on this server (OIDC_ISSUER, OIDC_CLIENT_ID, DATABASE_URL, TOKEN_ENCRYPTION_KEY)"));
      const returnTo = safeReturnTo(c.req.query("returnTo"), cfg.appOrigin);
      if (returnTo === null) return errorResponse(c, new AppError("BAD_REQUEST", "returnTo must be a relative path on this site"));
      let start: Awaited<ReturnType<Oidc["start"]>>;
      try {
        start = await this.o.oidc!.start();
      } catch (e) {
        return page(503, "Sign-in unavailable", AppError.from(e).message);
      }
      const s = this.ensureSession(c);
      this.addPending(s, { kind: "login", state: start.tx.state, verifier: start.tx.verifier, nonce: start.tx.nonce, returnTo, createdAt: this.o.now() });
      c.header("Cache-Control", "no-store");
      return c.redirect(start.url, 302);
    });

    r.get("/callback", async (c) => {
      if (!this.loginEnabled) return errorResponse(c, new AppError("UNSUPPORTED", "Sign-in is not configured on this server"));
      const s = this.readSession(c);
      const tx = this.takePending(s, "login", c.req.query("state") ?? "");
      if (!s || !tx) return page(400, "Sign-in link expired", "This sign-in attempt is invalid or was already used. Start again from the app.");
      if (c.req.query("error")) return page(400, "Sign-in cancelled", "The sign-in was not completed.");
      let account: Account;
      try {
        // One exchange per code, never retried.
        const identity = await this.o.oidc!.finish(new URL(c.req.url), { state: tx.state, nonce: tx.nonce!, verifier: tx.verifier });
        await this.o.ready();
        account = await this.o.accounts!.signIn(identity);
      } catch (e) {
        const err = AppError.from(e);
        this.o.log("warn", "sign-in failed", { error: err.message });
        return err.code === "UNAUTHENTICATED" ? page(400, "Sign-in failed", err.message) : page(503, "Sign-in unavailable", "Lanes could not complete the sign-in. Try again shortly.");
      }
      s.accountId = account.id;
      s.signedInAt = this.o.now();
      this.o.sessions.rotate(s); // new id after privilege change
      this.o.log("info", "signed in", { account: account.id });
      c.header("Cache-Control", "no-store");
      return c.redirect(tx.returnTo, 302);
    });

    r.post("/logout", (c) => {
      const s = this.readSession(c);
      if (s) this.endSession(s, "logout");
      return c.json({ ok: true });
    });

    r.get("/github/connect", async (c) => {
      if (!this.githubEnabled) return errorResponse(c, new AppError("UNSUPPORTED", "Connecting GitHub is not configured on this server"));
      const returnTo = safeReturnTo(c.req.query("returnTo"), cfg.appOrigin);
      if (returnTo === null) return errorResponse(c, new AppError("BAD_REQUEST", "returnTo must be a relative path on this site"));
      const s = this.readSession(c);
      if (!s?.accountId) {
        // Sign in first, then come back here.
        const back = `/auth/github/connect?returnTo=${encodeURIComponent(returnTo)}`;
        return c.redirect(`/auth/login?returnTo=${encodeURIComponent(back)}`, 302);
      }
      const verifier = randomBytes(48).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      this.addPending(s, { kind: "github", state, verifier, nonce: null, returnTo, createdAt: this.o.now() });
      const u = new URL(`${cfg.githubWebUrl}/login/oauth/authorize`);
      u.searchParams.set("client_id", cfg.githubClientId!);
      u.searchParams.set("redirect_uri", githubCallback);
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      u.searchParams.set("code_challenge_method", "S256");
      if (cfg.oauthScopes.trim()) u.searchParams.set("scope", cfg.oauthScopes.trim());
      u.searchParams.set("allow_signup", "false");
      c.header("Cache-Control", "no-store");
      return c.redirect(u.toString(), 302);
    });

    r.get("/github/callback", async (c) => {
      if (!this.githubEnabled) return errorResponse(c, new AppError("UNSUPPORTED", "Connecting GitHub is not configured on this server"));
      const s = this.readSession(c);
      const tx = this.takePending(s, "github", c.req.query("state") ?? "");
      const code = c.req.query("code") ?? "";
      if (!s?.accountId || !tx) return page(400, "Connection link expired", "This GitHub connection attempt is invalid or was already used. Start again from the app.");
      if (c.req.query("error")) return page(400, "Connection cancelled", "GitHub did not authorize the connection.");
      if (!code) return page(400, "Connection failed", "GitHub did not return an authorization code.");
      let tr: TokenResponse;
      try {
        tr = await this.tokenRequest({ code, redirect_uri: githubCallback, code_verifier: tx.verifier });
      } catch (e) {
        this.o.log("warn", "token exchange failed", { error: AppError.from(e).message });
        return page(502, "Connection failed", "GitHub could not be reached. Try again.");
      }
      if (!tr.access_token) {
        this.o.log("warn", "token exchange rejected", { error: tr.error });
        return page(400, "Connection failed", `GitHub rejected the connection (${tr.error ?? "unknown error"}). Try again.`);
      }
      let user: { id: number; login: string; name?: string | null; avatar_url?: string | null };
      try {
        user = await this.o.github.get("/user", { token: tr.access_token, noCache: true });
      } catch (e) {
        return page(502, "Connection failed", `Could not read your GitHub profile: ${AppError.from(e).message}`);
      }
      try {
        await this.o.accounts!.linkGitHub(s.accountId, { id: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null }, this.tokens(tr));
      } catch (e) {
        const err = AppError.from(e);
        if (err.code === "CONFLICT") {
          await this.revokeAtGitHub(tr.access_token);
          return page(409, "GitHub account already connected", err.message);
        }
        return page(503, "Connection failed", "Lanes could not save the connection. Try again shortly.");
      }
      this.o.log("info", "GitHub connected", { account: s.accountId, login: user.login });
      c.header("Cache-Control", "no-store");
      return c.redirect(tx.returnTo, 302);
    });

    r.post("/github/disconnect", async (c) => {
      const s = this.readSession(c);
      if (!s?.accountId || !this.o.accounts) return errorResponse(c, new AppError("UNAUTHENTICATED", "Sign in first"));
      const link = await this.o.accounts.githubLink(s.accountId);
      const id = await this.o.accounts.unlinkGitHub(s.accountId);
      if (link) await this.revokeAtGitHub(link.tokens.accessToken);
      if (id !== null) this.o.onGitHubDisconnected(id, s.accountId);
      return c.json({ ok: true });
    });

    return r;
  }
}
