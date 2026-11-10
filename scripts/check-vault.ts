// Verify that every secret Lanes needs exists in Vault and looks right. Prints key names and
// problems only, never values.
//
//   node scripts/check-vault.ts [--config prd] [--config dev]     (default: both)
//
// Token: VAULT_TOKEN, else ~/.vault-token (`vault login`). CI mints one with GitHub OIDC.
// Exit 0 when every required key is present and valid, 1 otherwise, 2 when Vault is unreachable.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { VAULT_KEYS } from "../src/server/vault-keys.ts";

const { values } = parseArgs({ options: { config: { type: "string", multiple: true } } });
const configs = values.config?.length ? values.config : ["prd", "dev"];
const addr = (process.env.VAULT_ADDR || "https://vault.chrisvouga.dev").replace(/\/+$/, "");
const project = process.env.VAULT_PROJECT || "personal";

function token(): string {
  if (process.env.VAULT_TOKEN) return process.env.VAULT_TOKEN.trim();
  try {
    return readFileSync(join(homedir(), ".vault-token"), "utf8").trim();
  } catch {
    console.error("No Vault token: set VAULT_TOKEN or run `vault login --method=userpass username=crvouga`.");
    process.exit(2);
  }
}

/** Vault restarts sealed and auto-unseals: retry 503/429 with back-off before giving up. */
async function read(config: string, tok: string): Promise<Record<string, string>> {
  const url = `${addr}/v1/secret/data/${project}/${config}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "X-Vault-Token": tok }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return ((await res.json()) as { data: { data: Record<string, string> } }).data.data;
    if ((res.status === 503 || res.status === 429) && attempt < 8) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || Math.min(30_000, 1000 * 2 ** attempt);
      console.error(`Vault answered ${res.status} for secret/${project}/${config}; retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    console.error(`Vault answered HTTP ${res.status} for secret/${project}/${config}`);
    process.exit(2);
  }
}

const tok = token();
let failed = false;
for (const config of configs) {
  const data = await read(config, tok);
  console.log(`secret/${project}/${config}`);
  for (const k of VAULT_KEYS) {
    const v = data[k.vault];
    const problem = v === undefined || v === "" ? "missing" : (k.check?.(v) ?? null);
    const mark = problem === null ? "ok" : k.required ? "FAIL" : "skip";
    if (problem !== null && k.required) failed = true;
    console.log(`  ${mark.padEnd(4)} ${k.vault.padEnd(28)} → ${k.env}${problem ? `: ${problem}` : ""}${!k.required && problem ? " (optional)" : ""}`);
  }
}
if (failed) {
  console.log(`\nMissing or invalid keys. Request them with a "[secrets] lanes — …" issue on crvouga/personal (names only, never values); see docs/deploy.md.`);
  process.exit(1);
}
