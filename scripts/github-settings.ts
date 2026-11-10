// Applies .github/repo-settings.json to GitHub, or reports drift from it.
//
//   node scripts/github-settings.ts           apply (idempotent)
//   node scripts/github-settings.ts --plan    print differences, exit 0
//   node scripts/github-settings.ts --check   print differences, exit 1 if any
//
// Uses the `gh` CLI for auth (GH_TOKEN in CI). Needs admin rights on the repository.
// Settings not named in the file are left alone, except rulesets: any repository ruleset
// not in the file is deleted on apply, so the file is the complete list.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Drift = { path: string; want: Json | undefined; have: Json | undefined };

const configPath = fileURLToPath(new URL('../.github/repo-settings.json', import.meta.url));
const config = JSON.parse(readFileSync(configPath, 'utf8')) as JsonObject;
const repo = config.repository as string;
const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--plan') ? 'plan' : 'apply';

class NotFound extends Error {}

function gh(method: string, path: string, body?: Json): Json {
  const args = ['api', '-X', method, '-H', 'Accept: application/vnd.github+json', path];
  if (body !== undefined) args.push('--input', '-');
  try {
    const out = execFileSync('gh', args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim() ? (JSON.parse(out) as Json) : null;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    if (stderr.includes('HTTP 404')) throw new NotFound(`${method} ${path}`);
    throw new Error(`gh api ${method} ${path} failed:\n${stderr}`);
  }
}

function sortKey(value: Json): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as JsonObject;
    return String(v.type ?? v.context ?? v.actor_id ?? v.name ?? JSON.stringify(v));
  }
  return JSON.stringify(value);
}

// Differences between `want` and the part of `have` that `want` names. Extra keys GitHub
// returns (ids, links, defaults) are ignored; arrays must match element for element.
function diff(want: Json | undefined, have: Json | undefined, path: string): Drift[] {
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || have.length !== want.length) return [{ path, want, have }];
    const w = [...want].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const h = [...have].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return w.flatMap((item, i) => diff(item, h[i], `${path}[${sortKey(item)}]`));
  }
  if (want && typeof want === 'object') {
    if (!have || typeof have !== 'object' || Array.isArray(have)) return [{ path, want, have }];
    return Object.entries(want)
      .filter(([key]) => key !== '$comment')
      .flatMap(([key, value]) => diff(value, (have as JsonObject)[key], `${path}.${key}`));
  }
  return want === have ? [] : [{ path, want, have }];
}

const drift: Drift[] = [];
const fixes: Array<() => void> = [];

function plan(found: Drift[], fix: () => void): void {
  if (found.length === 0) return;
  drift.push(...found);
  fixes.push(fix);
}

// Repository settings
const settings = config.settings as JsonObject;
plan(diff(settings, gh('GET', `repos/${repo}`), 'settings'), () => gh('PATCH', `repos/${repo}`, settings));

// Actions workflow token permissions
const workflowPermissions = config.actions_workflow_permissions as JsonObject;
plan(
  diff(workflowPermissions, gh('GET', `repos/${repo}/actions/permissions/workflow`), 'actions_workflow_permissions'),
  () => gh('PUT', `repos/${repo}/actions/permissions/workflow`, workflowPermissions),
);

// Dependabot alerts and security updates (alerts must be on before security updates)
const alertsWanted = config.vulnerability_alerts as boolean;
let alertsOn = true;
try {
  gh('GET', `repos/${repo}/vulnerability-alerts`);
} catch (error) {
  if (!(error instanceof NotFound)) throw error;
  alertsOn = false;
}
plan(diff(alertsWanted, alertsOn, 'vulnerability_alerts'), () =>
  gh(alertsWanted ? 'PUT' : 'DELETE', `repos/${repo}/vulnerability-alerts`),
);
const fixesWanted = config.automated_security_fixes as boolean;
const fixesOn = (gh('GET', `repos/${repo}/automated-security-fixes`) as JsonObject).enabled as boolean;
plan(diff(fixesWanted, fixesOn, 'automated_security_fixes'), () =>
  gh(fixesWanted ? 'PUT' : 'DELETE', `repos/${repo}/automated-security-fixes`),
);

// Rulesets, matched by name
const wantedRulesets = config.rulesets as JsonObject[];
const existing = (gh('GET', `repos/${repo}/rulesets?includes_parents=false`) as JsonObject[]).filter(
  (r) => r.source_type === 'Repository',
);
for (const ruleset of wantedRulesets) {
  const match = existing.find((r) => r.name === ruleset.name);
  if (!match) {
    plan([{ path: `rulesets.${ruleset.name}`, want: 'present', have: 'missing' }], () =>
      gh('POST', `repos/${repo}/rulesets`, ruleset),
    );
    continue;
  }
  const actual = gh('GET', `repos/${repo}/rulesets/${match.id}`);
  plan(diff(ruleset, actual, `rulesets.${ruleset.name}`), () =>
    gh('PUT', `repos/${repo}/rulesets/${match.id}`, ruleset),
  );
}
for (const extra of existing.filter((r) => !wantedRulesets.some((w) => w.name === r.name))) {
  plan([{ path: `rulesets.${extra.name}`, want: 'absent', have: 'present' }], () =>
    gh('DELETE', `repos/${repo}/rulesets/${extra.id}`),
  );
}

// Report and act
if (drift.length === 0) {
  console.log(`${repo}: GitHub settings match .github/repo-settings.json`);
  process.exit(0);
}
console.log(`${repo}: ${drift.length} difference(s) from .github/repo-settings.json`);
for (const d of drift) console.log(`  ${d.path}: ${JSON.stringify(d.have)} -> ${JSON.stringify(d.want)}`);

if (mode === 'check') process.exit(1);
if (mode === 'plan') process.exit(0);

for (const fix of fixes) fix();
console.log('Applied.');
