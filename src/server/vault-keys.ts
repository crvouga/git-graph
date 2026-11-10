// Secrets the server reads, and where they live in Vault (https://vault.chrisvouga.dev).
//
// All personal apps share the KV document `secret/personal/<dev|prd>`, so Lanes' keys carry a
// `LANES_` prefix. In production the platform copies them into the container under the plain
// runtime name (an inventory `vault_key` alias); locally `personal infra-vault run` injects them
// under the prefixed name. The server accepts either (see config.ts).
//
// scripts/check-vault.ts verifies these keys exist in Vault (CI runs it on every change).

export interface VaultKey {
  /** Name the server reads at runtime. */
  env: string;
  /** Key in `secret/personal/<config>`. */
  vault: string;
  /** Deploys fail without it. */
  required: boolean;
  /** Returns a problem with the value (never the value itself), or null. */
  check?: (value: string) => string | null;
  purpose: string;
}

export const VAULT_KEYS: readonly VaultKey[] = [
  {
    env: "SESSION_SECRET",
    vault: "LANES_SESSION_SECRET",
    required: true,
    check: (v) => (Buffer.byteLength(v) >= 32 ? null : "must be at least 32 bytes (openssl rand -base64 48)"),
    purpose: "Encrypts the session cookie. Generate with `openssl rand -base64 48`; keep it stable.",
  },
  {
    env: "GITHUB_CLIENT_ID",
    vault: "LANES_GITHUB_CLIENT_ID",
    required: true,
    check: (v) => (/^((Iv|Ov)[0-9A-Za-z.]+|[0-9a-f]{20})$/.test(v.trim()) ? null : "does not look like a GitHub client ID (Iv…)"),
    purpose: "Lanes GitHub App → Client ID.",
  },
  {
    env: "GITHUB_CLIENT_SECRET",
    vault: "LANES_GITHUB_CLIENT_SECRET",
    required: true,
    check: (v) => (v.trim().length >= 20 ? null : "too short for a GitHub client secret"),
    purpose: "Lanes GitHub App → Generate a new client secret.",
  },
  {
    env: "GITHUB_WEBHOOK_SECRET",
    vault: "LANES_GITHUB_WEBHOOK_SECRET",
    required: true,
    check: (v) => (Buffer.byteLength(v) >= 20 ? null : "must be at least 20 bytes (openssl rand -hex 32)"),
    purpose: "Lanes GitHub App → webhook secret (`openssl rand -hex 32`).",
  },
  {
    env: "TOKEN_ENCRYPTION_KEY",
    vault: "LANES_TOKEN_ENCRYPTION_KEY",
    required: true,
    check: (v) => (Buffer.byteLength(v) >= 32 ? null : "must be at least 32 bytes (openssl rand -base64 48)"),
    purpose: "Encrypts linked GitHub tokens in PostgreSQL. Generate with `openssl rand -base64 48`; keep it stable (rotating disconnects every GitHub link).",
  },
  {
    env: "DATABASE_URL",
    vault: "DATABASE_URL",
    required: true,
    check: (v) => (/^postgres(ql)?:\/\//.test(v) ? null : "is not a postgres:// URL"),
    purpose: "Shared PostgreSQL connection URL (already in Vault); Lanes uses only its allocated schema.",
  },
  {
    env: "GITHUB_PUBLIC_TOKEN",
    vault: "LANES_GITHUB_PUBLIC_TOKEN",
    required: false,
    purpose: "Optional. Fine-grained token with no repository access; raises the anonymous rate limit for public repositories.",
  },
];

/** Fill each runtime name from its `LANES_` Vault name when only the latter is set. */
export function withVaultAliases(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of VAULT_KEYS) if (!out[k.env] && out[k.vault]) out[k.env] = out[k.vault];
  return out;
}
