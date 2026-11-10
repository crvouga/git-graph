import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/server/session.ts";

const opts = { secret: "s".repeat(48), idleTtlMs: 3600_000, absoluteTtlMs: 24 * 3600_000 };

describe("SessionStore (sealed cookies)", () => {
  it("round-trips a session through the cookie and rejects tampering", () => {
    const store = new SessionStore(opts);
    const s = store.create();
    s.accountId = "acct-alice";
    const cookie = store.seal(s);
    expect(cookie).not.toContain("alice");
    expect(new SessionStore(opts).open(cookie)?.session.accountId).toBe("acct-alice");
    expect(new SessionStore(opts).open(cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA"))).toBeNull();
    expect(new SessionStore({ ...opts, secret: "x".repeat(48) }).open(cookie)).toBeNull();
  });

  it("a change made without writing a cookie wins over the older cookie (consumed state stays consumed)", () => {
    const store = new SessionStore(opts);
    const s = store.create();
    s.pending = [{ kind: "login", state: "st", verifier: "v", nonce: "n", returnTo: "/", createdAt: Date.now() }];
    const cookie = store.seal(s);
    s.pending = [];
    store.changed(s);
    const v = store.open(cookie)!;
    expect(v.session.pending).toEqual([]);
    expect(v.cookieRev).toBeLessThan(v.session.rev); // so the response re-issues the cookie
  });

  it("ended sessions stop opening", () => {
    const store = new SessionStore(opts);
    const s = store.create();
    const a = store.seal(s);
    store.destroy(s);
    expect(store.open(a)).toBeNull();
  });
});
