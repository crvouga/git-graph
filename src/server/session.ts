// Sessions as sealed cookies. The session lives in the browser as an AES-256-GCM sealed cookie
// (key derived from SESSION_SECRET): who is signed in (an account id) and the in-flight sign-in
// transactions. The browser cannot read or forge it, and no session table is needed. Durable data
// (accounts, linked GitHub tokens) lives in PostgreSQL, never in the cookie.
//
// The server also keeps small in-memory caches, a safety net that is harmless to lose:
//  - the latest copy of recently seen sessions, so a change made where no cookie can be written
//    (or a replayed older cookie) does not resurrect consumed state;
//  - ended session ids (logout) until they would have expired anyway, so an old copy of the
//    cookie stops working in this process.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** One in-flight sign-in (relay login or GitHub connect); single use, ten minutes. */
export interface PendingAuth {
  kind: "login" | "github";
  state: string;
  verifier: string;
  /** OIDC only. */
  nonce: string | null;
  returnTo: string;
  createdAt: number;
}

export interface Session {
  /** Random session id, only ever sent inside the sealed cookie. */
  key: string;
  /** Bumped on every change; the newest copy wins. */
  rev: number;
  createdAt: number;
  lastSeenAt: number;
  signedInAt: number | null;
  /** Signed-in account (accounts.id), or null. */
  accountId: string | null;
  /** Separate entries per tab; oldest dropped first. */
  pending: PendingAuth[];
}

export interface SessionStoreOptions {
  secret: string;
  idleTtlMs: number;
  absoluteTtlMs: number;
  now?: () => number;
  /** Max sessions kept in the in-memory cache. */
  cacheSize?: number;
}

/** What a request's cookie said, to decide whether the response must re-issue it. */
export interface CookieView {
  session: Session;
  cookieKey: string;
  cookieRev: number;
  cookieSeenAt: number;
}

const VERSION = "v1";
const MAX_COOKIE = 4000;

export class SessionStore {
  private readonly opts: SessionStoreOptions;
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly cacheSize: number;
  private readonly recent = new Map<string, Session>();
  /** Session id → when it would have expired anyway. */
  private readonly ended = new Map<string, number>();

  constructor(opts: SessionStoreOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.cacheSize = opts.cacheSize ?? 50_000;
    this.key = Buffer.from(hkdfSync("sha256", opts.secret, "lanes-session-cookie", "aes-256-gcm", 32));
  }

  /** Refresh the cookie at most this often just to slide the idle timeout. */
  get touchMs(): number {
    return Math.min(3600_000, Math.floor(this.opts.idleTtlMs / 10));
  }

  create(): Session {
    const t = this.now();
    const s: Session = { key: randomBytes(18).toString("base64url"), rev: 1, createdAt: t, lastSeenAt: t, signedInAt: null, accountId: null, pending: [] };
    this.remember(s);
    return s;
  }

  /** Decode and validate a cookie. Returns the newest known copy of the session. */
  open(cookie: string | undefined | null): CookieView | null {
    const decoded = this.unseal(cookie);
    if (!decoded) return null;
    const t = this.now();
    const cached = this.recent.get(decoded.key);
    const s = cached && cached.rev >= decoded.rev ? cached : decoded;
    const lastSeen = Math.max(s.lastSeenAt, decoded.lastSeenAt);
    if (t - lastSeen > this.opts.idleTtlMs || t - s.createdAt > this.opts.absoluteTtlMs || this.isEnded(s)) {
      this.recent.delete(s.key);
      return null;
    }
    s.lastSeenAt = t;
    this.remember(s);
    return { session: s, cookieKey: decoded.key, cookieRev: decoded.rev, cookieSeenAt: decoded.lastSeenAt };
  }

  seal(s: Session): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(VERSION));
    const enc = Buffer.concat([c.update(JSON.stringify(s), "utf8"), c.final()]);
    return `${VERSION}.${Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url")}`;
  }

  private unseal(cookie: string | undefined | null): Session | null {
    if (!cookie || cookie.length > MAX_COOKIE || !cookie.startsWith(`${VERSION}.`)) return null;
    try {
      const buf = Buffer.from(cookie.slice(VERSION.length + 1), "base64url");
      if (buf.length < 29) return null;
      const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
      d.setAAD(Buffer.from(VERSION));
      d.setAuthTag(buf.subarray(12, 28));
      const s = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as Session;
      return typeof s?.key === "string" && typeof s.rev === "number" && Array.isArray(s.pending) ? s : null;
    } catch {
      return null; // tampered, or SESSION_SECRET rotated
    }
  }

  /** Record a change; the next response carrying this session re-issues its cookie. */
  changed(s: Session): void {
    s.rev++;
    this.remember(s);
  }

  /** New id for an existing session (on login: prevents session fixation). */
  rotate(s: Session): void {
    this.end(s.key);
    s.key = randomBytes(18).toString("base64url");
    this.changed(s);
  }

  destroy(s: Session): void {
    this.end(s.key);
    s.accountId = null;
    s.pending = [];
    s.rev++;
  }

  isEnded(s: Session): boolean {
    return this.ended.has(s.key);
  }

  private end(key: string) {
    this.recent.delete(key);
    const t = this.now();
    this.ended.set(key, t + this.opts.absoluteTtlMs);
    if (this.ended.size % 256 === 0) for (const [k, until] of this.ended) if (until < t) this.ended.delete(k);
    if (this.ended.size > this.cacheSize) this.ended.delete(this.ended.keys().next().value!);
  }

  private remember(s: Session) {
    this.recent.delete(s.key); // re-insert: Map order is the eviction order
    this.recent.set(s.key, s);
    if (this.recent.size > this.cacheSize) this.recent.delete(this.recent.keys().next().value!);
  }
}
