// Per-request repository resolver for the hosted server: only GitHub repositories, opened with the
// caller's own token (or anonymously / with the public-repo token for signed-out callers).

import { AppError, parseRepoKey, repoKey, type RepoInfo } from "../core/types.ts";
import type { RepositoryResolver } from "../core/port.ts";
import type { EventHub } from "../core/sync/hub.ts";
import { GitHubAdapter, PublicityCache, type GhRepo } from "../github/adapter.ts";
import type { GitHubClient } from "../github/client.ts";
import type { HistoryStateCache } from "../github/history.ts";

export const LOCAL_ON_SERVER_REASON = "Local repositories are served by the git-graph CLI companion, not the hosted server";

export interface GitHubEnv {
  api: GitHubClient;
  hub: EventHub;
  historyCache: HistoryStateCache;
  publicity: PublicityCache;
  /** Server token used (only for verified-public repositories) when the caller is signed out. */
  publicToken: string | null;
  onMutated: (key: string) => void;
}

/** Adapter for `key` acting as a signed-in user (token) or anonymously (token = null). */
export function makeAdapter(env: GitHubEnv, owner: string, name: string, token: string | null, opts: { infoFreshMs?: number } = {}): GitHubAdapter {
  const anonymous = !token;
  return new GitHubAdapter({
    owner,
    name,
    api: env.api,
    token: anonymous ? env.publicToken : token,
    requirePublic: anonymous && !!env.publicToken,
    publicity: env.publicity,
    hub: env.hub,
    historyCache: env.historyCache,
    onMutated: env.onMutated,
    infoFreshMs: opts.infoFreshMs,
  });
}

export function parseGitHubKey(key: string): { owner: string; name: string } {
  const ref = parseRepoKey(key);
  if (!ref) throw new AppError("BAD_REQUEST", `Invalid repository key "${key}"`);
  if (ref.provider !== "github") throw new AppError("UNSUPPORTED", LOCAL_ON_SERVER_REASON, { provider: ref.provider });
  return { owner: ref.owner, name: ref.name };
}

function toInfo(r: GhRepo): RepoInfo {
  const ref = { provider: "github" as const, owner: r.owner.login, name: r.name };
  const p = r.permissions;
  return {
    ref,
    key: repoKey(ref),
    name: r.full_name,
    description: r.description ?? undefined,
    defaultBranch: r.default_branch,
    visibility: r.visibility ?? (r.private ? "private" : "public"),
    permission: p ? (p.admin ? "admin" : p.maintain ? "maintain" : p.push ? "write" : p.triage ? "triage" : p.pull ? "read" : "none") : undefined,
    htmlUrl: r.html_url,
  };
}

export class GitHubResolver implements RepositoryResolver {
  private readonly env: GitHubEnv;
  private readonly getToken: () => Promise<string | null>;
  private readonly adapters = new Map<string, GitHubAdapter>();
  private readonly infoFreshMs?: number;

  constructor(env: GitHubEnv, getToken: () => Promise<string | null>, opts: { infoFreshMs?: number } = {}) {
    this.env = env;
    this.getToken = getToken;
    this.infoFreshMs = opts.infoFreshMs;
  }

  async resolve(key: string): Promise<GitHubAdapter> {
    const { owner, name } = parseGitHubKey(key);
    const k = repoKey({ provider: "github", owner, name });
    let a = this.adapters.get(k);
    if (!a) {
      a = makeAdapter(this.env, owner, name, await this.getToken(), { infoFreshMs: this.infoFreshMs });
      this.adapters.set(k, a);
    }
    return a;
  }

  /** Signed-in: repositories the user can access (owned, collaborator, org). Signed-out: empty. */
  async list(opts: { query?: string; limit?: number } = {}): Promise<RepoInfo[]> {
    const token = await this.getToken();
    if (!token) return [];
    const limit = Math.max(1, Math.min(100, opts.limit ?? 30));
    const q = opts.query?.trim().toLowerCase() ?? "";
    const repos = await this.env.api.get<GhRepo[]>("/user/repos", {
      token,
      query: { sort: "updated", per_page: q ? 100 : limit, affiliation: "owner,collaborator,organization_member" },
      freshMs: 30_000,
    });
    const out = new Map<string, RepoInfo>();
    for (const r of repos) {
      if (q && !r.full_name.toLowerCase().includes(q)) continue;
      out.set(r.full_name.toLowerCase(), toInfo(r));
    }
    if (q && out.size < limit) {
      try {
        const s = await this.env.api.get<{ items: GhRepo[] }>("/search/repositories", {
          token,
          query: { q: `${q} in:name`, per_page: Math.min(50, limit) },
          freshMs: 30_000,
        });
        for (const r of s.items ?? []) if (!out.has(r.full_name.toLowerCase())) out.set(r.full_name.toLowerCase(), toInfo(r));
      } catch (e) {
        if (AppError.from(e).code !== "BAD_REQUEST" && AppError.from(e).code !== "RATE_LIMITED") throw e;
      }
    }
    return [...out.values()].slice(0, limit);
  }
}
