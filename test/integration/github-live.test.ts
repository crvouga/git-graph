// Optional read-only smoke test against the real GitHub API (public repository, anonymous).
// Skipped unless LANES_LIVE_GITHUB=1. Never mutates anything and never uses a token.
import { describe, expect, it } from "vitest";
import { GitHubAdapter } from "../../src/github/adapter.ts";
import { GitHubClient } from "../../src/github/client.ts";
import { DEFAULT_HISTORY_QUERY } from "../../src/core/types.ts";

const live = process.env.LANES_LIVE_GITHUB === "1";

describe.skipIf(!live)("live GitHub (read-only, anonymous)", () => {
  it("reads refs and a topologically ordered history page of a public repo", async () => {
    const api = new GitHubClient();
    const a = new GitHubAdapter({ owner: process.env.LANES_LIVE_OWNER ?? "octocat", name: process.env.LANES_LIVE_REPO ?? "Hello-World", api, token: null, branchCap: 3 });
    const info = await a.info();
    expect(info.visibility).toBe("public");
    const refs = await a.refs();
    expect(refs.head.kind).toBe("branch");
    const page = await a.history(DEFAULT_HISTORY_QUERY, null, 30);
    expect(page.commits.length).toBeGreaterThan(0);
    const idx = new Map(page.commits.map((c, i) => [c.hash, i]));
    for (const [i, c] of page.commits.entries()) for (const p of c.parents) if (idx.has(p)) expect(idx.get(p)!).toBeGreaterThan(i);
    console.log(`[live] ${info.name}: ${refs.refs.length} refs, ${page.commits.length} commits, rate budget ${JSON.stringify(api.budget(null))}`);
  }, 60_000);
});
