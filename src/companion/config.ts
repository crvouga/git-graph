// Companion configuration: bearer token, port, install id, the hosted-server agent credentials and
// the id -> worktree path registry.
// Stored in $LANES_CONFIG_DIR/companion.json (default ~/.config/lanes, honoring XDG_CONFIG_HOME),
// directory mode 0700, file mode 0600, written atomically (temp file + rename).

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 7420;
export const DEFAULT_APP_ORIGIN = "http://localhost:8787";
export const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8787", "http://127.0.0.1:8787"];

export interface RepoEntry {
  path: string;
  commonDir?: string;
  name?: string;
  lastOpenedAt: number;
}

/** This companion's registration with a hosted Lanes server (a Zero source agent). */
export interface ServerAgent {
  /** App origin of the server (Zero sync is at `${url}/zero`). */
  url: string;
  agentId: string;
  /** Agent token (secret; only ever sent to `url`). */
  token: string;
}

export interface CompanionConfig {
  version: 1;
  token: string;
  /** Random per-install id; mixed into repository ids so they are unique across machines. */
  installId: string;
  port?: number;
  server?: ServerAgent;
  repos: Record<string, RepoEntry>;
  /** Most recent first. */
  recent: string[];
}

export function configDir(): string {
  if (process.env.LANES_CONFIG_DIR) return process.env.LANES_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "lanes");
}

export function configPath(dir = configDir()): string {
  return join(dir, "companion.json");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newInstallId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Stable repository id, unique across installs: first 16 chars of
 * base64url(sha256(installId + "\0" + realpath(toplevel))).
 */
export function repoIdFor(installId: string, realToplevel: string): string {
  return createHash("sha256").update(installId).update("\0").update(realToplevel).digest("base64url").slice(0, 16);
}

function fresh(): CompanionConfig {
  return { version: 1, token: newToken(), installId: newInstallId(), repos: {}, recent: [] };
}

function parseServer(v: unknown): ServerAgent | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== "string" || typeof o.agentId !== "string" || typeof o.token !== "string") return undefined;
  if (!o.url || !o.agentId || !o.token) return undefined;
  return { url: o.url.replace(/\/+$/, ""), agentId: o.agentId, token: o.token };
}

/** Configs from before install ids: re-key the remembered repositories with the new install id. */
function migrateIds(c: CompanionConfig) {
  const map = new Map<string, string>();
  const repos: Record<string, RepoEntry> = {};
  for (const [old, e] of Object.entries(c.repos)) {
    if (!e || typeof e.path !== "string") continue;
    const id = repoIdFor(c.installId, e.path);
    map.set(old, id);
    repos[id] = e;
  }
  c.repos = repos;
  c.recent = c.recent.flatMap((x) => (map.has(x) ? [map.get(x)!] : []));
}

export function readConfig(dir = configDir()): CompanionConfig {
  const p = configPath(dir);
  if (!existsSync(p)) {
    const c = fresh();
    writeConfig(c, dir);
    return c;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<CompanionConfig>;
    const c: CompanionConfig = {
      version: 1,
      token: typeof raw.token === "string" && raw.token.length >= 32 ? raw.token : newToken(),
      installId: typeof raw.installId === "string" && raw.installId.length >= 16 ? raw.installId : newInstallId(),
      ...(typeof raw.port === "number" ? { port: raw.port } : {}),
      repos: raw.repos && typeof raw.repos === "object" ? raw.repos : {},
      recent: Array.isArray(raw.recent) ? raw.recent.filter((x): x is string => typeof x === "string") : [],
    };
    if (c.installId !== raw.installId) migrateIds(c);
    const server = parseServer(raw.server);
    if (server) c.server = server;
    if (c.token !== raw.token || c.installId !== raw.installId) writeConfig(c, dir);
    return c;
  } catch {
    // Corrupt file: start over rather than crash (repos can be re-opened).
    const c = fresh();
    writeConfig(c, dir);
    return c;
  }
}

export function writeConfig(c: CompanionConfig, dir = configDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = configPath(dir);
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* not supported on this filesystem */
  }
  renameSync(tmp, p);
}

/** Read-modify-write with the freshest file content (other processes may write too). */
export function updateConfig(fn: (c: CompanionConfig) => void, dir = configDir()): CompanionConfig {
  const c = readConfig(dir);
  fn(c);
  writeConfig(c, dir);
  return c;
}

export function rememberRepo(id: string, entry: Omit<RepoEntry, "lastOpenedAt">, dir = configDir()): CompanionConfig {
  return updateConfig((c) => {
    c.repos[id] = { ...entry, lastOpenedAt: Date.now() };
    c.recent = [id, ...c.recent.filter((x) => x !== id)].slice(0, 50);
  }, dir);
}
