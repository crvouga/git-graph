// End-to-end harness: runs the PRODUCTION artifacts (dist/server/server.mjs serving dist/web,
// dist/cli/git-graph.mjs serve) against disposable fixtures and a fake GitHub. Exposes a small
// control API so tests can simulate external GitHub pushes (with signed webhooks), expire sessions,
// and count upstream requests.

import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { makeBasic, makeConflict } from "../fixtures/make-fixtures.ts";
import { FakeGitHub, makeGitHubFixture, signWebhook } from "../fakes/github.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
export const STATE_FILE = join(ROOT, "test-results", "e2e-state.json");
export const WEBHOOK_SECRET = "e2e-webhook-secret";

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

function start(cmd: string, args: string[], env: Record<string, string>, name: string) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  child.stdout!.on("data", (d) => log.push(String(d)));
  child.stderr!.on("data", (d) => log.push(String(d)));
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`[${name}] exited ${code}\n${log.join("").slice(-2000)}`);
  });
  children.push(child);
  return child;
}

export async function startHarness(): Promise<E2EState> {
  for (const f of ["dist/web/index.html", "dist/server/server.mjs", "dist/cli/git-graph.mjs"]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`Missing ${f}: run \`pnpm build\` first (e2e tests run against the production build).`);
  }
  const fixturesRoot = mkdtempSync(join(tmpdir(), "lanes-e2e-"));
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
  fake.addUser("alice", "Alice A.");
  fake.addUser("bob", "Bob B.");
  fake.addRepoFromGit("octo", "basic", ghDir, { perms: { alice: "admin", bob: "read" } });
  fake.addRepoFromGit("octo", "secret", ghDir, { private: true, perms: { alice: "write" } });
  fake.authorizingUser = "alice";

  const port = await freePort();
  const companionPort = await freePort();
  const appOrigin = `http://127.0.0.1:${port}`;
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
      STATIC_DIR: join(ROOT, "dist/web"),
    },
    "server",
  );
  start(process.execPath, [join(ROOT, "dist/cli/git-graph.mjs"), "serve", "--port", String(companionPort), "--allow-origin", appOrigin, "--quiet"], { LANES_CONFIG_DIR: configDir, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" }, "companion");
  await waitFor(`${appOrigin}/health`).catch(() => waitFor(`${appOrigin}/`));
  await waitFor(`http://127.0.0.1:${companionPort}/health`);

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
  (globalThis as { __lanesStop?: () => Promise<void> }).__lanesStop = async () => {
    for (const c of children) c.kill("SIGTERM");
    control.close();
    await fake.close();
    rmSync(fixturesRoot, { recursive: true, force: true });
  };
  return state;
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

/** Register a local path with the companion and return { key, url-with-pairing-fragment }. */
export function openLocal(path: string, extra = ""): { key: string; url: string } {
  const out = JSON.parse(cli(["open", path, "--no-browser", "--json", ...(extra ? extra.split(" ") : [])])) as { url: string; key: string };
  const s = state();
  const url = out.url.includes("companion=") ? out.url : `${out.url}&companion=${s.companionPort}`;
  return { key: out.key, url };
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
