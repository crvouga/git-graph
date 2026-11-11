// `git-graph` CLI: JSON output, exit codes, confirmation flow, deep links.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, makeBasic, type BasicFixture } from "../fixtures/make-fixtures.ts";
import { createCompanion } from "../../src/companion/server.ts";
import { readConfig, repoIdFor } from "../../src/companion/config.ts";

const CLI = resolve(import.meta.dirname, "../../src/cli/main.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: () => any;
}

let env: NodeJS.ProcessEnv;

/** Stand-in for the hosted server's companion registration API (/agent-api/v1). */
function fakeLanesServer() {
  const state = { paired: false, registrations: 0, codes: 0, token: "agent-token-secret-0123456789" };
  let url = "";
  const server: Server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const authed = req.headers.authorization === `Bearer ${state.token}`;
    const code = () => {
      state.codes++;
      return { code: `claim-code-${state.codes}`, pairUrl: `${url}/#claim=claim-code-${state.codes}`, expiresAt: Date.now() + 600_000 };
    };
    if (req.method === "POST" && req.url === "/agent-api/v1/register") {
      state.registrations++;
      return json(200, { agentId: "companion-test", token: state.token, ...code() });
    }
    if (!authed) return json(401, { error: { code: "UNAUTHENTICATED", message: "Unknown companion token" } });
    if (req.method === "GET" && req.url === "/agent-api/v1/me") return json(200, { agentId: "companion-test", name: "t", paired: state.paired, userID: "agent:companion-test", cacheURL: `${url}/zero` });
    if (req.method === "POST" && req.url === "/agent-api/v1/pair") {
      state.paired = false;
      return json(200, { agentId: "companion-test", ...code() });
    }
    json(404, { error: { code: "NOT_FOUND", message: req.url } });
  });
  return {
    state,
    url: () => url,
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => ((url = `http://127.0.0.1:${(server.address() as { port: number }).port}`), r()))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function cli(args: string[], extraEnv: Record<string, string> = {}, cwd?: string): Promise<CliResult> {
  return new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv }, cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      res({ code: typeof code === "number" ? code : 1, stdout, stderr, json: () => JSON.parse(stdout) });
    });
  });
}

describe("git-graph CLI", () => {
  let root: string;
  let fx: BasicFixture;
  let close: () => Promise<void>;
  let port: number;
  let configDir: string;
  let installId: string;
  const lanes = fakeLanesServer();

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lanes-cli-")));
    const cfg = join(root, "user.gitconfig");
    writeFileSync(cfg, "[user]\n\tname = C\n\temail = c@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
    if (!existsSync(join(ROOT, ".gitconfig"))) {
      mkdirSync(ROOT, { recursive: true });
      writeFileSync(join(ROOT, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
    }
    process.env.GIT_CONFIG_GLOBAL = cfg;
    fx = makeBasic(root);
    configDir = join(root, "cfg");
    await lanes.listen();
    const companion = createCompanion({ configDir });
    installId = readConfig(configDir).installId;
    const l = await companion.listen(0);
    port = l.port;
    close = l.close;
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: cfg,
      GIT_CONFIG_NOSYSTEM: "1",
      LANES_CONFIG_DIR: configDir,
      LANES_PORT: String(port),
      LANES_NO_AUTOSTART: "1",
      LANES_APP_ORIGIN: "https://lanes.example.com",
    };
  }, 120_000);
  afterAll(async () => {
    await close();
    await lanes.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("commands --json lists every command with schemas", async () => {
    const r = await cli(["commands", "--json"]);
    expect(r.code).toBe(0);
    const cmds = r.json().commands as { id: string; argsSchema: { type: string }; destructive: boolean }[];
    const ids = cmds.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["repo.refs", "repo.history", "git.reset", "link.build", "local.open", "local.clone", "local.init"]));
    expect(cmds.find((c) => c.id === "git.reset")!.destructive).toBe(true);
    expect(cmds.find((c) => c.id === "repo.refs")!.argsSchema.type).toBe("object");
    const human = await cli(["commands"]);
    expect(human.stdout).toMatch(/git\.reset\s+Reset current branch\s+\[destructive\]/);
  });

  it("exec returns JSON and exit 0 for queries (repo by path or by key)", async () => {
    const r = await cli(["exec", "repo.refs", "--repo", fx.repo]);
    expect(r.code, r.stderr).toBe(0);
    const out = r.json();
    expect(out.ok).toBe(true);
    expect(out.result.refs.some((x: { short: string }) => x.short === "main")).toBe(true);
    const key = `local:${repoIdFor(installId, realpathSync(fx.repo))}`;
    const byKey = await cli(["exec", "repo.status", "--json", JSON.stringify({ repo: key })]);
    expect(byKey.code).toBe(0);
    expect(byKey.json().result.untracked).toEqual(["-dash.txt", "notes with space.txt", "ünïcødé.txt"]);
    // repo defaults to the current directory
    const cwd = await cli(["exec", "repo.info"], {}, join(fx.repo, "src"));
    expect(cwd.json().result.key).toBe(key);
  });

  it("unconfirmed destructive commands exit 3 with consequence + token; --confirm runs them", async () => {
    execFileSync("git", ["branch", "cli-doomed", "HEAD"], { cwd: fx.repo });
    const args = ["exec", "git.branch.delete", "--repo", fx.repo, "--json", JSON.stringify({ name: "cli-doomed" })];
    const r = await cli(args);
    expect(r.code).toBe(3);
    const err = r.json().error;
    expect(err.code).toBe("CONFIRMATION_REQUIRED");
    expect(err.details.consequence).toMatch(/Delete branch "cli-doomed"/);
    expect(r.stderr).toContain(`--confirm ${err.details.confirmToken}`);
    expect(execFileSync("git", ["branch", "--list", "cli-doomed"], { cwd: fx.repo, encoding: "utf8" }).trim()).toBe("cli-doomed");
    const yes = await cli([...args, "--yes"]);
    expect(yes.code).toBe(2); // there is no --yes
    const ok = await cli([...args, "--confirm", err.details.confirmToken]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(execFileSync("git", ["branch", "--list", "cli-doomed"], { cwd: fx.repo, encoding: "utf8" }).trim()).toBe("");
  });

  it("stable exit codes: usage 2, not found 5, unsupported 4, unreachable 7", async () => {
    expect((await cli(["exec", "repo.refs", "--json", "{nope"])).code).toBe(2);
    expect((await cli(["exec", "repo.bogus"])).code).toBe(5);
    expect((await cli(["exec", "repo.commit", "--repo", fx.repo, "--json", '{"hash":"deadbeefdeadbeef"}'])).code).toBe(5);
    expect((await cli(["exec", "repo.refs", "--json", '{"repo":"github:o:r"}'], { LANES_SERVER_URL: "" })).code).toBe(4);
    expect((await cli(["bogus"])).code).toBe(2);
    const down = await cli(["exec", "repo.refs", "--repo", fx.repo], { LANES_PORT: "1" });
    expect(down.code).toBe(7);
    expect(down.json().error.code).toBe("OFFLINE");
  });

  it("url prints deep links (local path, key, GitHub)", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.repo, encoding: "utf8" }).trim();
    const id = repoIdFor(installId, realpathSync(fx.repo));
    const r = await cli(["url", "--repo", fx.repo, "--commit", "HEAD", "--branch", "main", "--file", "src/main.ts"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`https://lanes.example.com/local/${id}?branch=main&commit=${head}&file=src/main.ts`);
    const gh = await cli(["url", "--repo", "octo/repo", "--commit", "abcdef1", "--json"]);
    expect(gh.json()).toEqual({ url: "https://lanes.example.com/github/octo/repo?commit=abcdef1", key: "github:octo:repo" });
    const viaExec = await cli(["exec", "link.build", "--json", JSON.stringify({ repo: `local:${id}`, compare: head, commit: head.slice(0, 7) })]);
    expect(viaExec.json().result.url).toBe(`https://lanes.example.com/local/${id}?commit=${head.slice(0, 7)}&compare=${head}`);
  });

  it("open registers the companion with the server and adds a claim code until it is paired; GitHub inputs map to /github", async () => {
    const server = lanes.url();
    const id = repoIdFor(installId, realpathSync(fx.repo));
    const r = await cli(["open", fx.repo, "--branch", "develop", "--app-origin", server, "--no-browser", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = r.json();
    expect(out.url).toBe(`${server}/local/${id}?branch=develop&focus-branch=develop#claim=claim-code-1`);
    expect(out.paired).toBe(false);
    expect(lanes.state.registrations).toBe(1);
    // The agent credentials are stored (0600) and never printed.
    const cfg = readConfig(configDir);
    expect(cfg.server).toEqual({ url: server, agentId: "companion-test", token: lanes.state.token });
    if (process.platform !== "win32") expect(statSync(join(configDir, "companion.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(configDir, "companion.json"), "utf8")).toContain(lanes.state.token);
    expect(r.stdout + r.stderr).not.toContain(lanes.state.token);
    // Once the account claimed the code, open links straight to the repository.
    lanes.state.paired = true;
    const again = await cli(["open", fx.repo, "--app-origin", server, "--no-browser", "--json"]);
    expect(again.json()).toMatchObject({ url: `${server}/local/${id}`, paired: true, key: `local:${id}` });
    expect(lanes.state.registrations).toBe(1);
    // An unreachable server is a warning, not a failure.
    const down = await cli(["open", fx.repo, "--app-origin", "http://127.0.0.1:1", "--no-browser", "--json"]);
    expect(down.code, down.stderr).toBe(0);
    expect(down.json().url).toBe(`http://127.0.0.1:1/local/${id}`);
    expect(down.stderr).toContain("warning: could not pair");
    const gh = await cli(["open", "https://github.com/octo/repo/commit/abcdef1234", "--no-browser"]);
    expect(gh.stdout.trim()).toBe("https://lanes.example.com/github/octo/repo?commit=abcdef1234");
    const ghShort = await cli(["open", "octo/repo", "--provider", "github", "--branch", "dev", "--no-browser"]);
    expect(ghShort.stdout.trim()).toBe("https://lanes.example.com/github/octo/repo?branch=dev&focus-branch=dev");
  });

  it("compare, pair, run and events", async () => {
    const cmp = await cli(["compare", "main", "develop", "src/main.ts", "--repo", fx.repo, "--no-pair", "--no-browser"]);
    expect(cmp.code, cmp.stderr).toBe(0);
    expect(cmp.stdout.trim()).toMatch(/^https:\/\/lanes\.example\.com\/local\/[\w-]{16}\?commit=[0-9a-f]{40}&compare=[0-9a-f]{40}&file=src\/main\.ts$/);
    const local = await cli(["pair", "--local", "--json"]);
    expect(local.json().code).toMatch(/^[A-Z2-9]{10}$/);
    // `pair` with an existing registration asks for a fresh code (no new registration).
    const regs = lanes.state.registrations;
    const pair = await cli(["pair", "--server", lanes.url(), "--no-browser", "--json"]);
    expect(pair.code, pair.stderr).toBe(0);
    expect(pair.json()).toMatchObject({ server: lanes.url(), agentId: "companion-test", registered: false, pairUrl: expect.stringContaining("#claim=claim-code-") });
    expect(pair.stdout).not.toContain(lanes.state.token);
    expect(lanes.state.registrations).toBe(regs);
    // Without a server registration for that URL it registers.
    const human = await cli(["pair", "--server", `${lanes.url()}/`, "--no-browser"]);
    expect(human.stdout).toContain("#claim=claim-code-");
    const run = await cli(["run", "--repo", fx.repo, "--", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(run.code).toBe(0);
    const runFail = await cli(["run", "--repo", fx.repo, "--", "rev-parse", "--verify", "-q", "nope"]);
    expect(runFail.code).toBe(1);
    const ev = cli(["events", "--repo", fx.repo, "--max-events", "2", "--timeout", "8000"]);
    await new Promise((r) => setTimeout(r, 700));
    execFileSync("git", ["update-ref", "refs/heads/events-test", "HEAD"], { cwd: fx.repo });
    const evr = await ev;
    const lines = evr.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].event.type).toBe("sync.ok");
    expect(lines.map((l: { event: { type: string } }) => l.event.type)).toContain("refs.changed");
  });
});
