// Test harness: fake GitHub + fake auth relay + test PostgreSQL + Lanes server (in-process or
// listening), cookie jar, relay sign-in, GitHub connection, signed webhooks and an SSE client.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createServerApp, type ServerApp } from "../../src/server/app.ts";
import { testConfig, type ServerConfig } from "../../src/server/config.ts";
import { HttpApi, subscribeEvents, type EventSubscription } from "../../src/core/api/client.ts";
import type { EventEnvelope } from "../../src/core/types.ts";
import { testDb, type TestDb } from "./db.ts";
import { FakeGitHub, makeGitHubFixture, signWebhook } from "./github.ts";
import { FakeRelay } from "./relay.ts";

export const ORIGIN = "http://localhost:8787";
export const WEBHOOK_SECRET = "test-webhook-secret";
export const TOKEN_KEY = "test-token-encryption-key-test-token-encryption-key";

let sharedRelay: Promise<FakeRelay> | null = null;
/** The process-wide fake relay; it accepts the test origin's callback. */
export function testRelay(): Promise<FakeRelay> {
  return (sharedRelay ??= new FakeRelay().start().then((r) => {
    r.redirectUris.add(`${ORIGIN}/auth/callback`);
    return r;
  }));
}

export class CookieJar {
  readonly cookies = new Map<string, string>();
  readonly raw: string[] = [];
  absorb(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      this.raw.push(sc);
      const [pair] = sc.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      if (/max-age=0/i.test(sc) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** A static dir with an SPA shell and a hashed asset. */
export function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lanes-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>Lanes</title><div id="app"></div><script type="module" src="/assets/app-AbC123xy.js"></script>`);
  writeFileSync(join(dir, "assets", "app-AbC123xy.js"), `console.log(${JSON.stringify("x".repeat(5000))});\n`);
  writeFileSync(join(dir, "robots.txt"), "User-agent: *\n");
  return dir;
}

export interface Stack {
  fake: FakeGitHub;
  server: ServerApp;
  config: ServerConfig;
  /** Base URL when listening, else ORIGIN (in-process requests). */
  url: string;
  staticDir: string;
  users: { alice: number; bob: number; bot: number };
  req(path: string, init?: RequestInit & { jar?: CookieJar }): Promise<Response>;
  relay: FakeRelay;
  db: TestDb;
  /** Sign in through the relay, then connect GitHub as the same person (most tests want both). */
  login(login: string, jar?: CookieJar, returnTo?: string): Promise<CookieJar>;
  /** Sign in through the relay only. */
  signIn(subject: string, jar?: CookieJar, returnTo?: string): Promise<CookieJar>;
  /** Connect GitHub (as GitHub user `login`) for the signed-in jar. */
  connectGitHub(login: string, jar: CookieJar, returnTo?: string): Promise<Response>;
  webhook(event: string, payload: unknown, opts?: { delivery?: string; secret?: string; signature?: string }): Promise<Response>;
  sse(key: string, jar?: CookieJar, cursor?: string | null): SseClient;
  close(): Promise<void>;
}

export interface SseClient {
  events: (EventEnvelope & { receivedAt: number; name?: string })[];
  states: string[];
  sub: EventSubscription;
  next(pred: (e: EventEnvelope) => boolean, timeoutMs?: number): Promise<EventEnvelope & { receivedAt: number }>;
  close(): void;
  cursor(): string | null;
}

export interface StackOptions {
  config?: Partial<ServerConfig>;
  listen?: boolean;
  fake?: FakeGitHub;
  fakeOptions?: ConstructorParameters<typeof FakeGitHub>[0];
}

export async function startFake(fakeOptions?: ConstructorParameters<typeof FakeGitHub>[0]): Promise<{ fake: FakeGitHub; users: Stack["users"] }> {
  const dir = makeGitHubFixture();
  const fake = await new FakeGitHub(fakeOptions).start();
  const users = { alice: fake.addUser("alice", "Alice A.").id, bob: fake.addUser("bob", "Bob B.").id, bot: fake.addUser("lanes-bot").id };
  fake.addRepoFromGit("octo", "basic", dir, { perms: { alice: "admin", bob: "read" } });
  fake.addRepoFromGit("octo", "secret", dir, { private: true, perms: { alice: "write", "lanes-bot": "read" } });
  return { fake, users };
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  let fake = opts.fake;
  let users = { alice: 0, bob: 0, bot: 0 };
  if (!fake) ({ fake, users } = await startFake(opts.fakeOptions));
  else users = { alice: fake.users.get("alice")!.id, bob: fake.users.get("bob")!.id, bot: fake.users.get("lanes-bot")!.id };
  const f = fake;
  const relay = await testRelay();
  const db = await testDb();
  const schema = opts.config?.databaseSchema ?? (await db.allocateSchema());
  const staticDir = makeStaticDir();
  const config = testConfig({
    oidc: { issuer: relay.issuer, clientId: relay.clientId, redirectUri: `${ORIGIN}/auth/callback`, scopes: "openid email profile", idpHint: "google" },
    databaseUrl: db.url,
    databaseSchema: schema,
    databasePoolMax: 3,
    // PGlite's socket server mixes up pipelined queries ("bind message supplies 2 parameters…").
    databaseMaxPipeline: 1,
    tokenEncryptionKey: TOKEN_KEY,
    appOrigin: ORIGIN,
    githubClientId: f.opts.clientId,
    githubClientSecret: f.opts.clientSecret,
    githubApiUrl: f.url,
    githubWebUrl: f.url,
    webhookSecret: WEBHOOK_SECRET,
    staticDir,
    log: () => {},
    authRateLimit: { capacity: 10_000, refillPerSec: 1000 },
    apiRateLimit: { capacity: 10_000, refillPerSec: 1000 },
    ...opts.config,
  });
  const server = createServerApp(config);
  if (config.databaseUrl && config.migrateOnBoot) await server.ready();
  let url = ORIGIN;
  let http: ReturnType<typeof serve> | null = null;
  if (opts.listen) {
    await new Promise<void>((res) => {
      http = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        url = `http://127.0.0.1:${info.port}`;
        res();
      });
    });
  }

  const req = async (path: string, init: RequestInit & { jar?: CookieJar } = {}) => {
    const { jar, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (jar && jar.cookies.size) headers.set("cookie", jar.header());
    const res = opts.listen ? await fetch(url + path, { ...rest, headers, redirect: "manual" }) : await server.app.request(ORIGIN + path, { ...rest, headers });
    jar?.absorb(res);
    return res;
  };

  const signIn = async (who: string, jar = new CookieJar(), returnTo = "/github/octo/basic") => {
    relay.authorizingSubject = who;
    const r1 = await req(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { jar });
    if (r1.status !== 302) throw new Error(`login: ${r1.status} ${await r1.text()}`);
    const r2 = await fetch(r1.headers.get("location")!, { redirect: "manual" });
    if (r2.status !== 302) throw new Error(`relay authorize: ${r2.status} ${await r2.text()}`);
    const cb = new URL(r2.headers.get("location")!);
    const r3 = await req(cb.pathname + cb.search, { jar });
    if (r3.status !== 302) throw new Error(`callback: ${r3.status} ${await r3.text()}`);
    return jar;
  };

  const connectGitHub = async (who: string, jar: CookieJar, returnTo = "/github/octo/basic") => {
    f.authorizingUser = who;
    const r1 = await req(`/auth/github/connect?returnTo=${encodeURIComponent(returnTo)}`, { jar });
    if (r1.status !== 302) throw new Error(`connect: ${r1.status} ${await r1.text()}`);
    const r2 = await fetch(r1.headers.get("location")!, { redirect: "manual" });
    const cb = new URL(r2.headers.get("location")!);
    return req(cb.pathname + cb.search, { jar });
  };

  const login = async (who: string, jar = new CookieJar(), returnTo = "/github/octo/basic") => {
    await signIn(who, jar, returnTo);
    const r = await connectGitHub(who, jar, returnTo);
    if (r.status !== 302) throw new Error(`GitHub callback: ${r.status} ${await r.text()}`);
    return jar;
  };

  const webhook = (event: string, payload: unknown, o: { delivery?: string; secret?: string; signature?: string } = {}) => {
    const body = JSON.stringify(payload);
    return req("/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": o.delivery ?? randomUUID(),
        "x-hub-signature-256": o.signature ?? signWebhook(o.secret ?? WEBHOOK_SECRET, body),
      },
    });
  };

  const clients: SseClient[] = [];
  const sse = (key: string, jar?: CookieJar, cursor?: string | null): SseClient => {
    if (!opts.listen) throw new Error("sse needs listen: true");
    const api = new HttpApi({ baseUrl: `${url}/api/v1`, headers: (): Record<string, string> => (jar?.cookies.size ? { cookie: jar.header() } : {}), client: "ui" });
    const events: SseClient["events"] = [];
    const states: string[] = [];
    let lastCursor: string | null = cursor ?? null;
    const waiters: { pred: (e: EventEnvelope) => boolean; res: (e: EventEnvelope & { receivedAt: number }) => void }[] = [];
    const sub = subscribeEvents(
      api,
      key,
      (env) => {
        const e = { ...env, receivedAt: performance.now() };
        events.push(e);
        lastCursor = `${env.epoch}:${env.seq}`;
        for (const w of [...waiters]) if (w.pred(env)) (waiters.splice(waiters.indexOf(w), 1), w.res(e));
      },
      { initialCursor: cursor ?? null, onState: (s) => states.push(s), minBackoffMs: 50, maxBackoffMs: 200 },
    );
    const client: SseClient = {
      events,
      states,
      sub,
      next(pred, timeoutMs = 5000) {
        const hit = events.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const w = { pred, res };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) {
              waiters.splice(i, 1);
              rej(new Error(`timed out waiting for event; got ${events.map((e) => e.event.type).join(",")}`));
            }
          }, timeoutMs);
        });
      },
      close: () => sub.close(),
      cursor: () => lastCursor,
    };
    clients.push(client);
    return client;
  };

  return {
    fake: f,
    server,
    config,
    url,
    staticDir,
    users,
    req,
    relay,
    db,
    login,
    signIn,
    connectGitHub,
    webhook,
    sse,
    async close() {
      for (const c of clients) c.close();
      await server.close();
      const h = http as ReturnType<typeof serve> | null;
      if (h) {
        await new Promise<void>((res) => {
          (h as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          h.close(() => res());
        });
      }
      rmSync(staticDir, { recursive: true, force: true });
      if (!opts.fake) await f.close();
    },
  };
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
