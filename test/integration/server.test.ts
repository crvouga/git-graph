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

describe("GitHub sign-in", () => {
  it("login → callback → session, without exposing tokens", async () => {
    const jar = new CookieJar();
    await s.login("alice", jar, "/github/octo/basic?commit=abc");
    const preLogin = jar.raw[0]!.split(";")[0];
    const final = jar.raw[jar.raw.length - 1]!.split(";")[0];
    expect(final).not.toBe(preLogin); // session id rotated on login
    expect(jar.raw[0]).toMatch(/HttpOnly/);
    const r = await s.req("/api/v1/session", { jar });
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ authenticated: true, user: { login: "alice", name: "Alice A.", avatarUrl: expect.stringContaining("avatars") } });
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    for (const t of fake.tokens.keys()) expect(text).not.toContain(t);
    for (const t of fake.refreshTokens.keys()) expect(text).not.toContain(t);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects to the returnTo path after login", async () => {
    fake.authorizingUser = "alice";
    const jar = new CookieJar();
    const r1 = await s.req("/auth/login?returnTo=%2Fgithub%2Focto%2Fbasic%3Fcommit%3Dabc", { jar });
    const auth = new URL(r1.headers.get("location")!);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(auth.searchParams.get("scope")).toBe("read:user");
    const r2 = await fetch(auth, { redirect: "manual" });
    const cb = new URL(r2.headers.get("location")!);
    const r3 = await s.req(cb.pathname + cb.search, { jar });
    expect(r3.status).toBe(302);
    expect(r3.headers.get("location")).toBe("/github/octo/basic?commit=abc");
  });

  it("rejects a PKCE mismatch", async () => {
    fake.authorizingUser = "alice";
    const jar = new CookieJar();
    const r1 = await s.req("/auth/login", { jar });
    const auth = new URL(r1.headers.get("location")!);
    auth.searchParams.set("code_challenge", "A".repeat(43)); // attacker-substituted challenge
    const r2 = await fetch(auth, { redirect: "manual" });
    const cb = new URL(r2.headers.get("location")!);
    const r3 = await s.req(cb.pathname + cb.search, { jar });
    expect(r3.status).toBe(400);
    expect(await r3.text()).toContain("invalid_grant");
    expect((await (await s.req("/api/v1/session", { jar })).json()).authenticated).toBe(false);
  });

  it("rejects state replay, forged state and callbacks without the pre-login cookie", async () => {
    fake.authorizingUser = "alice";
    const jar = new CookieJar();
    const r1 = await s.req("/auth/login", { jar });
    const r2 = await fetch(r1.headers.get("location")!, { redirect: "manual" });
    const cb = new URL(r2.headers.get("location")!);
    // another browser (no cookie) cannot complete it
    expect((await s.req(cb.pathname + cb.search)).status).toBe(400);
    // the pre-login session can — once
    const jar2 = new CookieJar();
    const r1b = await s.req("/auth/login", { jar: jar2 });
    const r2b = await fetch(r1b.headers.get("location")!, { redirect: "manual" });
    const cbb = new URL(r2b.headers.get("location")!);
    const forged = new URL(cbb);
    forged.searchParams.set("state", "forged");
    expect((await s.req(forged.pathname + forged.search, { jar: jar2 })).status).toBe(400);
    // the forged attempt consumed the pending state: the genuine callback now fails too (single use)
    expect((await s.req(cbb.pathname + cbb.search, { jar: jar2 })).status).toBe(400);

    const jar3 = await s.login("alice");
    void jar3;
    const jar4 = new CookieJar();
    const r1c = await s.req("/auth/login", { jar: jar4 });
    const r2c = await fetch(r1c.headers.get("location")!, { redirect: "manual" });
    const cbc = new URL(r2c.headers.get("location")!);
    expect((await s.req(cbc.pathname + cbc.search, { jar: jar4 })).status).toBe(302);
    expect((await s.req(cbc.pathname + cbc.search, { jar: jar4 })).status).toBe(400); // replay
  });

  it("rejects open redirects in returnTo", async () => {
    for (const bad of ["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "evil", "/%0d%0aSet-Cookie:x"]) {
      const r = await s.req(`/auth/login?returnTo=${encodeURIComponent(bad)}`);
      if (bad === "/%0d%0aSet-Cookie:x") {
        // percent-encoded CR/LF stays encoded inside the path: harmless same-origin path
        expect([302, 400]).toContain(r.status);
        if (r.status === 302) expect(r.headers.get("location")!.startsWith(fake.url)).toBe(true);
        continue;
      }
      expect(r.status, bad).toBe(400);
    }
  });

  it("logout requires same-origin and ends the session", async () => {
    const jar = await s.login("alice");
    expect((await s.req("/auth/logout", { method: "POST", jar })).status).toBe(403);
    expect((await s.req("/auth/logout", { method: "POST", jar, headers: { origin: "https://evil.example" } })).status).toBe(403);
    const r = await s.req("/auth/logout", { method: "POST", jar, headers: { origin: ORIGIN } });
    expect(r.status).toBe(200);
    expect((await (await s.req("/api/v1/session", { jar })).json()).authenticated).toBe(false);
  });

  it("refreshes expiring GitHub App tokens; a revoked refresh token ends the session", async () => {
    const short = await startStack({ fake, config: {} });
    const prevTtl = fake.opts.accessTokenTtl;
    (fake.opts as { accessTokenTtl: number | null }).accessTokenTtl = 60; // within the refresh window
    try {
      const jar = await short.login("alice");
      const before = fake.countRequests((r) => r.path.startsWith("/login/oauth/access_token"));
      const ok = await short.req(`/api/v1/repositories/${SECRET}`, { jar });
      expect(ok.status).toBe(200);
      expect(fake.countRequests((r) => r.path.startsWith("/login/oauth/access_token"))).toBeGreaterThan(before); // refreshed
      fake.revokeRefreshTokens("alice");
      const denied = await short.req(`/api/v1/repositories/${SECRET}`, { jar });
      expect(denied.status).toBe(401);
      expect((await denied.json()).error.code).toBe("UNAUTHENTICATED");
      expect((await (await short.req("/api/v1/session", { jar })).json()).authenticated).toBe(false);
    } finally {
      (fake.opts as { accessTokenTtl: number | null }).accessTokenTtl = prevTtl;
      await short.close();
    }
  });

  it("keeps sessions in a sealed cookie: they survive a restart without server state", async () => {
    const sessionSecret = "s".repeat(48);
    const a = await startStack({ fake, config: { sessionSecret } });
    const jar = await a.login("alice");
    await a.close();
    const cookie = jar.header();
    for (const t of fake.tokens.keys()) expect(cookie).not.toContain(t);
    for (const t of fake.refreshTokens.keys()) expect(cookie).not.toContain(t);
    expect(cookie).not.toContain("alice");
    const b = await startStack({ fake, config: { sessionSecret } }); // a new process, nothing on disk
    try {
      expect((await (await b.req("/api/v1/session", { jar })).json()).user.login).toBe("alice");
      // a tampered cookie is ignored and cleared
      const [name, value] = [...jar.cookies][0]!;
      const forged = new CookieJar();
      forged.cookies.set(name, value.slice(0, -4) + (value.endsWith("AAAA") ? "BBBB" : "AAAA"));
      const r = await b.req("/api/v1/session", { jar: forged });
      expect((await r.json()).authenticated).toBe(false);
      expect(forged.cookies.has(name)).toBe(false);
    } finally {
      await b.close();
    }
    const c = await startStack({ fake, config: { sessionSecret: "x".repeat(48) } }); // rotated secret
    try {
      expect((await (await c.req("/api/v1/session", { jar })).json()).authenticated).toBe(false);
    } finally {
      await c.close();
    }
  });

  it("an old copy of the cookie stops working after logout", async () => {
    const jar = await s.login("alice");
    const copy = new CookieJar();
    for (const [k, v] of jar.cookies) copy.cookies.set(k, v);
    expect((await s.req("/auth/logout", { method: "POST", jar, headers: { origin: ORIGIN } })).status).toBe(200);
    expect((await (await s.req("/api/v1/session", { jar: copy })).json()).authenticated).toBe(false);
  });

  it("expires idle sessions", async () => {
    const quick = await startStack({ fake, config: { sessionIdleTtlMs: 150 } });
    try {
      const jar = await quick.login("alice");
      expect((await (await quick.req("/api/v1/session", { jar })).json()).authenticated).toBe(true);
      await sleep(250);
      expect((await (await quick.req("/api/v1/session", { jar })).json()).authenticated).toBe(false);
    } finally {
      await quick.close();
    }
  });

  it("ends the session when GitHub rejects the user's token", async () => {
    const jar = await s.login("alice");
    for (const [t, info] of fake.tokens) if (info.login === "alice") fake.tokens.delete(t);
    const r = await s.req(`/api/v1/repositories/${KEY}/refs`, { jar });
    expect(r.status).toBe(401);
    expect((await (await s.req("/api/v1/session", { jar })).json()).authenticated).toBe(false);
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
