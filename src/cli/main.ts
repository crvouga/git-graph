// `git-graph` — command-line entry point for Lanes (bundled to dist/cli/git-graph.mjs).
//
// Exit codes: 0 ok, 1 error, 2 usage, 3 confirmation required, 4 unsupported/unavailable,
// 5 not found, 6 unauthenticated, 7 companion unreachable.

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { AppError, parseRepoKey, repoKey, type ErrorCode, type EventEnvelope, type RepoInfo } from "../core/types.ts";
import { describeCommand, executeCommand, type ExecuteResponse } from "../core/commands/registry.ts";
import { HttpApi, subscribeEvents } from "../core/api/client.ts";
import { parseGitHubInput } from "../core/url/state.ts";
import { DEFAULT_APP_ORIGIN, DEFAULT_PORT, readConfig, rememberRepo, repoIdFor, updateConfig, type ServerAgent } from "../companion/config.ts";
import { createCompanionRegistry } from "../companion/commands.ts";
import { LocalRepos } from "../companion/local-repos.ts";
import { locateRepository } from "../companion/git-adapter.ts";
import { runGit } from "../companion/exec.ts";

export const EXIT = { ok: 0, error: 1, usage: 2, confirm: 3, unsupported: 4, notFound: 5, unauthenticated: 6, unreachable: 7 } as const;

export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "CONFIRMATION_REQUIRED":
      return EXIT.confirm;
    case "BAD_REQUEST":
      return EXIT.usage;
    case "UNSUPPORTED":
    case "GIT_MISSING":
      return EXIT.unsupported;
    case "NOT_FOUND":
    case "REF_NOT_FOUND":
    case "COMMIT_NOT_FOUND":
      return EXIT.notFound;
    case "UNAUTHENTICATED":
    case "FORBIDDEN":
      return EXIT.unauthenticated;
    case "OFFLINE":
      return EXIT.unreachable;
    default:
      return EXIT.error;
  }
}

class UsageError extends Error {}

const HELP = `git-graph — Lanes, a fast keyboard-first Git graph

Usage:
  git-graph open [path|owner/repo|github-url] [--branch b] [--commit h] [--provider github]
                 [--app-origin URL] [--no-pair] [--no-browser] [--json]
  git-graph compare <a> <b> [path] [--repo path] [--app-origin URL] [--no-pair] [--no-browser] [--json]
  git-graph url --repo <key|owner/repo|path> [--commit h] [--compare h] [--branch b] [--file p] [--json]
  git-graph commands [--json]
  git-graph exec <command-id> [--json '<args>'] [--confirm <token>] [--repo path|key] [--server URL]
  git-graph pair [--server URL] [--no-browser] [--json]
  git-graph pair --local [--json]
  git-graph events [--repo path|key] [--cursor c] [--max-events n] [--timeout ms]
  git-graph run [--repo path] -- <git args...>
  git-graph serve [--port n] [--allow-origin URL ...] [--app-origin URL]
  git-graph mcp

Exit codes: 0 ok, 1 error, 2 usage, 3 confirmation required, 4 unsupported,
            5 not found, 6 unauthenticated, 7 companion unreachable.
Destructive commands never run without --confirm <token> (there is no --yes).

Local repositories reach the web app through the Lanes server: \`git-graph pair\` registers this
companion with the server (default: $LANES_APP_ORIGIN, else the server you paired with, else
${DEFAULT_APP_ORIGIN}) and opens a link that binds it to your signed-in account. \`open\` and
\`compare\` do this automatically when the companion is not paired yet (--no-pair skips it).
\`pair --local\` prints a one-time code for the companion's localhost API instead.`;

interface Out {
  json: boolean;
}

function print(o: Out, human: string, data: unknown) {
  if (o.json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else process.stdout.write(human + "\n");
}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T, positionals = true) {
  try {
    return parseArgs({ args, options, allowPositionals: positionals, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Companion connection
// ---------------------------------------------------------------------------

function companionPort(): number {
  if (process.env.LANES_PORT) return Number(process.env.LANES_PORT);
  return readConfig().port ?? DEFAULT_PORT;
}

function companionUrl(): string {
  return `http://127.0.0.1:${companionPort()}`;
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = (await r.json()) as { name?: string };
    return j.name === "lanes-companion";
  } catch {
    return false;
  }
}

/** Ensure a companion answers on the configured port, starting a detached one if needed. */
async function ensureCompanion(start = true): Promise<string> {
  const url = companionUrl();
  if (await healthy(url)) return url;
  if (!start || process.env.LANES_NO_AUTOSTART === "1") throw new AppError("OFFLINE", `The Lanes companion is not running at ${url}. Start it with \`git-graph serve\`.`);
  const script = process.argv[1];
  if (!script) throw new AppError("OFFLINE", "Cannot locate the git-graph executable to start the companion");
  const child = spawn(process.execPath, [...process.execArgv, script, "serve", "--port", String(companionPort()), "--quiet"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (await healthy(url)) return url;
  }
  throw new AppError("OFFLINE", `Started the companion but it did not answer at ${url}`);
}

function companionApi(url: string): HttpApi {
  const token = readConfig().token;
  return new HttpApi({ baseUrl: `${url}/api/v1`, headers: () => ({ authorization: `Bearer ${token}` }), client: "cli" });
}

async function pairingCode(url: string): Promise<{ code: string; expiresAt: number }> {
  const token = readConfig().token;
  const res = await fetch(`${url}/pair/code`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch((e) => {
    throw new AppError("OFFLINE", `Cannot reach the companion: ${e instanceof Error ? e.message : e}`);
  });
  const body = (await res.json().catch(() => null)) as { code?: string; expiresAt?: number; error?: unknown } | null;
  if (!res.ok || !body?.code) throw AppError.from(body?.error ?? { code: "UPSTREAM_ERROR", message: `HTTP ${res.status}` });
  return { code: body.code, expiresAt: body.expiresAt ?? 0 };
}

async function executeRemote(api: HttpApi, command: string, args: unknown, confirm?: string): Promise<ExecuteResponse> {
  try {
    const r = await api.request<ExecuteResponse>("POST", "/commands/execute", { command, args, confirm });
    return r.data;
  } catch (e) {
    return { ok: false, command, error: AppError.from(e).toJSON() };
  }
}

function unwrap<T>(r: ExecuteResponse): T {
  if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details);
  return r.result as T;
}

// ---------------------------------------------------------------------------
// Repository arguments
// ---------------------------------------------------------------------------

/** Compute a local key without the companion and register the path so the companion can serve it. */
async function localKeyFor(path: string): Promise<string> {
  const loc = await locateRepository(path);
  const id = repoIdFor(readConfig().installId, loc.toplevel);
  rememberRepo(id, { path: loc.toplevel, commonDir: loc.commonDir });
  return `local:${id}`;
}

function looksLikePath(s: string): boolean {
  return s === "." || s === ".." || s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~") || /^[A-Za-z]:[\\/]/.test(s) || existsSync(s);
}

async function repoKeyFrom(input: string, provider?: string): Promise<string> {
  if (parseRepoKey(input)) return input;
  if (provider === "github" || (!looksLikePath(input) && parseGitHubInput(input))) {
    const gh = parseGitHubInput(input);
    if (!gh) throw new UsageError(`Not a GitHub repository: ${input}`);
    return repoKey(gh.repo);
  }
  return localKeyFor(resolve(input));
}

async function resolveCommitish(path: string, rev: string): Promise<string> {
  if (/^[0-9a-f]{4,64}$/i.test(rev)) return rev.toLowerCase();
  if (rev.startsWith("-")) throw new UsageError(`Invalid revision ${rev}`);
  const loc = await locateRepository(path);
  const r = await runGit(["rev-parse", "-q", "--verify", "--end-of-options", `${rev}^{commit}`], { cwd: loc.toplevel, readOnly: true });
  if (r.code !== 0) throw new AppError("REF_NOT_FOUND", `Unknown revision "${rev}"`);
  return r.stdout.trim();
}

/** The Lanes web app / server: flag, $LANES_APP_ORIGIN, the server this companion is paired with, default. */
function appOrigin(flag?: string): string {
  return (flag || process.env.LANES_APP_ORIGIN || readConfig().server?.url || DEFAULT_APP_ORIGIN).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Pairing with the hosted server (the companion is a Zero source agent there)
// ---------------------------------------------------------------------------

interface PairCode {
  agentId: string;
  code: string;
  pairUrl: string;
  expiresAt: number;
  registered: boolean;
}

async function serverCall<T>(server: string, path: string, init: { method: "GET" | "POST"; token?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      method: init.method,
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new AppError("OFFLINE", `Cannot reach the Lanes server at ${server}: ${e instanceof Error ? e.message : e}`);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!res.ok || !body) {
    if (res.status === 401) throw new AppError("UNAUTHENTICATED", (body?.error as { message?: string } | undefined)?.message ?? "The server does not recognise this companion");
    throw AppError.from(body?.error ?? { code: "UPSTREAM_ERROR", message: `${server}${path}: HTTP ${res.status}` });
  }
  return body;
}

async function registerWith(server: string): Promise<PairCode> {
  const r = await serverCall<{ agentId: string; token: string; code: string; pairUrl: string; expiresAt: number }>(server, "/agent-api/v1/register", {
    method: "POST",
    body: { name: hostname() || "Companion" },
  });
  const entry: ServerAgent = { url: server, agentId: r.agentId, token: r.token };
  updateConfig((c) => {
    c.server = entry;
  });
  return { agentId: r.agentId, code: r.code, pairUrl: r.pairUrl, expiresAt: r.expiresAt, registered: true };
}

/** A fresh pairing code for `server`, registering this companion there first if needed. */
async function newPairCode(server: string): Promise<PairCode> {
  const cur = readConfig().server;
  if (!cur || cur.url !== server) return registerWith(server);
  try {
    const r = await serverCall<{ agentId: string; code: string; pairUrl: string; expiresAt: number }>(server, "/agent-api/v1/pair", { method: "POST", token: cur.token });
    return { ...r, registered: false };
  } catch (e) {
    if (AppError.from(e).code === "UNAUTHENTICATED") return registerWith(server); // the server forgot us
    throw e;
  }
}

/** Null when this companion is already paired with an account on `server`; else a pairing code. */
async function pairIfNeeded(server: string): Promise<PairCode | null> {
  const cur = readConfig().server;
  if (cur && cur.url === server) {
    try {
      const me = await serverCall<{ paired: boolean }>(server, "/agent-api/v1/me", { method: "GET", token: cur.token });
      if (me.paired) return null;
    } catch (e) {
      if (AppError.from(e).code !== "UNAUTHENTICATED") throw e;
    }
  }
  return newPairCode(server);
}

/** Ask a running companion to (re)start its source agent from the config. */
async function reloadCompanionAgent(base: string): Promise<unknown> {
  const token = readConfig().token;
  const res = await fetch(`${base}/agent/reload`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { status?: unknown } | null;
  return body?.status ?? null;
}

/** The companion's source agent should be running for the paired server; start it if not. */
async function ensureCompanionAgent(base: string) {
  const token = readConfig().token;
  const res = await fetch(`${base}/agent`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { enabled?: boolean; status?: { state?: string; agentId?: string; url?: string } | null } | null;
  const cfg = readConfig().server;
  if (!body?.enabled || !cfg) return;
  const s = body.status;
  if (!s || s.agentId !== cfg.agentId || s.url !== cfg.url || s.state === "unauthorized" || s.state === "error" || s.state === "stopped") await reloadCompanionAgent(base);
}

function withClaim(link: string, code: string): string {
  return `${link}${link.includes("#") ? "&" : "#"}claim=${encodeURIComponent(code)}`;
}

/**
 * Make sure the web app can see local repositories: the companion is registered with and paired to
 * the server, and its agent runs. Returns the claim code to put in the link when pairing is needed.
 * Server problems are reported but do not stop `open` (the link is still printed).
 */
async function preparePairing(base: string, server: string, skip: boolean): Promise<{ claim: string | null; warning?: string }> {
  if (skip) return { claim: null };
  try {
    const p = await pairIfNeeded(server);
    if (p) await reloadCompanionAgent(base);
    else await ensureCompanionAgent(base);
    return { claim: p?.code ?? null };
  } catch (e) {
    const err = AppError.from(e);
    process.stderr.write(`warning: could not pair with ${server}: ${err.message}\n`);
    return { claim: null, warning: err.message };
  }
}

async function buildLink(origin: string, args: Record<string, unknown>): Promise<string> {
  const registry = createCompanionRegistry(new LocalRepos());
  const r = await executeCommand(registry, { appOrigin: origin, actor: "cli" }, { command: "link.build", args });
  return unwrap<{ url: string }>(r).url;
}

export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const c = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    c.on("error", () => {});
    c.unref();
  } catch {
    /* printing the URL is enough */
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdOpen(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    branch: { type: "string" },
    commit: { type: "string" },
    provider: { type: "string" },
    "app-origin": { type: "string" },
    "no-pair": { type: "boolean" },
    "no-browser": { type: "boolean" },
    json: { type: "boolean" },
  });
  const out = { json: !!values.json };
  const target = positionals[0] ?? ".";
  const origin = appOrigin(values["app-origin"]);
  if (values.provider && values.provider !== "github" && values.provider !== "local") throw new UsageError(`Unknown provider ${values.provider}`);
  const gh = values.provider === "local" ? null : values.provider === "github" || !looksLikePath(target) ? parseGitHubInput(target) : null;
  if (values.provider === "github" && !gh) throw new UsageError(`Not a GitHub repository: ${target}`);
  let url: string;
  let extra: Record<string, unknown> = {};
  if (gh) {
    const commit = values.commit ?? gh.commit;
    const branch = values.branch ?? gh.branch;
    url = await buildLink(origin, {
      repo: repoKey(gh.repo),
      ...(branch ? { branches: [branch], focusBranch: branch } : {}),
      ...(commit ? { commit } : {}),
    });
  } else {
    const path = resolve(target);
    const base = await ensureCompanion();
    const info = unwrap<RepoInfo>(await executeRemote(companionApi(base), "local.open", { path }));
    const commit = values.commit ? await resolveCommitish(path, values.commit) : undefined;
    const link = await buildLink(origin, { repo: info.key, ...(values.branch ? { branches: [values.branch], focusBranch: values.branch } : {}), ...(commit ? { commit } : {}) });
    const p = await preparePairing(base, origin, !!values["no-pair"]);
    url = p.claim ? withClaim(link, p.claim) : link;
    extra = { key: info.key, path: info.worktreePath, companion: base, paired: !p.claim && !p.warning && !values["no-pair"], ...(p.warning ? { warning: p.warning } : {}) };
  }
  if (!values["no-browser"]) openBrowser(url);
  print(out, url, { url, ...extra });
  return EXIT.ok;
}

async function cmdCompare(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    repo: { type: "string" },
    "app-origin": { type: "string" },
    "no-pair": { type: "boolean" },
    "no-browser": { type: "boolean" },
    json: { type: "boolean" },
  });
  if (positionals.length < 2) throw new UsageError("compare needs <a> <b> [path]");
  const [a, b, file] = positionals as [string, string, string | undefined];
  const path = resolve(values.repo ?? ".");
  const [ha, hb] = await Promise.all([resolveCommitish(path, a), resolveCommitish(path, b)]);
  const base = await ensureCompanion();
  const info = unwrap<RepoInfo>(await executeRemote(companionApi(base), "local.open", { path }));
  const origin = appOrigin(values["app-origin"]);
  const link = await buildLink(origin, { repo: info.key, commit: ha, compare: hb, ...(file ? { file, view: "diff" } : {}) });
  const p = await preparePairing(base, origin, !!values["no-pair"]);
  const url = p.claim ? withClaim(link, p.claim) : link;
  if (!values["no-browser"]) openBrowser(url);
  print({ json: !!values.json }, url, { url, key: info.key });
  return EXIT.ok;
}

async function cmdUrl(argv: string[]): Promise<number> {
  const { values } = parse(
    argv,
    {
      repo: { type: "string" },
      commit: { type: "string" },
      compare: { type: "string" },
      branch: { type: "string", multiple: true },
      "focus-branch": { type: "string" },
      file: { type: "string" },
      view: { type: "string" },
      provider: { type: "string" },
      "app-origin": { type: "string" },
      json: { type: "boolean" },
    },
    false,
  );
  const repoIn = values.repo ?? ".";
  const key = await repoKeyFrom(repoIn, values.provider);
  const local = key.startsWith("local:") && !parseRepoKey(repoIn) ? resolve(repoIn) : null;
  const commit = values.commit ? (local ? await resolveCommitish(local, values.commit) : values.commit) : undefined;
  const compare = values.compare ? (local ? await resolveCommitish(local, values.compare) : values.compare) : undefined;
  const url = await buildLink(appOrigin(values["app-origin"]), {
    repo: key,
    ...(values.branch?.length ? { branches: values.branch } : {}),
    ...(values["focus-branch"] ? { focusBranch: values["focus-branch"] } : {}),
    ...(commit ? { commit } : {}),
    ...(compare ? { compare } : {}),
    ...(values.file ? { file: values.file } : {}),
    ...(values.view ? { view: values.view } : {}),
  });
  print({ json: !!values.json }, url, { url, key });
  return EXIT.ok;
}

async function cmdCommands(argv: string[]): Promise<number> {
  const { values } = parse(argv, { json: { type: "boolean" } }, false);
  const registry = createCompanionRegistry(new LocalRepos());
  const list = registry.list().map(describeCommand);
  if (values.json) {
    process.stdout.write(JSON.stringify({ commands: list }, null, 2) + "\n");
  } else {
    const w = Math.max(...list.map((c) => c.id.length));
    for (const c of list) process.stdout.write(`${c.id.padEnd(w)}  ${c.title}${c.destructive ? "  [destructive]" : ""}\n`);
  }
  return EXIT.ok;
}

async function cmdExec(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    json: { type: "string" },
    args: { type: "string" },
    confirm: { type: "string" },
    repo: { type: "string" },
    server: { type: "string" },
    "app-origin": { type: "string" },
  });
  const command = positionals[0];
  if (!command) throw new UsageError("exec needs a command id (see `git-graph commands`)");
  const raw = values.json ?? values.args ?? "{}";
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new UsageError(`--json is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new UsageError("--json must be a JSON object");
  const registry = createCompanionRegistry(new LocalRepos());
  const def = registry.get(command);
  if (!def) {
    process.stdout.write(JSON.stringify({ ok: false, command, error: { code: "NOT_FOUND", message: `Unknown command "${command}"` } }, null, 2) + "\n");
    return EXIT.notFound;
  }
  // Companion-level commands run in the companion's cwd: send absolute paths.
  if (command.startsWith("local.") && typeof args.path === "string") args.path = resolve(args.path);
  const takesRepo = (describeCommand(def).argsSchema as { properties?: Record<string, unknown> })?.properties?.repo !== undefined;
  if (values.repo) args.repo = await repoKeyFrom(values.repo);
  else if (takesRepo && args.repo === undefined) args.repo = await localKeyFor(process.cwd()).catch(() => undefined);
  if (typeof args.repo === "string" && !parseRepoKey(args.repo)) args.repo = await repoKeyFrom(args.repo);

  let res: ExecuteResponse;
  const key = typeof args.repo === "string" ? args.repo : null;
  if (command === "link.build") {
    res = await executeCommand(registry, { appOrigin: appOrigin(values["app-origin"]), actor: "cli" }, { command, args, confirm: values.confirm });
  } else if (key && !key.startsWith("local:")) {
    const server = values.server ?? process.env.LANES_SERVER_URL;
    if (!server) {
      res = { ok: false, command, error: { code: "UNSUPPORTED", message: `${key} is not a local repository: pass --server URL (or set LANES_SERVER_URL) to use a hosted Lanes server.` } };
    } else {
      const tok = process.env.LANES_SERVER_TOKEN;
      const api = new HttpApi({ baseUrl: `${server.replace(/\/+$/, "")}/api/v1`, client: "cli", headers: (): Record<string, string> => (tok ? { authorization: `Bearer ${tok}` } : {}) });
      res = await executeRemote(api, command, args, values.confirm);
    }
  } else {
    let base: string;
    try {
      base = await ensureCompanion();
    } catch (e) {
      const err = AppError.from(e);
      process.stdout.write(JSON.stringify({ ok: false, command, error: err.toJSON() }, null, 2) + "\n");
      return exitCodeFor(err.code);
    }
    res = await executeRemote(companionApi(base), command, args, values.confirm);
  }
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  if (res.ok) return EXIT.ok;
  if (res.error.code === "CONFIRMATION_REQUIRED") {
    const tok = (res.error.details as { confirmToken?: string } | undefined)?.confirmToken;
    process.stderr.write(`Confirmation required: ${res.error.message}\nTo proceed, re-run the same command with --confirm ${tok}\n`);
  } else {
    process.stderr.write(`error: ${res.error.code}: ${res.error.message}\n`);
  }
  return exitCodeFor(res.error.code);
}

async function cmdPair(argv: string[]): Promise<number> {
  const { values } = parse(argv, { json: { type: "boolean" }, local: { type: "boolean" }, server: { type: "string" }, "no-browser": { type: "boolean" } }, false);
  const out = { json: !!values.json };
  const base = await ensureCompanion();
  if (values.local) {
    const p = await pairingCode(base);
    print(out, p.code, { ...p, companion: base });
    return EXIT.ok;
  }
  const server = appOrigin(values.server);
  const p = await newPairCode(server);
  const agent = await reloadCompanionAgent(base);
  if (!values["no-browser"]) openBrowser(p.pairUrl);
  const human = `Open this link while signed in to ${server} to pair this computer (expires ${new Date(p.expiresAt).toLocaleTimeString()}):\n${p.pairUrl}`;
  print(out, human, { server, agentId: p.agentId, registered: p.registered, code: p.code, pairUrl: p.pairUrl, expiresAt: p.expiresAt, companion: base, agent });
  return EXIT.ok;
}

async function cmdEvents(argv: string[]): Promise<number> {
  const { values } = parse(argv, { repo: { type: "string" }, cursor: { type: "string" }, "max-events": { type: "string" }, timeout: { type: "string" } }, false);
  const key = await repoKeyFrom(values.repo ?? ".");
  if (!key.startsWith("local:")) throw new AppError("UNSUPPORTED", "events streams local repositories; use the hosted server's SSE endpoint for GitHub repositories");
  const base = await ensureCompanion();
  const api = companionApi(base);
  const max = values["max-events"] ? Number(values["max-events"]) : Infinity;
  let n = 0;
  return new Promise<number>((resolveExit) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      sub.close();
      resolveExit(code);
    };
    const sub = subscribeEvents(
      api,
      key,
      (env: EventEnvelope) => {
        process.stdout.write(JSON.stringify(env) + "\n");
        if (++n >= max) finish(EXIT.ok);
      },
      {
        initialCursor: values.cursor ?? null,
        onState: (s, info) => {
          if (s === "backoff" && info?.error?.includes("401")) finish(EXIT.unauthenticated);
        },
      },
    );
    if (values.timeout) setTimeout(() => finish(EXIT.ok), Number(values.timeout)).unref?.();
    process.once("SIGINT", () => finish(EXIT.ok));
  });
}

async function cmdRun(argv: string[]): Promise<number> {
  const dd = argv.indexOf("--");
  const before = dd >= 0 ? argv.slice(0, dd) : argv;
  const gitArgs = dd >= 0 ? argv.slice(dd + 1) : [];
  const { values } = parse(before, { repo: { type: "string" } }, false);
  if (!gitArgs.length) throw new UsageError("run needs git arguments after --, e.g. git-graph run -- rebase -i HEAD~3");
  const loc = await locateRepository(resolve(values.repo ?? "."));
  return new Promise((res) => {
    const c = spawn("git", gitArgs, { cwd: loc.toplevel, stdio: "inherit" });
    c.on("error", () => res(EXIT.unsupported));
    c.on("close", (code) => res(code ?? EXIT.error));
  });
}

async function cmdServe(argv: string[]): Promise<number> {
  const { values } = parse(argv, { port: { type: "string" }, "allow-origin": { type: "string", multiple: true }, "app-origin": { type: "string" }, quiet: { type: "boolean" } }, false);
  const { serveCompanion } = await import("../companion/server.ts");
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError(`Invalid --port ${values.port}`);
  await serveCompanion({ port, allowedOrigins: values["allow-origin"] ?? [], appOrigin: values["app-origin"], quiet: values.quiet });
  return new Promise<number>(() => {}); // runs until signalled
}

async function cmdMcp(): Promise<number> {
  const { startMcpServer } = await import("../mcp/server.ts");
  await startMcpServer();
  return new Promise<number>(() => {});
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "open":
        return await cmdOpen(rest);
      case "compare":
        return await cmdCompare(rest);
      case "url":
        return await cmdUrl(rest);
      case "commands":
        return await cmdCommands(rest);
      case "exec":
        return await cmdExec(rest);
      case "pair":
        return await cmdPair(rest);
      case "events":
        return await cmdEvents(rest);
      case "run":
        return await cmdRun(rest);
      case "serve":
        return await cmdServe(rest);
      case "mcp":
        return await cmdMcp();
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP + "\n");
        return cmd === undefined ? EXIT.usage : EXIT.ok;
      default:
        throw new UsageError(`Unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`usage error: ${e.message}\n\n${HELP}\n`);
      return EXIT.usage;
    }
    const err = AppError.from(e);
    if (argv.includes("--json")) process.stdout.write(JSON.stringify({ ok: false, error: err.toJSON() }, null, 2) + "\n");
    process.stderr.write(`error: ${err.code}: ${err.message}\n`);
    return exitCodeFor(err.code);
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // Flush piped stdout before exiting (open handles such as SSE readers must not keep us alive).
    process.stdout.write("", () => process.exit(code));
  });
}

