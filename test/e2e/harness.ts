// End-to-end harness: runs the PRODUCTION artifacts (dist/server/server.mjs serving dist/web,
// dist/cli/git-graph.mjs serve) against disposable fixtures, a fake GitHub, a fake auth relay and a
// real PostgreSQL with wal_level=logical (Zero sync needs logical replication, so PGlite can't do):
// $LANES_ZERO_TEST_DB when set (an empty "lanes" schema), else a disposable Docker container.
// The companion is paired with the server for the e2e user "alice" (a signed-in browser claims its
// code), and the signed-in browser state is saved for specs (AUTH_STATE). Exposes a small control
// API so tests can simulate external GitHub pushes (with signed webhooks), expire sessions, and
// count upstream requests.

import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { makeBasic, makeConflict } from "../fixtures/make-fixtures.ts";
import postgres from "postgres";
import { chromium, expect } from "@playwright/test";
import { FakeGitHub, makeGitHubFixture, signWebhook } from "../fakes/github.ts";
import { FakeRelay } from "../fakes/relay.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
export const STATE_FILE = join(ROOT, "test-results", "e2e-state.json");
export const WEBHOOK_SECRET = "e2e-webhook-secret";
/** Playwright storage state of a browser signed in as "alice" (the companion's account). */
export const AUTH_STATE = join(ROOT, "test-results", "e2e-auth.json");

export interface E2EState {
  appOrigin: string;
  companionPort: number;
  companionUrl: string;
  configDir: string;
  fixturesRoot: string;
  basic: string;
  remote: string;
  worktreeFeature: string;
  worktreeTwo: string;
  conflict: string;
  large: string | null;
  control: string;
  fakeGitHub: string;
}

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function waitFor(url: string, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const children: ChildProcess[] = [];
/** Teardown steps, run in reverse order (also when setup fails half way). */
const cleanups: (() => unknown)[] = [];

async function stopAll() {
  for (const c of cleanups.splice(0).reverse()) await Promise.resolve().then(c).catch((e) => console.error("e2e teardown:", e));
}

const logs = new Map<string, string[]>();

function start(cmd: string, args: string[], env: Record<string, string>, name: string) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  logs.set(name, log);
  child.stdout!.on("data", (d) => log.push(String(d)));
  child.stderr!.on("data", (d) => log.push(String(d)));
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`[${name}] exited ${code}\n${log.join("").slice(-2000)}`);
  });
  children.push(child);
  return child;
}

export async function startHarness(): Promise<E2EState> {
  try {
    return await startHarnessInner();
  } catch (e) {
    await stopAll();
    throw e;
  }
}

async function startHarnessInner(): Promise<E2EState> {
  for (const f of ["dist/web/index.html", "dist/server/server.mjs", "dist/cli/git-graph.mjs"]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`Missing ${f}: run \`pnpm build\` first (e2e tests run against the production build).`);
  }
  (globalThis as { __lanesStop?: () => Promise<void> }).__lanesStop = stopAll;
  const fixturesRoot = mkdtempSync(join(tmpdir(), "lanes-e2e-"));
  cleanups.push(() => rmSync(fixturesRoot, { recursive: true, force: true }));
  const basic = makeBasic(fixturesRoot);
  const conflict = makeConflict(fixturesRoot);
  const configDir = join(fixturesRoot, "config");
  // Hermetic git identity/config for the companion during tests (production uses the user's config).
  const gitConfig = join(fixturesRoot, ".gitconfig");
  writeFileSync(gitConfig, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[user]\n\tname = Lanes E2E\n\temail = e2e@example.com\n");
  const large = existsSync(join(ROOT, ".fixtures/large-100000/.git/fixture-complete")) ? join(ROOT, ".fixtures/large-100000") : null;

  // Fake GitHub with a public and a private repository built from a real git repo.
  const ghDir = makeGitHubFixture();
  const fake = await new FakeGitHub({ accessTokenTtl: 3600 }).start();
  cleanups.push(() => fake.close());
  fake.addUser("alice", "Alice A.");
  fake.addUser("bob", "Bob B.");
  fake.addRepoFromGit("octo", "basic", ghDir, { perms: { alice: "admin", bob: "read" } });
  fake.addRepoFromGit("octo", "secret", ghDir, { private: true, perms: { alice: "write" } });
  fake.authorizingUser = "alice";

  const port = await freePort();
  const companionPort = await freePort();
  const appOrigin = `http://127.0.0.1:${port}`;
  // Sign-in: a fake relay that signs everyone in as "alice", and a fresh database schema.
  const relay = await new FakeRelay().start();
  cleanups.push(() => relay.close());
  relay.redirectUris.add(`${appOrigin}/auth/callback`);
  relay.authorizingSubject = "alice";
  const db = await startPostgres();
  cleanups.push(() => db.stop());
  // Children stop before the database goes away.
  cleanups.push(() => Promise.all(children.map((c) => new Promise<void>((r) => {
    if (c.exitCode !== null || c.signalCode) return r();
    c.once("exit", () => r());
    c.kill("SIGTERM");
    setTimeout(() => (c.kill("SIGKILL"), r()), 8000).unref();
  }))));
  const zeroPort = await freePort();
  start(
    process.execPath,
    [join(ROOT, "dist/server/server.mjs")],
    {
      PORT: String(port),
      HOST: "127.0.0.1",
      APP_ORIGIN: appOrigin,
      NODE_ENV: "production",
      SESSION_SECRET: "e2e-session-secret-e2e-session-secret-0123456789",
      GITHUB_CLIENT_ID: fake.opts.clientId,
      GITHUB_CLIENT_SECRET: fake.opts.clientSecret,
      GITHUB_API_URL: fake.url,
      GITHUB_WEB_URL: fake.url,
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      OIDC_ISSUER: relay.issuer,
      OIDC_CLIENT_ID: relay.clientId,
      DATABASE_URL: db.url,
      DATABASE_POOL_MAX: "3",
      ZERO_PORT: String(zeroPort),
      ZERO_REPLICA_FILE: join(fixturesRoot, "zero", "replica.db"),
      ZERO_LOG_LEVEL: process.env.E2E_ZERO_LOG_LEVEL ?? "error",
      ZERO_NUM_SYNC_WORKERS: "1",
      TOKEN_ENCRYPTION_KEY: "e2e-token-key-e2e-token-key-e2e-token-key-0123",
      STATIC_DIR: join(ROOT, "dist/web"),
    },
    "server",
  );
  start(process.execPath, [join(ROOT, "dist/cli/git-graph.mjs"), "serve", "--port", String(companionPort), "--allow-origin", appOrigin, "--quiet"], { LANES_CONFIG_DIR: configDir, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" }, "companion");
  await waitFor(`${appOrigin}/health`).catch(() => waitFor(`${appOrigin}/`));
  await waitFor(`http://127.0.0.1:${companionPort}/health`);
  await waitForLog("server", "zero-cache started", 60_000);
  await waitForZeroCache(zeroPort);
  const cliEnv = { ...process.env, LANES_CONFIG_DIR: configDir, LANES_APP_ORIGIN: appOrigin, LANES_NO_AUTOSTART: "1", GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  await pairCompanion(appOrigin, `http://127.0.0.1:${companionPort}`, configDir, cliEnv);

  // Control API for tests (runs in this process, which owns the fake).
  const controlPort = await freePort();
  const control = createServer(async (req, res) => {
    const body = await new Promise<string>((r) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => r(b));
    });
    const a = body ? JSON.parse(body) : {};
    const ok = (v: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v ?? null));
    };
    try {
      if (req.url === "/push") {
        const repo = fake.repo(a.owner, a.name);
        const before = repo.refs.get(`refs/heads/${a.branch}`) ?? "0".repeat(40);
        const c = fake.pushCommit(a.owner, a.name, a.branch, { message: a.message });
        const sha = (c as { sha?: string }).sha ?? repo.refs.get(`refs/heads/${a.branch}`)!;
        if (a.webhook !== false) {
          const payload = JSON.stringify(fake.pushPayload(repo, `refs/heads/${a.branch}`, before, sha, [sha]));
          const r = await fetch(`${appOrigin}/webhooks/github`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": crypto.randomUUID(), "x-hub-signature-256": signWebhook(WEBHOOK_SECRET, payload) },
            body: payload,
          });
          return ok({ sha, webhook: r.status });
        }
        return ok({ sha });
      }
      if (req.url === "/expire") {
        fake.expireAccessTokens(a.login);
        fake.revokeRefreshTokens(a.login);
        return ok(true);
      }
      if (req.url === "/requests") return ok({ count: fake.countRequests() });
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => control.listen(controlPort, "127.0.0.1", () => r()));
  cleanups.push(() => control.close());

  const state: E2EState = {
    appOrigin,
    companionPort,
    companionUrl: `http://127.0.0.1:${companionPort}`,
    configDir,
    fixturesRoot,
    basic: basic.repo,
    remote: basic.remote,
    worktreeFeature: basic.worktreeFeature,
    worktreeTwo: basic.worktreeTwo,
    conflict,
    large,
    control: `http://127.0.0.1:${controlPort}`,
    fakeGitHub: fake.url,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

interface Db {
  url: string;
  stop(): Promise<void>;
}

/**
 * PostgreSQL with wal_level=logical and an empty "lanes" schema. $LANES_ZERO_TEST_DB is used as is
 * (it must be fresh: nothing here drops anything in a database the harness did not start).
 */
async function startPostgres(): Promise<Db> {
  const given = process.env.LANES_ZERO_TEST_DB;
  if (given) {
    const sql = postgres(given, { max: 1, onnotice: () => {} });
    try {
      const [w] = await sql<{ wal_level: string }[]>`show wal_level`;
      if (w?.wal_level !== "logical") throw new Error(`LANES_ZERO_TEST_DB needs wal_level=logical (has ${w?.wal_level})`);
      await sql`create schema if not exists lanes`;
      const [t] = await sql<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema = 'lanes'`;
      if (t && t.n > 0) console.warn(`e2e: LANES_ZERO_TEST_DB already has ${t.n} tables in schema "lanes"; tests expect a fresh one`);
    } finally {
      await sql.end();
    }
    return { url: given, stop: async () => {} };
  }
  const port = await freePort();
  const name = `lanes-e2e-${process.pid}-${port}`;
  try {
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-p", `127.0.0.1:${port}:5432`, "-e", "POSTGRES_PASSWORD=pass", "postgres:17", "-c", "wal_level=logical"], { stdio: "pipe" });
  } catch (e) {
    throw new Error(`e2e needs PostgreSQL with wal_level=logical: set LANES_ZERO_TEST_DB or make Docker available.\n${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`);
  }
  const stop = async () => {
    try {
      execFileSync("docker", ["stop", "-t", "2", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  };
  const url = `postgres://postgres:pass@127.0.0.1:${port}/postgres`;
  const t = Date.now();
  for (;;) {
    const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      await sql`create schema if not exists lanes`;
      await sql.end();
      break;
    } catch (e) {
      await sql.end({ timeout: 1 }).catch(() => {});
      if (Date.now() - t > 60_000) {
        await stop();
        throw new Error(`PostgreSQL container ${name} did not come up: ${e}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { url, stop };
}

/** zero-cache only listens once its replica is ready (~10 s on a fresh database). */
async function waitForZeroCache(port: number, ms = 90_000) {
  const t = Date.now();
  for (;;) {
    const up = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    if (up) return;
    if (Date.now() - t > ms) throw new Error(`zero-cache did not become ready:\n${(logs.get("server") ?? []).join("").slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForLog(name: string, text: string, ms: number) {
  const t = Date.now();
  while (!(logs.get(name) ?? []).join("").includes(text)) {
    if (Date.now() - t > ms) throw new Error(`Timed out waiting for "${text}" from ${name}:\n${(logs.get(name) ?? []).join("").slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Pair the companion with the server for "alice" the way a user does: `git-graph pair` prints a
 * claim link, a signed-in browser opens it. Saves that browser's state (AUTH_STATE) for specs and
 * waits until the companion's source agent is connected.
 */
async function pairCompanion(appOrigin: string, companionUrl: string, configDir: string, env: NodeJS.ProcessEnv) {
  const pair = JSON.parse(execFileSync(process.execPath, [join(ROOT, "dist/cli/git-graph.mjs"), "pair", "--server", appOrigin, "--no-browser", "--json"], { env, encoding: "utf8" })) as { code: string; pairUrl: string };
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLog: string[] = [];
    page.on("console", (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => consoleLog.push(`pageerror: ${e.message}`));
    await page.goto(`${appOrigin}/auth/login?returnTo=${encodeURIComponent("/")}`);
    await page.waitForURL((u) => u.origin === appOrigin && !u.pathname.startsWith("/auth/"));
    if (!(await context.cookies()).some((c) => c.name.includes("lanes_boot"))) throw new Error("sign-in did not set the boot cookie");
    // A fresh page, as when the user follows the link (a hash-only goto would not reload the app).
    await page.close();
    const claimPage = await context.newPage();
    claimPage.on("console", (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
    await claimPage.goto(pair.pairUrl);
    // The claim code leaves the address bar at once.
    expect(new URL(claimPage.url()).hash).not.toContain("claim=");
    try {
      await claimPage.getByText("Companion connected", { exact: false }).first().waitFor({ timeout: 30_000 });
    } catch (e) {
      await claimPage.screenshot({ path: join(ROOT, "test-results", "e2e-pairing-failed.png") }).catch(() => {});
      throw new Error(`claiming the companion failed: ${e}\nbrowser console:\n${consoleLog.join("\n").slice(-4000)}\nserver log:\n${(logs.get("server") ?? []).join("").slice(-3000)}`);
    }
    await context.storageState({ path: AUTH_STATE });
    await context.close();
  } finally {
    await browser.close();
  }
  const token = (JSON.parse(readFileSync(join(configDir, "companion.json"), "utf8")) as { token: string }).token;
  const t = Date.now();
  let last: unknown = null;
  while (Date.now() - t < 60_000) {
    const r = (await fetch(`${companionUrl}/agent`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .catch(() => null)) as { status?: { state?: string } } | null;
    last = r;
    if (r?.status?.state === "connected") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`companion agent did not connect: ${JSON.stringify(last)}`);
}

export function state(): E2EState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2EState;
}

/** Run the production CLI against the harness companion. */
export function cli(args: string[], cwd?: string): string {
  const s = state();
  return execFileSync(process.execPath, [join(ROOT, "dist/cli/git-graph.mjs"), ...args], {
    cwd,
    env: { ...process.env, LANES_CONFIG_DIR: s.configDir, LANES_APP_ORIGIN: s.appOrigin, LANES_NO_AUTOSTART: "1" },
    encoding: "utf8",
  });
}

/**
 * Register a local path with the companion (`git-graph open`) and return { key, url }. The
 * companion is already paired, so the link carries no claim code; open it in a signed-in page.
 */
export function openLocal(path: string, extra = ""): { key: string; url: string } {
  const out = JSON.parse(cli(["open", path, "--no-browser", "--json", ...(extra ? extra.split(" ") : [])])) as { url: string; key: string; paired?: boolean };
  if (out.url.includes("claim=")) throw new Error(`companion is not paired: ${out.url}`);
  return { key: out.key, url: out.url };
}

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(state().fixturesRoot, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "External Tool",
      GIT_AUTHOR_EMAIL: "ext@example.com",
      GIT_COMMITTER_NAME: "External Tool",
      GIT_COMMITTER_EMAIL: "ext@example.com",
    },
  });
}

export async function control(path: string, body: unknown = {}) {
  const r = await fetch(state().control + path, { method: "POST", body: JSON.stringify(body) });
  return r.json();
}
