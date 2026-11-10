// A fake auth relay (OpenID Connect provider) for tests: discovery, JWKS, authorization endpoint
// and token endpoint with S256 PKCE, single-use codes and RS256-signed ID tokens. `authorizingSubject`
// plays the person who completes the Google sign-in; `tamper` produces bad ID tokens.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Tamper = null | "nonce" | "audience" | "issuer" | "signature" | "expired";

interface Code {
  sub: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | null;
  used: boolean;
}

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");

export class FakeRelay {
  readonly clientId = "app-11111111-2222-4333-8444-555555555555";
  readonly redirectUris = new Set<string>();
  authorizingSubject: string | null = null;
  tamper: Tamper = null;
  readonly codes = new Map<string, Code>();
  readonly people = new Map<string, { email: string; name: string }>();
  tokenRequests = 0;
  private readonly kid = "test-key-1";
  private readonly key: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private readonly otherKey: KeyObject;
  private server: Server | null = null;
  url = "";

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.key = privateKey;
    this.jwk = { ...publicKey.export({ format: "jwk" }), kid: this.kid, alg: "RS256", use: "sig" };
    this.otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  }

  get issuer(): string {
    return `${this.url}/realms/test`;
  }

  person(sub: string) {
    return this.people.get(sub) ?? { email: `${sub}@example.com`, name: sub[0]!.toUpperCase() + sub.slice(1) };
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req.method ?? "GET", new URL(req.url ?? "/", "http://x"), req).then(({ status, headers, body }) => {
        res.writeHead(status, headers);
        res.end(body);
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close() {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private json(status: number, v: unknown) {
    return { status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(v) };
  }

  private idToken(c: Code): string {
    const t = Math.floor(Date.now() / 1000);
    const p = this.person(c.sub);
    const claims: Record<string, unknown> = {
      iss: this.tamper === "issuer" ? `${this.issuer}-evil` : this.issuer,
      sub: c.sub,
      aud: this.tamper === "audience" ? "someone-else" : c.clientId,
      azp: c.clientId,
      iat: t,
      exp: this.tamper === "expired" ? t - 600 : t + 300,
      email: p.email,
      email_verified: true,
      name: p.name,
    };
    if (c.nonce !== null) claims.nonce = this.tamper === "nonce" ? "wrong-nonce" : c.nonce;
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: this.kid }));
    const body = b64(JSON.stringify(claims));
    const sig = sign("sha256", Buffer.from(`${head}.${body}`), this.tamper === "signature" ? this.otherKey : this.key);
    return `${head}.${body}.${b64(sig)}`;
  }

  private async handle(method: string, url: URL, req: NodeJS.ReadableStream): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const base = "/realms/test";
    if (url.pathname === `${base}/.well-known/openid-configuration`) {
      return this.json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${this.issuer}/protocol/openid-connect/token`,
        jwks_uri: `${this.issuer}/protocol/openid-connect/certs`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === `${base}/protocol/openid-connect/certs`) return this.json(200, { keys: [this.jwk] });
    if (url.pathname === `${base}/protocol/openid-connect/auth`) {
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri") ?? "";
      if (q.get("client_id") !== this.clientId) return this.json(400, { error: "unauthorized_client" });
      if (!this.redirectUris.has(redirectUri)) return this.json(400, { error: "invalid_redirect_uri" });
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return this.json(400, { error: "invalid_request" });
      if (!this.authorizingSubject) return this.json(403, { error: "nobody signed in" });
      const code = randomBytes(16).toString("hex");
      this.codes.set(code, { sub: this.authorizingSubject, clientId: this.clientId, redirectUri, challenge: q.get("code_challenge")!, nonce: q.get("nonce"), used: false });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      if (q.get("state")) back.searchParams.set("state", q.get("state")!);
      return { status: 302, headers: { location: back.toString() }, body: "" };
    }
    if (url.pathname === `${base}/protocol/openid-connect/token` && method === "POST") {
      this.tokenRequests++;
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const f = new URLSearchParams(raw);
      const c = this.codes.get(f.get("code") ?? "");
      if (f.get("grant_type") !== "authorization_code" || !c || c.used) return this.json(400, { error: "invalid_grant" });
      c.used = true;
      if (f.get("client_id") !== c.clientId || f.get("redirect_uri") !== c.redirectUri) return this.json(400, { error: "invalid_grant" });
      if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return this.json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return this.json(200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, scope: "openid email profile", id_token: this.idToken(c) });
    }
    return this.json(404, { error: "not found" });
  }
}
