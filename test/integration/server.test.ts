import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupGitHubFixture } from "../fakes/github.ts";
import { CookieJar, ORIGIN, startFake, startStack, sleep, type Stack } from "../fakes/server-harness.ts";
import type { FakeGitHub } from "../fakes/github.ts";

let fake: FakeGitHub;
let s: Stack;

beforeAll(async () => {
  ({ fake } = await startFake());
  s = await startStack({ fake });
}, 60_000);

afterAll(async () => {
  await s?.close();
  await fake?.close();
  cleanupGitHubFixture();
});

const KEY = "github:octo:basic";
const SECRET = "github:octo:secret";
const post = (path: string, body: unknown, jar?: CookieJar, headers: Record<string, string> = { origin: ORIGIN }) =>
  s.req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers }, jar });

describe("security headers and static hosting", () => {
  it("sets strict security headers on every response", async () => {
    for (const path of ["/", "/api/v1/session", "/health", "/api/v1/nope", "/auth/login?returnTo=//x"]) {
      const r = await s.req(path);
      const csp = r.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self' http://127.0.0.1:* http://localhost:*");
      expect(csp).toContain("img-src 'self' data: blob: https://avatars.githubusercontent.com");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("permissions-policy")).toContain("camera=()");
      expect(r.headers.get("strict-transport-security")).toBeNull(); // http origin
    }
  });

  it("adds HSTS and __Host- cookies for https origins", async () => {
    const https = await startStack({ fake, config: { appOrigin: "https://lanes.example.com" } });
    try {
      expect((await https.req("/health")).headers.get("strict-transport-security")).toContain("max-age=");
      fake.authorizingUser = "alice";
      const r = await https.req("/auth/login");
      const cookie = r.headers.getSetCookie()[0]!;
      expect(cookie).toMatch(/^__Host-lanes_session=/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Domain=/i);
    } finally {
      await https.close();
    }
  });

  it("serves the SPA shell for app routes and immutable hashed assets", async () => {
    for (const path of ["/", "/github/octo/basic?branches=main&commit=abc", "/github/vercel/next.js", "/local/abc"]) {
      const r = await s.req(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("cache-control")).toBe("no-cache");
      expect(await r.text()).toContain('<div id="app">');
    }
    const asset = await s.req("/assets/app-AbC123xy.js", { headers: { "accept-encoding": "br, gzip" } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-encoding")).toBe("br");
    expect(Number(asset.headers.get("content-length"))).toBeLessThan(1000);
    expect((await s.req("/assets/app-AbC123xy.js", { headers: { "accept-encoding": "gzip" } })).headers.get("content-encoding")).toBe("gzip");
    expect((await s.req("/robots.txt")).status).toBe(200);
    expect((await s.req("/assets/missing-12345678.js")).status).toBe(404);
    expect((await s.req("/favicon.ico")).status).toBe(404);
    expect((await s.req("/../../etc/passwd")).status).not.toBe(500);
    const apiMiss = await s.req("/api/v1/does-not-exist");
    expect(apiMiss.status).toBe(404);
    expect(await apiMiss.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

const session = async (jar?: CookieJar, stack: Stack = s) => (await stack.req("/api/v1/session", { jar })).json();

/** Start a relay sign-in and return the callback path the relay sends the browser to. */
async function relayCallback(jar: CookieJar, who = "alice", returnTo = "/") {
  s.relay.authorizingSubject = who;
  const r1 = await s.req(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { jar });
  expect(r1.status).toBe(302);
  const r2 = await fetch(r1.headers.get("location")!, { redirect: "manual" });
  const cb = new URL(r2.headers.get("location")!);
  return { authorize: new URL(r1.headers.get("location")!), callback: cb.pathname + cb.search };
}

describe("sign-in through the auth relay", () => {
  it("login → callback → session; the cookie holds no identity or token", async () => {
    const jar = new CookieJar();
    await s.signIn("alice", jar, "/github/octo/basic?commit=abc");
    const preLogin = jar.raw[0]!.split(";")[0];
    const final = jar.raw[jar.raw.length - 1]!.split(";")[0];
    expect(final).not.toBe(preLogin); // session id rotated on login
    expect(jar.raw[0]).toMatch(/HttpOnly/);
    expect(jar.raw[0]).toMatch(/SameSite=Lax/);
    expect(jar.header()).not.toMatch(/alice/i);
    const r = await s.req("/api/v1/session", { jar });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(body).toMatchObject({ authenticated: true, user: { name: "Alice", email: "alice@example.com" }, github: { connected: false }, githubConnectUrl: "/auth/github/connect" });
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    const rows = await s.db.query<{ oidc_issuer: string; oidc_subject: string }>(`select oidc_issuer, oidc_subject from "${s.config.databaseSchema}".accounts where oidc_subject = 'alice'`);
    expect(rows).toEqual([{ oidc_issuer: s.relay.issuer, oidc_subject: "alice" }]);
  });

  it("sends a public-client PKCE request with state and nonce, and returns to the page it started from", async () => {
    const jar = new CookieJar();
    const { authorize, callback } = await relayCallback(jar, "alice", "/github/octo/basic?commit=abc");
    const q = authorize.searchParams;
    expect(authorize.origin + authorize.pathname).toBe(`${s.relay.issuer}/protocol/openid-connect/auth`);
    expect(q.get("client_id")).toBe(s.relay.clientId);
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toBeTruthy();
    expect(q.get("nonce")).toBeTruthy();
    expect(q.get("kc_idp_hint")).toBe("google");
    expect(q.has("client_secret")).toBe(false);
    const r = await s.req(callback, { jar });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/github/octo/basic?commit=abc");
  });

  for (const tamper of ["nonce", "audience", "issuer", "signature", "expired"] as const) {
    it(`rejects an ID token with a bad ${tamper}`, async () => {
      const jar = new CookieJar();
      const { callback } = await relayCallback(jar);
      s.relay.tamper = tamper;
      try {
        const r = await s.req(callback, { jar });
        expect(r.status).toBe(400);
        expect((await session(jar)).authenticated).toBe(false);
      } finally {
        s.relay.tamper = null;
      }
    });
  }

  it("rejects state replay, forged state and callbacks without the pre-login cookie", async () => {
    const jar = new CookieJar();
    const { callback } = await relayCallback(jar);
    expect((await s.req(callback)).status).toBe(400); // another browser (no cookie)
    const forged = new URL(callback, ORIGIN);
    forged.searchParams.set("state", "forged");
    expect((await s.req(forged.pathname + forged.search, { jar })).status).toBe(400);
    // the forged attempt cleared the pending sign-in: the genuine callback now fails too
    expect((await s.req(callback, { jar })).status).toBe(400);

    const jar2 = new CookieJar();
    const ok = await relayCallback(jar2);
    const tokenRequests = s.relay.tokenRequests;
    expect((await s.req(ok.callback, { jar: jar2 })).status).toBe(302);
    expect((await s.req(ok.callback, { jar: jar2 })).status).toBe(400); // replay
    expect(s.relay.tokenRequests).toBe(tokenRequests + 1); // the code was exchanged once
  });

  it("keeps concurrent sign-ins in separate tabs apart", async () => {
    const jar = new CookieJar();
    const a = await relayCallback(jar, "alice", "/tab-a");
    const b = await relayCallback(jar, "alice", "/tab-b");
    const rb = await s.req(b.callback, { jar });
    expect(rb.headers.get("location")).toBe("/tab-b");
    const ra = await s.req(a.callback, { jar });
    expect(ra.status).toBe(302);
    expect(ra.headers.get("location")).toBe("/tab-a");
  });

  it("identifies people by (issuer, subject), never by email", async () => {
    s.relay.people.set("mallory", { email: "alice@example.com", name: "Mallory" });
    try {
      const alice = await s.signIn("alice");
      const mallory = await s.signIn("mallory");
      await s.connectGitHub("alice", alice);
      expect((await session(alice)).github).toMatchObject({ connected: true, login: "alice" });
      expect((await session(mallory)).github).toEqual({ connected: false }); // same email, different person
      expect((await s.req(`/api/v1/repositories/${SECRET}`, { jar: mallory })).status).toBe(404);
    } finally {
      s.relay.people.delete("mallory");
    }
  });

  it("rejects open redirects in returnTo", async () => {
    for (const bad of ["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "evil", `/${"x".repeat(1100)}`]) {
      const r = await s.req(`/auth/login?returnTo=${encodeURIComponent(bad)}`);
      expect(r.status, bad.slice(0, 30)).toBe(400);
    }
  });

  it("logout requires same-origin, ends the session, and an old copy of the cookie stops working", async () => {
    const jar = await s.login("alice");
    const copy = new CookieJar();
    for (const [k, v] of jar.cookies) copy.cookies.set(k, v);
    expect((await s.req("/auth/logout", { method: "POST", jar })).status).toBe(403);
    expect((await s.req("/auth/logout", { method: "POST", jar, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await s.req("/auth/logout", { method: "POST", jar, headers: { origin: ORIGIN } })).status).toBe(200);
    expect((await session(jar)).authenticated).toBe(false);
    expect((await session(copy)).authenticated).toBe(false);
  });

  it("expires idle sessions", async () => {
    const quick = await startStack({ fake, config: { sessionIdleTtlMs: 150 } });
    try {
      const jar = await quick.signIn("alice");
      expect((await session(jar, quick)).authenticated).toBe(true);
      await sleep(250);
      expect((await session(jar, quick)).authenticated).toBe(false);
    } finally {
      await quick.close();
    }
  });

  it("is off without the relay and database: anonymous only", async () => {
    const anon = await startStack({ fake, config: { oidc: null, databaseUrl: null } });
    try {
      expect(await session(undefined, anon)).toMatchObject({ authenticated: false, loginUrl: null, githubConnectUrl: null });
      expect((await anon.req("/auth/login")).status).toBe(501);
      expect((await anon.req("/auth/github/connect")).status).toBe(501);
      expect((await anon.req(`/api/v1/repositories/${KEY}/refs`)).status).toBe(200);
    } finally {
      await anon.close();
    }
  });
});

describe("connecting GitHub", () => {
  it("needs a signed-in account first, then comes back to connect", async () => {
    const r = await s.req("/auth/github/connect?returnTo=%2Fgithub%2Focto%2Fsecret");
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!, ORIGIN);
    expect(loc.pathname).toBe("/auth/login");
    expect(loc.searchParams.get("returnTo")).toBe("/auth/github/connect?returnTo=%2Fgithub%2Focto%2Fsecret");
  });

  it("gives access to private repositories; tokens are stored encrypted, never sent to the browser", async () => {
    const jar = await s.signIn("alice");
    await post("/auth/github/disconnect", {}, jar); // earlier tests connected alice; start clean
    expect((await s.req(`/api/v1/repositories/${SECRET}`, { jar })).status).toBe(404);
    const r = await s.connectGitHub("alice", jar, "/github/octo/secret");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/github/octo/secret");
    const info = await s.req("/api/v1/session", { jar });
    const text = await info.text();
    expect(JSON.parse(text).github).toMatchObject({ connected: true, login: "alice", name: "Alice A." });
    for (const t of [...fake.tokens.keys(), ...fake.refreshTokens.keys()]) {
      expect(text).not.toContain(t);
      expect(jar.header()).not.toContain(t);
    }
    expect((await s.req(`/api/v1/repositories/${SECRET}`, { jar })).status).toBe(200);
    const rows = await s.db.query<Record<string, string>>(`select access_token, refresh_token, github_login from "${s.config.databaseSchema}".github_links`);
    expect(rows.some((row) => row.github_login === "alice")).toBe(true);
    const dump = JSON.stringify(rows);
    for (const t of [...fake.tokens.keys(), ...fake.refreshTokens.keys()]) expect(dump).not.toContain(t);
  });

  it("rejects a PKCE mismatch", async () => {
    const jar = await s.signIn("bob");
    fake.authorizingUser = "bob";
    const r1 = await s.req("/auth/github/connect", { jar });
    const auth = new URL(r1.headers.get("location")!);
    expect(auth.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    auth.searchParams.set("code_challenge", "A".repeat(43)); // attacker-substituted challenge
    const r2 = await fetch(auth, { redirect: "manual" });
    const cb = new URL(r2.headers.get("location")!);
    const r3 = await s.req(cb.pathname + cb.search, { jar });
    expect(r3.status).toBe(400);
    expect(await r3.text()).toContain("invalid_grant");
    expect((await session(jar)).github).toEqual({ connected: false });
  });

  it("one GitHub account connects to one Lanes account", async () => {
    const first = await s.signIn("carol");
    expect((await s.connectGitHub("bob", first)).status).toBe(302);
    const second = await s.signIn("dave");
    const r = await s.connectGitHub("bob", second);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("already connected to another Lanes account");
    expect((await session(second)).github).toEqual({ connected: false });
    expect((await session(first)).github).toMatchObject({ connected: true, login: "bob" });
    await post("/auth/github/disconnect", {}, first);
  });

  it("refreshes expiring GitHub App tokens; a revoked refresh token disconnects GitHub, not the session", async () => {
    const prevTtl = fake.opts.accessTokenTtl;
    (fake.opts as { accessTokenTtl: number | null }).accessTokenTtl = 60; // within the refresh window
    try {
      const jar = await s.login("alice");
      const before = fake.countRequests((r) => r.path.startsWith("/login/oauth/access_token"));
      expect((await s.req(`/api/v1/repositories/${SECRET}`, { jar })).status).toBe(200);
      expect(fake.countRequests((r) => r.path.startsWith("/login/oauth/access_token"))).toBeGreaterThan(before); // refreshed
      fake.revokeRefreshTokens("alice");
      const denied = await s.req(`/api/v1/repositories/${SECRET}`, { jar });
      expect(denied.status).toBe(401);
      expect((await denied.json()).error.code).toBe("UNAUTHENTICATED");
      expect(await session(jar)).toMatchObject({ authenticated: true, github: { connected: false } });
    } finally {
      (fake.opts as { accessTokenTtl: number | null }).accessTokenTtl = prevTtl;
    }
  });

  it("disconnects GitHub when GitHub rejects the token", async () => {
    const jar = await s.login("alice");
    for (const [t, info] of fake.tokens) if (info.login === "alice") fake.tokens.delete(t);
    expect((await s.req(`/api/v1/repositories/${KEY}/refs`, { jar })).status).toBe(401);
    await sleep(50);
    expect(await session(jar)).toMatchObject({ authenticated: true, github: { connected: false } });
  });

  it("disconnect requires same-origin and removes access", async () => {
    const jar = await s.login("alice");
    expect((await s.req("/auth/github/disconnect", { method: "POST", jar })).status).toBe(403);
    expect((await post("/auth/github/disconnect", {}, jar)).status).toBe(200);
    expect((await session(jar)).github).toEqual({ connected: false });
    expect((await s.req(`/api/v1/repositories/${SECRET}`, { jar })).status).toBe(404);
  });

  it("the connection persists in PostgreSQL: a new server process with the same database keeps it", async () => {
    const sessionSecret = "s".repeat(48);
    const a = await startStack({ fake, config: { sessionSecret } });
    const jar = await a.login("alice");
    const schema = a.config.databaseSchema;
    await a.close();
    const b = await startStack({ fake, config: { sessionSecret, databaseSchema: schema } }); // nothing on local disk
    try {
      expect(await session(jar, b)).toMatchObject({ authenticated: true, github: { connected: true, login: "alice" } });
      expect((await b.req(`/api/v1/repositories/${SECRET}`, { jar })).status).toBe(200);
      // a tampered cookie is ignored and cleared
      const [name, value] = [...jar.cookies][0]!;
      const forged = new CookieJar();
      forged.cookies.set(name, value.slice(0, -4) + (value.endsWith("AAAA") ? "BBBB" : "AAAA"));
      expect((await session(forged, b)).authenticated).toBe(false);
      expect(forged.cookies.has(name)).toBe(false);
    } finally {
      await b.close();
    }
    const c = await startStack({ fake, config: { sessionSecret: "x".repeat(48), databaseSchema: schema } }); // rotated secret
    try {
      expect((await session(jar, c)).authenticated).toBe(false);
    } finally {
      await c.close();
    }
  });

  it("migrations are idempotent and refuse an unallocated schema", async () => {
    const { connectDb } = await import("../../src/server/db.ts");
    const { migrate } = await import("../../src/server/migrations.ts");
    const db = connectDb(s.db.url, { schema: s.config.databaseSchema, max: 1 });
    const missing = connectDb(s.db.url, { schema: "not_allocated", max: 1 });
    try {
      expect(await migrate(db)).toEqual([]);
      await expect(migrate(missing)).rejects.toThrow("must be allocated");
    } finally {
      await db.close();
      await missing.close();
    }
  });
});

describe("repository access", () => {
  it("private repos: anonymous 404, other user 404, collaborator 200", async () => {
    expect((await s.req(`/api/v1/repositories/${SECRET}`)).status).toBe(404);
    expect((await s.req(`/api/v1/repositories/${SECRET}/commits`)).status).toBe(404);
    const bob = await s.login("bob");
    expect((await s.req(`/api/v1/repositories/${SECRET}/refs`, { jar: bob })).status).toBe(404);
    const alice = await s.login("alice");
    const r = await s.req(`/api/v1/repositories/${SECRET}`, { jar: alice });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ visibility: "private", permission: "write" });
    // URL possession never grants access: the same URL anonymously is still 404
    expect((await s.req(`/api/v1/repositories/${SECRET}/refs`)).status).toBe(404);
  });

  it("GITHUB_PUBLIC_TOKEN serves public repos anonymously but never private ones", async () => {
    const bot = fake.issueToken("lanes-bot"); // the bot CAN read octo/secret on GitHub
    const pub = await startStack({ fake, config: { publicToken: bot } });
    try {
      const n = fake.log.length;
      const ok = await pub.req(`/api/v1/repositories/${KEY}/refs`);
      expect(ok.status).toBe(200);
      expect(fake.log.slice(n).every((r) => r.login === "lanes-bot")).toBe(true);
      for (const path of ["", "/refs", "/commits", "/capabilities", "/file?path=README.md&rev=main", "/events"]) {
        const r = await pub.req(`/api/v1/repositories/${SECRET}${path}`);
        expect(r.status, path).toBe(404);
      }
      // signed-in users still use their own token, not the bot's
      const jar = await pub.login("bob");
      expect((await pub.req(`/api/v1/repositories/${SECRET}`, { jar })).status).toBe(404);
    } finally {
      await pub.close();
    }
  });

  it("local and browser repository keys are unsupported on the hosted server", async () => {
    const r = await s.req("/api/v1/repositories/local:abc/refs");
    expect(r.status).toBe(501);
    expect((await r.json()).error.message).toBe("Local repositories are served by the git-graph CLI companion, not the hosted server");
  });

  it("lists the signed-in user's repositories; anonymous gets an empty list", async () => {
    expect(await (await s.req("/api/v1/repositories")).json()).toEqual([]);
    const jar = await s.login("alice");
    const all = (await (await s.req("/api/v1/repositories", { jar })).json()) as { key: string }[];
    expect(all.map((r) => r.key).sort()).toEqual(["github:octo:basic", "github:octo:secret"]);
    const q = (await (await s.req("/api/v1/repositories?query=sec", { jar })).json()) as { key: string }[];
    expect(q.map((r) => r.key)).toEqual(["github:octo:secret"]);
  });

  it("serves history pages and capabilities through the shared API", async () => {
    const p1 = await (await s.req(`/api/v1/repositories/${KEY}/commits?limit=5`)).json();
    expect(p1.commits).toHaveLength(5);
    expect(p1.cursor).toBeTruthy();
    const p2 = await (await s.req(`/api/v1/repositories/${KEY}/commits?limit=5&cursor=${encodeURIComponent(p1.cursor)}`)).json();
    expect(p2.commits.length).toBeGreaterThan(0);
    expect(new Set([...p1.commits, ...p2.commits].map((c: { hash: string }) => c.hash)).size).toBe(p1.commits.length + p2.commits.length);
    const caps = await (await s.req(`/api/v1/repositories/${KEY}/capabilities`)).json();
    expect(caps.branchWrite).toEqual({ available: false, reason: "Sign in to GitHub to create, rename and delete branches and tags" });
    const refs = await s.req(`/api/v1/repositories/${KEY}/refs`);
    const etag = refs.headers.get("etag")!;
    expect((await s.req(`/api/v1/repositories/${KEY}/refs`, { headers: { "if-none-match": etag } })).status).toBe(304);
  });
});

describe("CSRF, rate limiting and mutations", () => {
  it("rejects state-changing requests without a matching Origin", async () => {
    const jar = await s.login("alice");
    const body = { command: "repo.info", args: { repo: KEY } };
    expect((await post("/api/v1/commands/execute", body, jar, {})).status).toBe(403);
    expect((await post("/api/v1/commands/execute", body, jar, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/v1/commands/execute", body, jar, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post("/api/v1/commands/execute", body, jar, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post("/api/v1/commands/execute", body, jar)).status).toBe(200);
  });

  it("honors TRUST_PROXY for client IPs", async () => {
    const tp = await startStack({ fake, config: { trustProxy: 1, apiRateLimit: { capacity: 2, refillPerSec: 0.01 } } });
    try {
      const as = (ip: string) => tp.req("/api/v1/session", { headers: { "x-forwarded-for": `203.0.113.9, ${ip}` } });
      expect([(await as("198.51.100.1")).status, (await as("198.51.100.1")).status, (await as("198.51.100.1")).status]).toEqual([200, 200, 429]);
      expect((await as("198.51.100.2")).status).toBe(200); // a different client behind the proxy
    } finally {
      await tp.close();
    }
  });

  it("rate limits per client", async () => {
    const rl = await startStack({ fake, config: { apiRateLimit: { capacity: 5, refillPerSec: 0.01 } } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await rl.req("/api/v1/session")).status);
      expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      const last = await rl.req("/api/v1/session");
      expect(last.status).toBe(429);
      expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await last.json()).error.code).toBe("RATE_LIMITED");
    } finally {
      await rl.close();
    }
    // stricter bucket on /auth
    const ra = await startStack({ fake, config: { authRateLimit: { capacity: 3, refillPerSec: 0.01 } } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await ra.req("/auth/login")).status);
      expect(codes).toEqual([302, 302, 302, 429]);
    } finally {
      await ra.close();
    }
  });

  it("branch.create / delete with preconditions and the destructive-action confirmation", async () => {
    const jar = await s.login("alice");
    const main = fake.repo("octo", "basic").refs.get("refs/heads/main")!;
    const created = await post(`/api/v1/repositories/${KEY}/mutations`, { mutation: { op: "branch.create", name: "api/tmp", target: main } }, jar);
    expect(created.status).toBe(200);
    expect((await created.json()).invocations).toEqual(["POST /repos/octo/basic/git/refs"]);

    const stale = await post(`/api/v1/repositories/${KEY}/mutations`, { mutation: { op: "branch.create", name: "api/tmp2", target: main }, precondition: { refsVersion: "stale" } }, jar);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("STALE_STATE");

    const args = { repo: KEY, name: "api/tmp", precondition: { ref: { name: "refs/heads/api/tmp", commit: main } } };
    const first = await post("/api/v1/commands/execute", { command: "git.branch.delete", args }, jar);
    expect(first.status).toBe(428);
    const err = (await first.json()).error;
    expect(err.code).toBe("CONFIRMATION_REQUIRED");
    expect(err.details.consequence).toContain("api/tmp");
    expect(fake.repo("octo", "basic").refs.has("refs/heads/api/tmp")).toBe(true);
    const second = await post("/api/v1/commands/execute", { command: "git.branch.delete", args, confirm: err.details.confirmToken }, jar);
    expect(second.status).toBe(200);
    expect(fake.repo("octo", "basic").refs.has("refs/heads/api/tmp")).toBe(false);

    // read-only and anonymous callers
    const bob = await s.login("bob");
    const ro = await post(`/api/v1/repositories/${KEY}/mutations`, { mutation: { op: "branch.create", name: "x", target: main } }, bob);
    expect(ro.status).toBe(501);
    expect((await ro.json()).error.message).toBe("You need write access to octo/basic");
    const anon = await post(`/api/v1/repositories/${KEY}/mutations`, { mutation: { op: "merge", ref: "develop" } });
    expect(anon.status).toBe(501);
  });
});
