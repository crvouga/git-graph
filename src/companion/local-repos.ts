// Resolves "local:<id>" keys to CliGitAdapters (one per worktree), registering opened paths in the
// companion config. GitHub keys are delegated to an optional fallback resolver (hosted server).

import { basename } from "node:path";
import { AppError, parseRepoKey, type RepoInfo } from "../core/types.ts";
import type { RepositoryPort, RepositoryResolver } from "../core/port.ts";
import { CliGitAdapter, locateRepository, type AdapterHooks } from "./git-adapter.ts";
import { configDir, readConfig, rememberRepo, repoIdFor } from "./config.ts";

export interface LocalReposOptions {
  configDir?: string;
  /** Builds per-adapter hooks (events / watcher). */
  hooks?: (key: string) => AdapterHooks;
  /** Resolver for non-local keys (e.g. HttpResolver to a hosted server). */
  fallback?: RepositoryResolver;
}

export class LocalRepos implements RepositoryResolver {
  private readonly adapters = new Map<string, Promise<CliGitAdapter>>();
  private readonly opts: LocalReposOptions;
  readonly dir: string;

  constructor(opts: LocalReposOptions = {}) {
    this.opts = opts;
    this.dir = opts.configDir ?? configDir();
  }

  /** Register a path (any directory inside a worktree) and return its RepoInfo. */
  async open(path: string): Promise<RepoInfo> {
    const loc = await locateRepository(path);
    const id = repoIdFor(loc.toplevel);
    rememberRepo(id, { path: loc.toplevel, commonDir: loc.commonDir, name: basename(loc.toplevel) }, this.dir);
    const key = `local:${id}`;
    if (!this.adapters.has(key)) this.adapters.set(key, Promise.resolve(new CliGitAdapter(id, loc, this.opts.hooks?.(key))));
    return (await this.adapters.get(key)!).info();
  }

  async resolve(key: string): Promise<RepositoryPort> {
    const ref = parseRepoKey(key);
    if (!ref) throw new AppError("BAD_REQUEST", `Invalid repository key "${key}"`);
    if (ref.provider !== "local") {
      if (this.opts.fallback) return this.opts.fallback.resolve(key);
      throw new AppError("UNSUPPORTED", `${ref.provider} repositories are not served by the local companion. Set LANES_SERVER_URL to forward them to a hosted Lanes server.`);
    }
    return this.local(key);
  }

  /** The CliGitAdapter for a local key (throws NOT_FOUND for unknown ids). */
  local(key: string): Promise<CliGitAdapter> {
    let p = this.adapters.get(key);
    if (!p) {
      p = (async () => {
        const id = key.slice("local:".length);
        const entry = readConfig(this.dir).repos[id];
        if (!entry) throw new AppError("NOT_FOUND", `Unknown local repository "${key}". Open it first (git-graph open <path>).`);
        const loc = await locateRepository(entry.path).catch((e) => {
          throw new AppError("NOT_FOUND", `Repository "${key}" at ${entry.path} is unavailable: ${AppError.from(e).message}`);
        });
        return new CliGitAdapter(id, loc, this.opts.hooks?.(key));
      })();
      this.adapters.set(key, p);
      p.catch(() => this.adapters.delete(key));
    }
    return p;
  }

  async list(opts?: { query?: string; limit?: number }): Promise<RepoInfo[]> {
    const c = readConfig(this.dir);
    const q = opts?.query?.toLowerCase();
    const out: RepoInfo[] = [];
    for (const id of c.recent) {
      const e = c.repos[id];
      if (!e) continue;
      const name = e.name ?? basename(e.path);
      if (q && !name.toLowerCase().includes(q) && !e.path.toLowerCase().includes(q)) continue;
      out.push({ ref: { provider: "local", id }, key: `local:${id}`, name, visibility: "local", worktreePath: e.path, ...(e.commonDir ? { commonDir: e.commonDir } : {}) });
      if (out.length >= (opts?.limit ?? 50)) break;
    }
    return out;
  }

  /** Adapters that are currently instantiated. */
  async loaded(): Promise<CliGitAdapter[]> {
    const all = await Promise.allSettled([...this.adapters.values()]);
    return all.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }

  dispose() {
    for (const p of this.adapters.values()) void p.then((a) => a.dispose(), () => {});
    this.adapters.clear();
  }
}
