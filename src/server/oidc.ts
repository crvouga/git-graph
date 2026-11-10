// Sign-in through the shared auth relay (https://auth.chrisvouga.dev): OpenID Connect
// authorization code flow for a public client — S256 PKCE, random state and nonce, no client
// secret. ID tokens are validated (signature against the relay's JWKS, exact issuer, audience,
// nonce, expiry) by openid-client. Callers identify people by (iss, sub) only.

import * as client from "openid-client";
import { AppError } from "../core/types.ts";
import type { OidcIdentity } from "./accounts.ts";

export interface OidcOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  /** Skip the provider choice on the relay (e.g. "google"); empty for none. */
  idpHint: string;
  fetch?: typeof fetch;
}

export interface OidcTransaction {
  state: string;
  nonce: string;
  verifier: string;
}

const loopback = (u: URL) => u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);

export class Oidc {
  private readonly o: OidcOptions;
  private config: Promise<client.Configuration> | null = null;

  constructor(o: OidcOptions) {
    this.o = o;
  }

  /** Discovery, cached; retried on the next call after a failure. */
  private discover(): Promise<client.Configuration> {
    if (!this.config) {
      const issuer = new URL(this.o.issuer);
      const options: client.DiscoveryRequestOptions = { timeout: 10 };
      // Plain http only for a loopback issuer (tests and local relays), never in production.
      if (loopback(issuer)) options.execute = [client.allowInsecureRequests];
      if (this.o.fetch) options[client.customFetch] = this.o.fetch as client.CustomFetch;
      this.config = client
        .discovery(issuer, this.o.clientId, { token_endpoint_auth_method: "none" }, client.None(), options)
        .then((c) => {
          client.enableNonRepudiationChecks(c); // verify ID token signatures, not just TLS
          return c;
        })
        .catch((e) => {
          this.config = null;
          throw new AppError("UPSTREAM_ERROR", `The sign-in service is unavailable (${e instanceof Error ? e.message : String(e)})`);
        });
    }
    return this.config;
  }

  async start(): Promise<{ url: string; tx: OidcTransaction }> {
    const config = await this.discover();
    const tx: OidcTransaction = { state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier() };
    const params: Record<string, string> = {
      redirect_uri: this.o.redirectUri,
      scope: this.o.scopes,
      state: tx.state,
      nonce: tx.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(tx.verifier),
      code_challenge_method: "S256",
    };
    if (this.o.idpHint) params.kc_idp_hint = this.o.idpHint;
    return { url: client.buildAuthorizationUrl(config, params).href, tx };
  }

  /** Exchange the code once (never retried) and return the verified identity. */
  async finish(callbackUrl: URL, tx: OidcTransaction): Promise<OidcIdentity> {
    const config = await this.discover();
    // The redirect URI must match the registered one exactly, whatever host the proxy saw.
    const current = new URL(this.o.redirectUri);
    current.search = callbackUrl.search;
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, current, { pkceCodeVerifier: tx.verifier, expectedState: tx.state, expectedNonce: tx.nonce, idTokenExpected: true });
    } catch (e) {
      throw new AppError("UNAUTHENTICATED", `Sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const c = tokens.claims();
    if (!c?.sub || !c.iss) throw new AppError("UNAUTHENTICATED", "Sign-in failed: the ID token has no subject");
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return { issuer: c.iss, subject: c.sub, email: str(c.email), name: str(c.name) ?? str(c.preferred_username), picture: str(c.picture) };
  }
}
