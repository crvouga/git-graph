// Server-side sessions. The browser only holds an opaque random id in an HttpOnly cookie; GitHub
// tokens live here and never leave the server. The store is in memory with optional encrypted file
// persistence (AES-256-GCM, key derived from SESSION_SECRET) keyed by a hash of the cookie value,
// so a leaked file yields neither cookies nor (without the secret) tokens.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenIdentity } from "../github/client.ts";

export interface SessionUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubTokens {
  accessToken: string;
  /** Unix ms; null for non-expiring OAuth App tokens. */
  accessTokenExpiresAt: number | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
}

export interface PendingLogin {
  state: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
}

export interface Session {
  /** sha256(cookie value), never the cookie value itself. */
  key: string;
  createdAt: number;
  lastSeenAt: number;
  user: SessionUser | null;
  github: GitHubTokens | null;
  pending: PendingLogin | null;
}

export interface SessionStoreOptions {
  secret: string;
  dataDir: string | null;
  idleTtlMs: number;
  absoluteTtlMs: number;
  now?: () => number;
}

const hashId = (v: string) => createHash("sha256").update(v).digest("hex");

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly opts: SessionStoreOptions;
  private readonly key: Buffer;
  private readonly now: () => number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SessionStoreOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.key = Buffer.from(hkdfSync("sha256", opts.secret, "lanes-session-store", "aes-256-gcm", 32));
    this.load();
  }

  private get file(): string | null {
    return this.opts.dataDir ? join(this.opts.dataDir, "sessions.enc") : null;
  }

  /** Create a new session; returns the cookie value (shown to the browser once). */
  create(): { cookie: string; session: Session } {
    const cookie = randomBytes(32).toString("base64url");
    const t = this.now();
    const session: Session = { key: hashId(cookie), createdAt: t, lastSeenAt: t, user: null, github: null, pending: null };
    this.sessions.set(session.key, session);
    this.sweep();
    return { cookie, session };
  }

  get(cookie: string | undefined | null): Session | null {
    if (!cookie || cookie.length > 200) return null;
    const s = this.sessions.get(hashId(cookie));
    if (!s) return null;
    const t = this.now();
    if (t - s.lastSeenAt > this.opts.idleTtlMs || t - s.createdAt > this.opts.absoluteTtlMs) {
      this.destroy(s);
      return null;
    }
    s.lastSeenAt = t;
    return s;
  }

  /** New id for an existing session (on login: prevents session fixation). */
  rotate(s: Session): string {
    this.sessions.delete(s.key);
    const cookie = randomBytes(32).toString("base64url");
    s.key = hashId(cookie);
    this.sessions.set(s.key, s);
    this.changed();
    return cookie;
  }

  destroy(s: Session): void {
    this.sessions.delete(s.key);
    s.user = null;
    s.github = null;
    s.pending = null;
    this.changed();
  }

  /** Sessions whose GitHub token has this identity. */
  findByTokenId(tid: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.github && tokenIdentity(s.github.accessToken) === tid);
  }

  findByUserId(id: number): Session[] {
    return [...this.sessions.values()].filter((s) => s.user?.id === id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Mark the store dirty; persists (debounced) when a data dir is configured. */
  changed(): void {
    if (!this.file || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 250);
    this.persistTimer.unref?.();
  }

  private sweep() {
    if (this.sessions.size % 64 !== 0) return;
    const t = this.now();
    for (const s of this.sessions.values()) {
      if (t - s.lastSeenAt > this.opts.idleTtlMs || t - s.createdAt > this.opts.absoluteTtlMs) this.sessions.delete(s.key);
      else if (!s.user && t - s.lastSeenAt > 3600_000) this.sessions.delete(s.key); // stale pre-login sessions
    }
  }

  persist(): void {
    const file = this.file;
    if (!file) return;
    try {
      // Only signed-in sessions survive restarts; pre-login state is short-lived by design.
      const data = JSON.stringify([...this.sessions.values()].filter((s) => s.user).map((s) => ({ ...s, pending: null })));
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", this.key, iv);
      const enc = Buffer.concat([c.update(data, "utf8"), c.final()]);
      mkdirSync(this.opts.dataDir!, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "session persist failed", error: e instanceof Error ? e.message : String(e) }));
    }
  }

  private load(): void {
    const file = this.file;
    if (!file) return;
    try {
      const buf = readFileSync(file);
      const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      const json = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
      const t = this.now();
      for (const s of JSON.parse(json) as Session[]) {
        if (t - s.lastSeenAt <= this.opts.idleTtlMs && t - s.createdAt <= this.opts.absoluteTtlMs) this.sessions.set(s.key, s);
      }
    } catch {
      /* missing file, or secret rotated: start empty */
    }
  }

  close(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persist();
    }
  }
}
