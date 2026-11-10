import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/server/session.ts";

const opts = { secret: "s".repeat(48), idleTtlMs: 3600_000, absoluteTtlMs: 24 * 3600_000 };

describe("SessionStore (sealed cookies)", () => {
  it("round-trips a session through the cookie and rejects tampering", () => {
    const store = new SessionStore(opts);
    const s = store.create();
    s.user = { id: 1, login: "alice", name: null, avatarUrl: null };
    const cookie = store.seal(s);
    expect(cookie).not.toContain("alice");
    expect(new SessionStore(opts).open(cookie)?.session.user?.login).toBe("alice");
    expect(new SessionStore(opts).open(cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA"))).toBeNull();
    expect(new SessionStore({ ...opts, secret: "x".repeat(48) }).open(cookie)).toBeNull();
  });

  it("a change made without writing a cookie wins over the older cookie", () => {
    const store = new SessionStore(opts);
    const s = store.create();
    s.github = { accessToken: "old", accessTokenExpiresAt: null, refreshToken: "r1", refreshTokenExpiresAt: null };
    const cookie = store.seal(s);
    // e.g. a refresh during an event stream: the refresh token rotated, no response to carry it
    s.github = { accessToken: "new", accessTokenExpiresAt: null, refreshToken: "r2", refreshTokenExpiresAt: null };
    store.changed(s);
    const v = store.open(cookie)!;
    expect(v.session.github?.refreshToken).toBe("r2");
    expect(v.cookieRev).toBeLessThan(v.session.rev); // so the response re-issues the cookie
  });

  it("ended and revoked sessions stop opening", () => {
    const store = new SessionStore(opts);
    const s = store.create();
    const a = store.seal(s);
    store.destroy(s);
    expect(store.open(a)).toBeNull();

    let t = 1000;
    const timed = new SessionStore({ ...opts, now: () => t });
    const u = timed.create();
    u.user = { id: 7, login: "bob", name: null, avatarUrl: null };
    u.signedInAt = t;
    const b = timed.seal(u);
    t += 10;
    timed.revokeUser(7);
    expect(timed.open(b)).toBeNull();
  });
});
