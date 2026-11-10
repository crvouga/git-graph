// Companion HTTP security: auth, Origin allowlist, Host (DNS rebinding), pairing, CORS preflight.

import { request } from "node:http";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompanion, type Companion } from "../../src/companion/server.ts";
import { configPath } from "../../src/companion/config.ts";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

function req(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: () => JSON.parse(text) });
        });
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

const APP = "http://localhost:5173";

describe("companion HTTP security", () => {
  let root: string;
  let companion: Companion;
  let port: number;
  let close: () => Promise<void>;
  let clock = 1_000_000;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lanes-http-")));
    writeFileSync(join(root, "user.gitconfig"), "[user]\n\tname = T\n\temail = t@example.com\n");
    process.env.GIT_CONFIG_GLOBAL = join(root, "user.gitconfig");
    companion = createCompanion({ configDir: join(root, "cfg"), allowedOrigins: ["https://lanes.example.com"], now: () => clock, pairRateLimit: { max: 5, windowMs: 60_000 } });
    const l = await companion.listen(0);
    port = l.port;
    close = l.close;
    token = companion.token();
  });
  afterAll(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stores a 32-byte token in a 0600 config file", () => {
    expect(Buffer.from(token, "base64url").length).toBe(32);
    if (process.platform !== "win32") expect(statSync(configPath(join(root, "cfg"))).mode & 0o777).toBe(0o600);
  });

  it("health is public and leaks no secrets", async () => {
    const r = await req(port, "GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ name: "lanes-companion", version: expect.any(String), gitVersion: expect.stringMatching(/^\d+\.\d+/) });
    expect(r.body).not.toContain(token);
  });

  it("requires the bearer token everywhere else (401)", async () => {
    expect((await req(port, "GET", "/api/v1/commands")).status).toBe(401);
    expect((await req(port, "GET", "/api/v1/repositories", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await req(port, "POST", "/api/v1/commands/execute", {}, { command: "git.git.run", args: { args: ["status"] } })).status).toBe(401);
    expect((await req(port, "POST", "/pair/code")).status).toBe(401);
    const ok = await req(port, "GET", "/api/v1/commands", auth());
    expect(ok.status).toBe(200);
    expect(ok.json().commands.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(["repo.refs", "local.open", "local.clone", "local.init", "git.git.run"]));
  });

  it("rejects disallowed Origins (403) and echoes allowed ones without wildcard", async () => {
    const bad = await req(port, "GET", "/api/v1/commands", { ...auth(), origin: "https://evil.example" });
    expect(bad.status).toBe(403);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const badHealth = await req(port, "GET", "/health", { origin: "null" });
    expect(badHealth.status).toBe(403);
    const good = await req(port, "GET", "/api/v1/commands", { ...auth(), origin: "https://lanes.example.com" });
    expect(good.status).toBe(200);
    expect(good.headers["access-control-allow-origin"]).toBe("https://lanes.example.com");
    expect(good.headers.vary).toContain("Origin");
  });

  it("rejects foreign Host headers (DNS rebinding) with 403", async () => {
    expect((await req(port, "GET", "/health", { host: "evil.example" })).status).toBe(403);
    expect((await req(port, "GET", "/health", { host: `attacker.localhost.evil:${port}` })).status).toBe(403);
    expect((await req(port, "GET", "/api/v1/commands", { ...auth(), host: "evil.example" })).status).toBe(403);
    expect((await req(port, "GET", "/health", { host: `localhost:${port}` })).status).toBe(200);
  });

  it("answers CORS preflight including Private Network Access", async () => {
    const r = await req(port, "OPTIONS", "/api/v1/repositories", {
      origin: APP,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
      "access-control-request-private-network": "true",
    });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(APP);
    expect(r.headers["access-control-allow-private-network"]).toBe("true");
    expect(String(r.headers["access-control-allow-headers"])).toContain("authorization");
    const bad = await req(port, "OPTIONS", "/api/v1/repositories", { origin: "https://evil.example", "access-control-request-private-network": "true" });
    expect(bad.status).toBe(403);
    expect(bad.headers["access-control-allow-private-network"]).toBeUndefined();
  });

  it("pairing codes are single use, expire after 120s, and need an allowed Origin", async () => {
    const mk = async () => (await req(port, "POST", "/pair/code", auth())).json().code as string;
    const code = await mk();
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    expect((await req(port, "POST", "/pair", {}, { code })).status).toBe(403); // no Origin
    const ok = await req(port, "POST", "/pair", { origin: APP }, { code });
    expect(ok.status).toBe(200);
    expect(ok.json().token).toBe(token);
    expect(ok.headers["access-control-allow-origin"]).toBe(APP);
    expect((await req(port, "POST", "/pair", { origin: APP }, { code })).status).toBe(401); // reused
    const late = await mk();
    clock += 121_000;
    expect((await req(port, "POST", "/pair", { origin: APP }, { code: late })).status).toBe(401); // expired
    const bad = await req(port, "POST", "/pair", { origin: "https://evil.example" }, { code: await mk() });
    expect(bad.status).toBe(403);
  });

  it("rate-limits /pair", async () => {
    clock += 120_000; // fresh window
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await req(port, "POST", "/pair", { origin: APP }, { code: "WRONGWRONG" })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("destructive git.run needs a confirmation token over HTTP too", async () => {
    const dir = join(root, "repo");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", dir]);
    const open = await req(port, "POST", "/api/v1/commands/execute", auth(), { command: "local.open", args: { path: dir } });
    expect(open.status).toBe(200);
    const key = open.json().result.key as string;
    expect(key).toMatch(/^local:[A-Za-z0-9_-]{16}$/);
    const first = await req(port, "POST", "/api/v1/commands/execute", auth(), { command: "git.git.run", args: { repo: key, args: ["status"] } });
    expect(first.status).toBe(428);
    const t = first.json().error.details.confirmToken;
    const second = await req(port, "POST", "/api/v1/commands/execute", auth(), { command: "git.git.run", args: { repo: key, args: ["status"] }, confirm: t });
    expect(second.status).toBe(200);
    expect(second.json().result.exitCode).toBe(0);
    // stable ids: same path -> same key; repo.list returns it with paths
    const again = await req(port, "POST", "/api/v1/commands/execute", auth(), { command: "local.open", args: { path: join(dir, ".") } });
    expect(again.json().result.key).toBe(key);
    const list = await req(port, "GET", "/api/v1/repositories", auth());
    expect(list.json()[0]).toMatchObject({ key, worktreePath: realpathSync(dir) });
  });
});
