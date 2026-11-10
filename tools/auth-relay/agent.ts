// Vendored, unmodified below this header, from crvouga/personal
// packages/auth-relay/agent.ts @ e2bee6f9dca49585b1ab9a3b09ee0949e7268297 (reviewed).
// Runs with Bun; kept outside tsconfig. Usage: see tools/auth-relay/README.md.
/** Standalone Bun client. Safe to copy into another repository; no workspace imports. */
import { createHash } from 'node:crypto';
import { stdout } from 'node:process';

type Client = {
  id: string;
  revision: number;
  config: Input | null;
  desired: Input;
};
type Input = {
  name: string;
  project: string;
  environment: string;
  instance: string;
  callbacks: string[];
  expiresAt: string;
};
type Listing = {
  issuer: string;
  grant?: { expiresAt: string };
  clients: Client[];
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function credential(args: string[]): string {
  const key = option(args, '--token-env') ?? 'AUTH_RELAY_AGENT_TOKEN';
  const token = process.env[key];
  if (!token || !/^[A-Za-z0-9_-]{43,256}$/.test(token))
    throw new Error(
      'Missing or invalid agent credential. Inject the named field with personal infra-vault run; never pass its value as an argument.'
    );
  return token;
}

function origin(args: string[]): string {
  const value = option(args, '--origin');
  if (!value)
    throw new Error(
      '--origin is required (select the production or nonproduction relay).'
    );
  const url = new URL(value);
  const local =
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.protocol === 'http:';
  if (url.origin !== value || (url.protocol !== 'https:' && !local))
    throw new Error(
      'Use an exact HTTPS relay origin (HTTP is allowed only for loopback fixtures).'
    );
  return value;
}

async function api(
  base: string,
  token: string,
  path: string,
  init: RequestInit = {}
) {
  let response: Response;
  try {
    response = await fetch(`${base}/agent/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      credentials: 'omit',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      'Relay request failed or timed out. Re-run list to reconcile before retrying; the write may have succeeded.'
    );
  }
  if (!response.ok)
    throw new Error(
      `Relay HTTP ${response.status}. Check the grant, callback scope, expiry and current revision; no request was retried.`
    );
  return response.json();
}

export async function runAgent(args: string[]): Promise<unknown> {
  const [command] = args;
  if (!command || command === '--help') return help;
  if (!['fingerprint', 'list', 'register', 'revoke'].includes(command))
    throw new Error('Unknown command; run --help.');
  const token = credential(args);
  if (command === 'fingerprint')
    return createHash('sha256').update(token).digest('hex');
  const base = origin(args);
  if (command === 'revoke') {
    return revoke(args, base, token);
  }
  const listing = (await api(base, token, '/clients')) as Listing;
  if (command === 'list') return listing;
  return register(args, { base, token, listing });
}

async function revoke(args: string[], base: string, token: string) {
  const id = option(args, '--id');
  if (!id || !/^app-[a-f0-9-]{36}$/.test(id))
    throw new Error('--id must be an application client ID.');
  await api(base, token, `/clients/${id}`, { method: 'DELETE' });
  return { id, revoked: true };
}

async function register(
  args: string[],
  { base, token, listing }: { base: string; token: string; listing: Listing }
) {
  const file = option(args, '--file');
  if (!file)
    throw new Error(
      '--file is required (public registration JSON, no secrets).'
    );
  const input = (await Bun.file(file).json()) as Input;
  registrationOverrides(input, args, listing);
  const existing = listing.clients.find((client) => {
    const config = client.config ?? client.desired;
    return (
      config.project === input.project &&
      config.environment === input.environment &&
      config.instance === input.instance
    );
  });
  const id = existing?.id ?? `app-${crypto.randomUUID()}`;
  const saved = (await api(base, token, `/clients/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...input, revision: existing?.revision ?? 0 }),
  })) as { revision: number };
  // Public settings only; the registration credential is never an application setting.
  return {
    id,
    revision: saved.revision,
    settings: {
      OIDC_ISSUER: listing.issuer,
      OIDC_CLIENT_ID: id,
      OIDC_REDIRECT_URI: input.callbacks[0],
      OIDC_SCOPES: 'openid email profile',
    },
  };
}

function registrationOverrides(
  input: Input,
  args: string[],
  listing: Listing
): void {
  const callback = option(args, '--callback');
  if (callback) input.callbacks = [callback];
  const ttl = option(args, '--ttl-seconds');
  if (ttl || !input.expiresAt) {
    const seconds = leaseSeconds(ttl);
    const grantExpiry = Date.parse(listing.grant?.expiresAt ?? '');
    if (!Number.isFinite(grantExpiry))
      throw new Error('Relay grant expiry missing.');
    input.expiresAt = new Date(
      Math.min(Date.now() + seconds * 1000, grantExpiry)
    ).toISOString();
  }
}

function leaseSeconds(value: string | undefined): number {
  const seconds = Number(value ?? 3600);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 366 * 86400)
    throw new Error(
      '--ttl-seconds must be a positive integer, at most 366 days.'
    );
  return seconds;
}

const help = `Auth relay agent client (Bun; no dependencies)
  fingerprint [--token-env FIELD]              Print only the nonsecret SHA-256
  list --origin URL [--token-env FIELD]         Read this grant and its clients
  register --origin URL --file registration.json [--token-env FIELD]
           [--callback URL] [--ttl-seconds N]
  revoke --origin URL --id app-UUID [--token-env FIELD]
Credentials: inject AUTH_RELAY_AGENT_TOKEN (or FIELD) using personal infra-vault run.
Register reconciles project/environment/instance, retains the client ID and uses
the current revision. No write or one-time code is automatically retried.
Without expiresAt, register requests one hour, capped at the approved grant expiry.
--callback supplies the actual bound callback; --ttl-seconds overrides expiresAt.
Guide: https://www.chrisvouga.dev/llms-cloud.txt#5-auth-relay-google-sign-in`;

if (import.meta.main) {
  try {
    const result = await runAgent(process.argv.slice(2));
    stdout.write(
      `${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`
    );
  } catch (error) {
    // Do not dump request objects, environment, server bodies or raw error causes.
    console.error(
      error instanceof Error ? error.message : 'Agent operation failed'
    );
    process.exitCode = 1;
  }
}
