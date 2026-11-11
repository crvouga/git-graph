import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig, repoIdFor, updateConfig } from "../../src/companion/config.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lanes-cfg-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("repoIdFor", () => {
  it("is stable, 16 base64url chars, and depends on the install and the path", () => {
    const id = repoIdFor("install-a-0123456789", "/home/u/src/app");
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(repoIdFor("install-a-0123456789", "/home/u/src/app")).toBe(id);
    expect(repoIdFor("install-b-0123456789", "/home/u/src/app")).not.toBe(id);
    expect(repoIdFor("install-a-0123456789", "/home/u/src/app2")).not.toBe(id);
  });

  it("does not collide across many installs with the same path", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(repoIdFor(`install-${i}`, "/home/user/project"));
    expect(ids.size).toBe(2000);
  });

  it("separates the install id from the path (no concatenation ambiguity)", () => {
    expect(repoIdFor("ab", "c/d")).not.toBe(repoIdFor("a", "bc/d"));
  });
});

describe("companion config", () => {
  it("creates a random install id once and keeps it", () => {
    const a = tmp();
    const b = tmp();
    const ia = readConfig(a).installId;
    expect(ia.length).toBeGreaterThanOrEqual(16);
    expect(readConfig(a).installId).toBe(ia);
    expect(readConfig(b).installId).not.toBe(ia);
  });

  it("stores the server agent (0600) and drops malformed entries", () => {
    const d = tmp();
    updateConfig((c) => {
      c.server = { url: "https://lanes.example.com", agentId: "companion-x", token: "secret-token" };
    }, d);
    expect(readConfig(d).server).toEqual({ url: "https://lanes.example.com", agentId: "companion-x", token: "secret-token" });
    if (process.platform !== "win32") expect(statSync(join(d, "companion.json")).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(join(d, "companion.json"), "utf8"));
    writeFileSync(join(d, "companion.json"), JSON.stringify({ ...raw, server: { url: "https://x", agentId: 5 } }));
    expect(readConfig(d).server).toBeUndefined();
  });

  it("re-keys repositories remembered before install ids existed", () => {
    const d = tmp();
    writeFileSync(
      join(d, "companion.json"),
      JSON.stringify({ version: 1, token: "t".repeat(43), repos: { oldid: { path: "/src/app", lastOpenedAt: 1 } }, recent: ["oldid", "gone"] }),
    );
    const c = readConfig(d);
    const id = repoIdFor(c.installId, "/src/app");
    expect(Object.keys(c.repos)).toEqual([id]);
    expect(c.recent).toEqual([id]);
    expect(readConfig(d)).toEqual(c);
  });
});
