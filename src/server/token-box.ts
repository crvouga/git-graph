// Encryption at rest for GitHub tokens stored in PostgreSQL: AES-256-GCM with a key derived from
// TOKEN_ENCRYPTION_KEY (Vault LANES_TOKEN_ENCRYPTION_KEY). Each ciphertext is bound to its row and
// field (associated data), so a value copied into another account or column fails to decrypt.
// A database dump alone yields no usable token.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

export class TokenBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error("TOKEN_ENCRYPTION_KEY must be at least 32 bytes");
    this.key = Buffer.from(hkdfSync("sha256", secret, "lanes-token-box", "aes-256-gcm", 32));
  }

  seal(plain: string, context: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(`${VERSION}:${context}`));
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `${VERSION}.${Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url")}`;
  }

  /** Throws when the value was tampered with, moved, or sealed with another key. */
  open(sealed: string, context: string): string {
    if (!sealed.startsWith(`${VERSION}.`)) throw new Error("unknown token encoding");
    const buf = Buffer.from(sealed.slice(VERSION.length + 1), "base64url");
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    d.setAAD(Buffer.from(`${VERSION}:${context}`));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  }
}
