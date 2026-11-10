// Companion configuration: bearer token, port, and the id -> worktree path registry.
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

export interface CompanionConfig {
  version: 1;
  token: string;
  port?: number;
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

/** Stable repository id: first 16 chars of base64url(sha256(realpath(toplevel))). */
export function repoIdFor(realToplevel: string): string {
  return createHash("sha256").update(realToplevel).digest("base64url").slice(0, 16);
}

function fresh(): CompanionConfig {
  return { version: 1, token: newToken(), repos: {}, recent: [] };
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
      ...(typeof raw.port === "number" ? { port: raw.port } : {}),
      repos: raw.repos && typeof raw.repos === "object" ? raw.repos : {},
      recent: Array.isArray(raw.recent) ? raw.recent.filter((x): x is string => typeof x === "string") : [],
    };
    if (c.token !== raw.token) writeConfig(c, dir);
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
