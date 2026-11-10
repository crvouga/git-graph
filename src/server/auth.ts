// GitHub sign-in: OAuth authorization-code flow with PKCE (S256) and a single-use `state` bound
// to the pre-login session cookie. Works for GitHub Apps (user-to-server tokens, 8h expiry with
// refresh tokens) and OAuth Apps (non-expiring tokens, optional scopes).
//
// Sessions are sealed cookies (see session.ts). Handlers change the request's Session object;
// `commit` (run after every request) re-issues the cookie when it changed or ended.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { generateCookie, getCookie } from "hono/cookie";
import { AppError } from "../core/types.ts";
import type { GitHubClient } from "../github/client.ts";
import type { ServerConfig } from "./config.ts";
import type { CookieView, GitHubTokens, Session, SessionStore } from "./session.ts";
import { errorResponse } from "./security.ts";

const STATE_TTL_MS = 10 * 60_000;
/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface AuthOptions {
  config: ServerConfig;
  sessions: SessionStore;
  github: GitHubClient;
  fetch: typeof fetch;
  now: () => number;
  log: NonNullable<ServerConfig["log"]>;
  /** Called when a session signs out or is ended (to close its event streams). */
  onSessionEnded: (s: Session, userId: number | null) => void;
}

/** Validate a post-login redirect: same-origin relative path only. */
export function safeReturnTo(raw: string | undefined, appOrigin: string): string | null {
  if (raw === undefined || raw === "") return "/";
  if (raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\x00-\x1f\\]/.test(raw)) return null;
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
  /** Keyed by session id: concurrent requests of one session share a single refresh. */
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly requests = new WeakMap<Request, RequestSession>();

  constructor(o: AuthOptions) {
    this.o = o;
    this.secure = o.config.appOrigin.startsWith("https://");
    // __Host- requires Secure; plain-http dev origins use an unprefixed name.
    this.cookieName = this.secure ? "__Host-lanes_session" : "lanes_session";
  }

  get configured(): boolean {
    return !!(this.o.config.githubClientId && this.o.config.githubClientSecret);
  }

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

  expiresAt(s: Session): number {
    return Math.min(s.lastSeenAt + this.o.config.sessionIdleTtlMs, s.createdAt + this.o.config.sessionAbsoluteTtlMs);
  }

  /** End a signed-in session (logout, revoked refresh, GitHub revoked the token). */
  endSession(s: Session, reason: string) {
    const userId = s.user?.id ?? null;
    if (s.user) this.o.log("info", "session ended", { reason, login: s.user.login });
    this.o.sessions.destroy(s);
    this.o.onSessionEnded(s, userId);
  }

  /** The session's GitHub access token, refreshed when close to expiry. Throws UNAUTHENTICATED when it cannot be renewed. */
  async accessToken(s: Session | null): Promise<string | null> {
    if (!s?.github) return null;
    const g = s.github;
    if (g.accessTokenExpiresAt === null || this.o.now() < g.accessTokenExpiresAt - REFRESH_SKEW_MS) return g.accessToken;
    const id = s.key;
    let p = this.refreshing.get(id);
    if (!p) {
      p = this.refresh(s).finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, p);
    }
    return p;
  }

  private async refresh(s: Session): Promise<string> {
    const g = s.github!;
    const fail = (why: string): never => {
      this.endSession(s, why);
      throw new AppError("UNAUTHENTICATED", "Your GitHub session expired; sign in again");
    };
    if (!g.refreshToken || (g.refreshTokenExpiresAt !== null && this.o.now() >= g.refreshTokenExpiresAt)) return fail("no refresh token");
    let r: TokenResponse;
    try {
      r = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: g.refreshToken });
    } catch (e) {
      // Network trouble: keep the session, surface a retryable error.
      throw new AppError("UPSTREAM_ERROR", `Could not renew the GitHub session: ${AppError.from(e).message}`);
    }
    if (!r.access_token) return fail(`refresh rejected: ${r.error ?? "unknown"}`);
    s.github = this.tokens(r);
    this.o.sessions.changed(s);
    return r.access_token;
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

  /** GET /api/v1/session */
  async sessionInfo(c: Context) {
    const s = this.readSession(c);
    let authenticated = false;
    if (s?.user) {
      try {
        authenticated = !!(await this.accessToken(s));
      } catch (e) {
        if (AppError.from(e).code !== "UNAUTHENTICATED") authenticated = true; // transient refresh failure
      }
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      authenticated,
      user: authenticated && s?.user ? { login: s.user.login, name: s.user.name, avatarUrl: s.user.avatarUrl } : null,
      expiresAt: authenticated && s ? this.expiresAt(s) : null,
      loginUrl: this.configured ? "/auth/login" : null,
      appSlug: this.o.config.githubAppSlug,
    });
  }

  routes(): Hono {
    const r = new Hono();
    const cfg = this.o.config;

    r.get("/login", (c) => {
      if (!this.configured) return errorResponse(c, new AppError("UNSUPPORTED", "GitHub sign-in is not configured on this server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)"));
      const returnTo = safeReturnTo(c.req.query("returnTo"), cfg.appOrigin);
      if (returnTo === null) return errorResponse(c, new AppError("BAD_REQUEST", "returnTo must be a relative path on this site"));
      const s = this.ensureSession(c);
      const verifier = randomBytes(48).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      s.pending = { state, verifier, returnTo, createdAt: this.o.now() };
      this.o.sessions.changed(s);
      const u = new URL(`${cfg.githubWebUrl}/login/oauth/authorize`);
      u.searchParams.set("client_id", cfg.githubClientId!);
      u.searchParams.set("redirect_uri", `${cfg.appOrigin}/auth/callback`);
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      u.searchParams.set("code_challenge_method", "S256");
      if (cfg.oauthScopes.trim()) u.searchParams.set("scope", cfg.oauthScopes.trim());
      u.searchParams.set("allow_signup", "false");
      c.header("Cache-Control", "no-store");
      return c.redirect(u.toString(), 302);
    });

    r.get("/callback", async (c) => {
      if (!this.configured) return errorResponse(c, new AppError("UNSUPPORTED", "GitHub sign-in is not configured on this server"));
      const s = this.readSession(c);
      const pending = s?.pending ?? null;
      if (s?.pending) {
        s.pending = null; // single use, whatever happens next
        this.o.sessions.changed(s);
      }
      const state = c.req.query("state") ?? "";
      const code = c.req.query("code") ?? "";
      if (!s || !pending || !state || !eq(state, pending.state) || this.o.now() - pending.createdAt > STATE_TTL_MS) {
        return page(400, "Sign-in link expired", "This sign-in attempt is invalid or was already used. Start again from the app.");
      }
      if (c.req.query("error")) return page(400, "Sign-in cancelled", "GitHub did not authorize the sign-in.");
      if (!code) return page(400, "Sign-in failed", "GitHub did not return an authorization code.");
      let tr: TokenResponse;
      try {
        tr = await this.tokenRequest({ code, redirect_uri: `${cfg.appOrigin}/auth/callback`, code_verifier: pending.verifier });
      } catch (e) {
        this.o.log("warn", "token exchange failed", { error: AppError.from(e).message });
        return page(502, "Sign-in failed", "GitHub could not be reached. Try again.");
      }
      if (!tr.access_token) {
        this.o.log("warn", "token exchange rejected", { error: tr.error });
        return page(400, "Sign-in failed", `GitHub rejected the sign-in (${tr.error ?? "unknown error"}). Try again.`);
      }
      let user: { id: number; login: string; name?: string | null; avatar_url?: string | null };
      try {
        user = await this.o.github.get("/user", { token: tr.access_token, noCache: true });
      } catch (e) {
        return page(502, "Sign-in failed", `Could not read your GitHub profile: ${AppError.from(e).message}`);
      }
      s.user = { id: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null };
      s.github = this.tokens(tr);
      s.signedInAt = this.o.now();
      this.o.sessions.rotate(s); // new id after privilege change
      this.o.log("info", "signed in", { login: user.login });
      c.header("Cache-Control", "no-store");
      return c.redirect(pending.returnTo, 302);
    });

    r.post("/logout", (c) => {
      const s = this.readSession(c);
      if (s) this.endSession(s, "logout");
      return c.json({ ok: true });
    });

    return r;
  }
}
