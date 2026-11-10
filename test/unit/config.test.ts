import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.ts";

const prod = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://lanes.chrisvouga.dev",
  SESSION_SECRET: "s".repeat(48),
  GITHUB_CLIENT_ID: "Iv23liExample",
  GITHUB_CLIENT_SECRET: "c".repeat(40),
  GITHUB_WEBHOOK_SECRET: "w".repeat(64),
  OIDC_ISSUER: "https://auth.chrisvouga.dev/realms/projects",
  OIDC_CLIENT_ID: "app-00000000-0000-4000-8000-000000000000",
  DATABASE_URL: "postgres://user@db.example/app",
  TOKEN_ENCRYPTION_KEY: "k".repeat(48),
};

describe("loadConfig", () => {
  it("accepts the LANES_-prefixed Vault key names", () => {
    const c = loadConfig({
      NODE_ENV: "production",
      APP_ORIGIN: prod.APP_ORIGIN,
      OIDC_ISSUER: prod.OIDC_ISSUER,
      OIDC_CLIENT_ID: prod.OIDC_CLIENT_ID,
      DATABASE_URL: prod.DATABASE_URL,
      LANES_TOKEN_ENCRYPTION_KEY: prod.TOKEN_ENCRYPTION_KEY,
      LANES_SESSION_SECRET: prod.SESSION_SECRET,
      LANES_GITHUB_CLIENT_ID: prod.GITHUB_CLIENT_ID,
      LANES_GITHUB_CLIENT_SECRET: prod.GITHUB_CLIENT_SECRET,
      LANES_GITHUB_WEBHOOK_SECRET: prod.GITHUB_WEBHOOK_SECRET,
    });
    expect(c.sessionSecret).toBe(prod.SESSION_SECRET);
    expect(c.githubClientId).toBe(prod.GITHUB_CLIENT_ID);
    expect(c.webhookSecret).toBe(prod.GITHUB_WEBHOOK_SECRET);
    expect(c.tokenEncryptionKey).toBe(prod.TOKEN_ENCRYPTION_KEY);
    expect(c.oidc).toEqual({ issuer: prod.OIDC_ISSUER, clientId: prod.OIDC_CLIENT_ID, redirectUri: `${prod.APP_ORIGIN}/auth/callback`, scopes: "openid email profile", idpHint: "google" });
  });

  it("sign-in settings come as a group", () => {
    const { DATABASE_URL: _, ...noDb } = prod;
    expect(() => loadConfig({ ...noDb, ALLOW_ANONYMOUS_ONLY: "1" })).toThrow("DATABASE_URL");
    expect(() => loadConfig({ ...prod, TOKEN_ENCRYPTION_KEY: "short" })).toThrow("TOKEN_ENCRYPTION_KEY");
  });

  it("the plain runtime name wins over the Vault name", () => {
    expect(loadConfig({ ...prod, LANES_GITHUB_CLIENT_ID: "Iv23other" }).githubClientId).toBe(prod.GITHUB_CLIENT_ID);
  });

  it("fails fast in production when a release secret is missing, naming it", () => {
    for (const k of ["APP_ORIGIN", "SESSION_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_WEBHOOK_SECRET", "OIDC_ISSUER", "OIDC_CLIENT_ID", "DATABASE_URL", "TOKEN_ENCRYPTION_KEY"] as const) {
      const env: Record<string, string> = { ...prod };
      delete env[k];
      expect(() => loadConfig(env), k).toThrow(k);
    }
  });

  it("ALLOW_ANONYMOUS_ONLY runs production without the GitHub App, but never with half of it", () => {
    const base = { NODE_ENV: "production", APP_ORIGIN: prod.APP_ORIGIN, SESSION_SECRET: prod.SESSION_SECRET, ALLOW_ANONYMOUS_ONLY: "1" };
    expect(loadConfig(base).githubClientId).toBeNull();
    expect(() => loadConfig({ ...base, GITHUB_CLIENT_ID: prod.GITHUB_CLIENT_ID })).toThrow("GITHUB_CLIENT_SECRET");
  });
});
