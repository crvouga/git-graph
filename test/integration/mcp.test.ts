// MCP server over stdio via the official SDK client.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT, makeBasic, type BasicFixture } from "../fixtures/make-fixtures.ts";
import { repoIdFor } from "../../src/companion/config.ts";

const CLI = resolve(import.meta.dirname, "../../src/cli/main.ts");

function text(r: unknown): any {
  const c = (r as { content: { type: string; text: string }[] }).content[0]!;
  return JSON.parse(c.text);
}

describe("MCP server (stdio)", () => {
  let root: string;
  let fx: BasicFixture;
  let client: Client;
  let key: string;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lanes-mcp-")));
    const cfg = join(root, "user.gitconfig");
    writeFileSync(cfg, "[user]\n\tname = M\n\temail = m@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
    if (!existsSync(join(ROOT, ".gitconfig"))) {
      mkdirSync(ROOT, { recursive: true });
      writeFileSync(join(ROOT, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
    }
    process.env.GIT_CONFIG_GLOBAL = cfg;
    fx = makeBasic(root);
    key = `local:${repoIdFor(realpathSync(fx.repo))}`;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1", LANES_CONFIG_DIR: join(root, "cfg"), LANES_APP_ORIGIN: "https://lanes.example.com", LANES_SERVER_URL: "" });
    client = new Client({ name: "lanes-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" }));
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists every registry command as a tool, plus events/sync tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["repo_refs", "repo_history", "link_build", "local_open", "git_reset", "git_cherry-pick", "events_wait", "sync_status", "refresh"]));
    const reset = tools.find((t) => t.name === "git_reset")!;
    expect(reset.description).toContain("DESTRUCTIVE");
    expect(reset.inputSchema.properties).toHaveProperty("confirm");
    expect(reset.inputSchema.type).toBe("object");
  });

  it("calls repo_refs (by path and by key) and link_build", async () => {
    const opened = text(await client.callTool({ name: "local_open", arguments: { path: fx.repo } }));
    expect(opened.key).toBe(key);
    const refs = text(await client.callTool({ name: "repo_refs", arguments: { repo: key } }));
    expect(refs.refs.find((r: { short: string }) => r.short === "main").ahead).toBe(1);
    const byPath = text(await client.callTool({ name: "repo_refs", arguments: { repo: fx.repo } }));
    expect(byPath.version).toBe(refs.version);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fx.repo, encoding: "utf8" }).trim();
    const link = text(await client.callTool({ name: "link_build", arguments: { repo: key, commit: head, branches: ["main"] } }));
    expect(link.url).toBe(`https://lanes.example.com/local/${key.slice(6)}?branch=main&commit=${head}`);
  });

  it("destructive tools return the consequence + token; resend with confirm", async () => {
    execFileSync("git", ["branch", "mcp-doomed", "HEAD"], { cwd: fx.repo });
    const first = await client.callTool({ name: "git_branch_delete", arguments: { repo: key, name: "mcp-doomed" } });
    expect(first.isError).toBe(true);
    const err = text(first).error;
    expect(err.code).toBe("CONFIRMATION_REQUIRED");
    expect(execFileSync("git", ["branch", "--list", "mcp-doomed"], { cwd: fx.repo, encoding: "utf8" }).trim()).toBe("mcp-doomed");
    const second = await client.callTool({ name: "git_branch_delete", arguments: { repo: key, name: "mcp-doomed", confirm: err.details.confirmToken } });
    expect(second.isError).toBeFalsy();
    expect(execFileSync("git", ["branch", "--list", "mcp-doomed"], { cwd: fx.repo, encoding: "utf8" }).trim()).toBe("");
  });

  it("events_wait long-polls external changes with resumable cursors; sync_status; refresh", async () => {
    const first = text(await client.callTool({ name: "events_wait", arguments: { repo: key, timeoutMs: 200 } }));
    expect(first.events).toEqual([]);
    expect(typeof first.cursor).toBe("string");
    const pending = client.callTool({ name: "events_wait", arguments: { repo: key, cursor: first.cursor, timeoutMs: 8000 } });
    await new Promise((r) => setTimeout(r, 300));
    execFileSync("git", ["update-ref", "refs/heads/mcp-event", "HEAD"], { cwd: fx.repo });
    const got = text(await pending);
    expect(got.events.map((e: { event: { type: string } }) => e.event.type)).toContain("refs.changed");
    // a change between calls is not lost (the watcher lingers between long-polls)
    execFileSync("git", ["update-ref", "-d", "refs/heads/mcp-event"], { cwd: fx.repo });
    await new Promise((r) => setTimeout(r, 400));
    const next = text(await client.callTool({ name: "events_wait", arguments: { repo: key, cursor: got.cursor, timeoutMs: 3000 } }));
    expect(next.events.map((e: { event: { type: string } }) => e.event.type)).toContain("refs.changed");
    // a cursor from another epoch yields resync
    const stale = text(await client.callTool({ name: "events_wait", arguments: { repo: key, cursor: "otherepoch:5", timeoutMs: 100 } }));
    expect(stale.events[0].event.type).toBe("resync");
    const ss = text(await client.callTool({ name: "sync_status", arguments: { repo: key } }));
    expect(ss).toMatchObject({ repositoryId: key, connection: "live", refsVersion: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const rf = text(await client.callTool({ name: "refresh", arguments: { repo: key } }));
    expect(rf.refsVersion).toBe(ss.refsVersion);
  });

  it("GitHub keys are UNSUPPORTED without LANES_SERVER_URL", async () => {
    const r = await client.callTool({ name: "repo_refs", arguments: { repo: "github:octo:repo" } });
    expect(r.isError).toBe(true);
    expect(text(r).error.code).toBe("UNSUPPORTED");
  });
});
