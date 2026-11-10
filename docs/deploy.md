# Deploying the Lanes server

The hosted server (`src/server/main.ts`, bundled to `dist/server/server.mjs`) serves:

- the web app (static files from `STATIC_DIR`, with SPA fallback),
- sign-in through the shared auth relay (`/auth/login`, `/auth/callback`, `POST /auth/logout`),
- connecting a GitHub account (`/auth/github/connect`, `/auth/github/callback`,
  `POST /auth/github/disconnect`),
- the shared API at `/api/v1` (GitHub repositories only; local repositories are served by the
  `git-graph` CLI companion on the user's machine),
- GitHub webhooks at `POST /webhooks/github`,
- real-time updates over Server-Sent Events (`/api/v1/repositories/:id/events`),
- `GET /health`.

It is a single Node process with no local state: no volume, nothing written to disk. Durable
data lives in the shared PostgreSQL; the container can be replaced at any time.

- **Accounts** (PostgreSQL, schema `lanes`): one row per person, keyed by the auth relay's
  `(issuer, subject)` (never by email), and their connected GitHub account. GitHub user-to-server
  tokens are stored encrypted (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`, bound to their row), refreshed
  by the server, and never sent to the browser. One GitHub account connects to one Lanes account.
- **Sessions** live in the browser as one sealed cookie (AES-256-GCM, key from `SESSION_SECRET`)
  holding the account id and in-flight sign-ins. They survive restarts and redeploys.
- **Everything else is an in-memory cache** that is safe to lose: the event hub, the poller, the
  GitHub response cache, recent webhook delivery ids, recently seen sessions and ended session ids.
  After a restart, clients reconnect and resync; a webhook redelivered across a restart is
  processed again, which is safe because processing is idempotent.

### Sign-in and GitHub

1. **Sign in** with Google through the shared auth relay (`https://auth.chrisvouga.dev`): OpenID
   Connect authorization code flow as a public client (S256 PKCE, single-use state and nonce bound
   to the browser, ten minutes, separate per tab). The ID token's signature, issuer, audience,
   nonce and expiry are verified (`openid-client`).
2. **Connect GitHub**: the GitHub App's OAuth flow links a GitHub account to the signed-in account.
   From then on the person sees their private repositories, with live sync, on any device they
   sign in on. Disconnecting (or revoking the App on GitHub, or GitHub rejecting the token)
   removes the link; the Lanes session stays.

### PostgreSQL

- `DATABASE_URL` (Vault, shared key) is opaque and passed to the driver unchanged; it is never
  logged. Lanes touches only its allocated schema (`DATABASE_SCHEMA`, default `lanes`); the
  schema is allocated by `crvouga/personal`, never created by the app.
- Raw, parameterized SQL (`postgres` driver) over a pool of `DATABASE_POOL_MAX` (5) connections
  with a 30 s statement timeout. Migrations (`src/server/migrations.ts`) are append-only and
  additive; they run at boot (`MIGRATE_ON_BOOT`, default on) under an advisory lock, and with
  `pnpm db:migrate` (`pnpm db:migrate:vault` for dev).
- `/health` never touches the database. If it is down at boot, the server keeps serving public
  repositories and retries migrations with back-off; sign-in answers "unavailable" meanwhile.
- Tests use a disposable PostgreSQL (PGlite) with a fresh schema per test server, never the
  shared dev database.

### Zero sync

The web client reads everything through [Zero](https://zero.rocicorp.dev): PostgreSQL is the
source of truth, zero-cache replicates it to every browser, and the UI renders whatever is in its
local store (no loading states). See [architecture.md](architecture.md#zero-sync).

The server proxies `/zero/*` (HTTP and WebSocket) to zero-cache, so browsers sync with the same
origin and the session cookie. zero-cache calls back `/internal/zero/query` and
`/internal/zero/mutate` with a shared key (`X-Api-Key`). There are two ways to run zero-cache:

- **Embedded (local development, fallback):** the server starts zero-cache as a child process
  (`ZERO_PORT`, default 4848, loopback only) once migrations have run. `ZERO_API_KEY` is random
  per boot when unset, so the server and the child always agree.
- **Sidecar (production):** zero-cache runs as a separate, internal-only service (`lanes-zero`);
  set `ZERO_CACHE_URL` to its private URL and `ZERO_API_KEY` to the same key on both sides (Vault
  `LANES_ZERO_API_KEY`). The server then does not start a child process. The sidecar has no public
  hostname and is only reachable over private networking.

PostgreSQL requirements (both modes):

- `wal_level=logical`; a **direct** (unpooled) connection for `ZERO_UPSTREAM_DB` (defaults to
  `DATABASE_URL`) whose role may replicate (`REPLICATION`) and create event triggers; the
  migration creates the publication `lanes_zero` (needs `CREATE` on the database).
  `ZERO_CVR_DB` / `ZERO_CHANGE_DB` may use a pooler.
- zero-cache keeps its own state in the schemas `lanes_zero`, `lanes_zero_0`, `lanes_zero_0/cdc`
  and `lanes_zero_0/cvr` (from `ZERO_APP_ID`, default `lanes_zero`), unless `ZERO_CVR_DB` /
  `ZERO_CHANGE_DB` move them elsewhere. `DATABASE_SCHEMA` must be a dedicated schema (`lanes`),
  never `public` or a `pg_*` schema; `ZERO_APP_ID` must not equal or collide with it. Both are
  validated at boot.
- The publication's column lists keep tokens and secret hashes in PostgreSQL: they are never
  replicated to zero-cache or browsers.
- zero-cache's SQLite replica (`ZERO_REPLICA_FILE`, `/data/replica.db` in the sidecar,
  `/tmp/lanes-zero/replica.db` embedded) is a cache: losing it costs one initial sync at the next
  start. A volume makes restarts faster.
- Local development: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pass postgres:17 -c wal_level=logical`,
  `psql … -c 'create schema lanes'`, then `DATABASE_URL=postgres://postgres:pass@localhost:5432/postgres pnpm dev:server`.

#### Production sidecar (`lanes-zero`)

The sidecar runs the official image pinned to the same version as `@rocicorp/zero` (1.11.4). It
is internal-only: no custom domain, no Cloudflare record, one replica, no scale-to-zero, and a
`/data` volume for the replica. It calls the Lanes service over Railway private networking.

| Sidecar setting | Value |
| --- | --- |
| Image | `ghcr.io/rocicorp/zero:1.11.4` |
| Port / health | `4848` (`ZERO_PORT`); `GET /keepalive` → 200 (allow ≥ 10 min for the first sync) |
| `ZERO_UPSTREAM_DB` | direct PostgreSQL URL (Vault `ZERO_UPSTREAM_DB`) |
| `ZERO_CVR_DB` / `ZERO_CHANGE_DB` | optional pooled URLs; default to `ZERO_UPSTREAM_DB` |
| `ZERO_APP_ID` / `ZERO_APP_PUBLICATIONS` | `lanes_zero` / `lanes_zero` |
| `ZERO_REPLICA_FILE` | `/data/replica.db` |
| `ZERO_QUERY_URL` | `http://lanes.railway.internal:8787/internal/zero/query` |
| `ZERO_MUTATE_URL` | `http://lanes.railway.internal:8787/internal/zero/mutate` |
| `ZERO_QUERY_API_KEY` / `ZERO_MUTATE_API_KEY` | Vault `LANES_ZERO_API_KEY` |
| `ZERO_QUERY_FORWARD_COOKIES` / `ZERO_MUTATE_FORWARD_COOKIES` | `true` |
| `ZERO_ENABLE_CRUD_MUTATIONS` | `false` |
| `ZERO_ADMIN_PASSWORD` | Vault `LANES_ZERO_ADMIN_PASSWORD` (required in production) |
| `ZERO_LOG_LEVEL` / `ZERO_NUM_SYNC_WORKERS` | `warn` / `1` |

The Lanes service then needs only `ZERO_CACHE_URL=http://lanes-zero.railway.internal:4848` and
`ZERO_API_KEY` (Vault `LANES_ZERO_API_KEY`); it does not need `ZERO_UPSTREAM_DB`.

## Production: `lanes.chrisvouga.dev`

Production follows the shared cloud infrastructure in
[llms-cloud.txt](https://www.chrisvouga.dev/llms-cloud.txt) (§ Hosting). It runs two Railway
services from prebuilt public images: the public `lanes` server and the internal-only
`lanes-zero` sidecar (see [Zero sync](#production-sidecar-lanes-zero)).

1. Every push to `main` runs `.github/workflows/publish.yml`. It calls the shared workflow in
   `crvouga/personal`, which builds the `Dockerfile` for `linux/amd64` and pushes
   `ghcr.io/crvouga/chrisvouga-lanes:<sha>` and `:latest` (public, anonymous pulls).
2. It then asks `crvouga/personal` to deploy that SHA. Railway never builds code.
3. The services, hostname, plain env vars and Vault secrets are declared in `crvouga/personal`'s
   OpenTofu inventory. Request changes with a `[hosting] lanes — …` issue on `crvouga/personal`;
   never change them in the Railway dashboard.

| Setting | Value |
| --- | --- |
| Port | `8787` (`PORT`) |
| Health check | `GET /health` → 200, no auth, no GitHub calls |
| Plain env | `PORT=8787`, `APP_ORIGIN=https://lanes.chrisvouga.dev`, `TRUST_PROXY=1`, `GITHUB_APP_SLUG=<slug>`, `OIDC_ISSUER=https://auth.chrisvouga.dev/realms/projects`, `OIDC_CLIENT_ID=<from relay registration>`, `ZERO_CACHE_URL=http://lanes-zero.railway.internal:4848` |
| Database | schema `lanes` (dev and prd), `DATABASE_URL` from Vault |
| Relay client | `tools/auth-relay/registration.production.json`, registered with `pnpm relay:register:production` (see [tools/auth-relay/README.md](../tools/auth-relay/README.md)) |
| Secrets | from Vault, see below; includes the shared `ZERO_API_KEY` (`LANES_ZERO_API_KEY`) |
| Sidecar | `lanes-zero`: internal-only zero-cache, port `4848`, 1 replica, `/data` volume |
| Replicas | exactly 1 for each service |

### Secrets: Vault (`https://vault.chrisvouga.dev`)

Every secret lives in the shared KV document `secret/personal/<config>` (`prd` for production,
`dev` for local work, same key names in both). Lanes' keys carry a `LANES_` prefix because the
document is shared by all personal apps. The list is defined once in
[`src/server/vault-keys.ts`](../src/server/vault-keys.ts):

| Vault key | Runtime env | Required | Value |
| --- | --- | --- | --- |
| `LANES_SESSION_SECRET` | `SESSION_SECRET` | yes | `openssl rand -base64 48`; keep it stable (rotating signs everyone out) |
| `LANES_GITHUB_CLIENT_ID` | `GITHUB_CLIENT_ID` | yes | GitHub App → Client ID |
| `LANES_GITHUB_CLIENT_SECRET` | `GITHUB_CLIENT_SECRET` | yes | GitHub App → Generate a new client secret |
| `LANES_GITHUB_WEBHOOK_SECRET` | `GITHUB_WEBHOOK_SECRET` | yes | the App's webhook secret (`openssl rand -hex 32`) |
| `LANES_TOKEN_ENCRYPTION_KEY` | `TOKEN_ENCRYPTION_KEY` | yes | `openssl rand -base64 48`; keep it stable (rotating disconnects every GitHub link) |
| `DATABASE_URL` | `DATABASE_URL` | yes | shared key, already in Vault |
| `LANES_GITHUB_PUBLIC_TOKEN` | `GITHUB_PUBLIC_TOKEN` | no | fine-grained token with no repository access |

- **Production:** the service's inventory entry in `crvouga/personal` binds each runtime name to
  its Vault key (`{ "name": "SESSION_SECRET", "source": "vault", "vault_key": "LANES_SESSION_SECRET" }`),
  so they arrive as plain env vars. The server never talks to Vault itself.
- **Local:** `pnpm dev:server:vault` runs the server under `personal infra-vault run` (config from
  `.vault.yaml`), which injects the `LANES_…` names; the server accepts either name.
- **Checked on every change:** the CI job *Vault secrets present* logs in with GitHub OIDC (role
  `github-actions`) and runs `pnpm vault:check`. It prints key names and problems only, and raises
  a warning (with the list in the job summary) when a required key is missing or malformed in
  `prd` or `dev`. It is advisory, not part of **CI ok**: a release missing a secret still never
  goes live, because the server refuses to boot and fails its health check. Run it locally after
  `vault login`.
- **Adding or changing a key:** open a `[secrets] lanes — …` issue on `crvouga/personal` with key
  names only. Vault contents are managed by OpenTofu there; never write them by hand.
- **At boot**, in production the server exits with a message naming any missing `APP_ORIGIN`,
  `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` or `GITHUB_WEBHOOK_SECRET`, so a
  misconfigured release fails its health check instead of going live. `ALLOW_ANONYMOUS_ONLY=1`
  allows a deliberately sign-in-free deployment.

The GitHub App's callback URL is `https://lanes.chrisvouga.dev/auth/github/callback` and its
webhook URL is `https://lanes.chrisvouga.dev/webhooks/github`. The relay client's callback is
`https://lanes.chrisvouga.dev/auth/callback`.

Redeploy a given commit (a human, from a machine with access to `crvouga/personal`):
`gh workflow run deploy.yml -R crvouga/personal -f action=deploy -f service_id=lanes -f image_tag=<sha>`.

## 1. Create the GitHub App

Follow [github-app.md](github-app.md). You need the client id, client secret and webhook secret.

## 2. Run locally in production mode

```sh
pnpm install
pnpm build                       # dist/web (SPA) + dist/server/server.mjs
cp .env.example .env             # fill in the values
set -a; . ./.env; set +a
NODE_ENV=production node dist/server/server.mjs
```

For development with auto-reload: `pnpm dev:server` (runs `src/server/main.ts` directly) and
`pnpm dev` for the web app. For sign-in to work locally, register
`http://localhost:8787/auth/callback` as a callback URL on the App and set
`APP_ORIGIN=http://localhost:8787`. To receive webhooks locally, forward them with a tunnel
(for example `smee.io` or `cloudflared`) to `http://localhost:8787/webhooks/github`.

## 3. Docker

```sh
docker build -t lanes .
docker run --rm --read-only -p 8787:8787 --env-file .env \
  -e APP_ORIGIN=http://localhost:8787 lanes
curl -fsS localhost:8787/health
```

The image runs `node dist/server/server.mjs` as the unprivileged `node` user with
`NODE_ENV=production` and `STATIC_DIR=/app/dist/web`. It needs no volume and no database, and
runs with a read-only filesystem (CI checks this). In production it exits at boot with a message
naming any missing required variable (add `-e ALLOW_ANONYMOUS_ONLY=1` to try it without a GitHub App). A `HEALTHCHECK` probes `/health`; `SIGTERM` shuts down
gracefully. Any container host works the same way: run the image, set the environment variables
below, and route `https://<your-domain>` to port 8787.

### Run exactly one instance

The event hub and poller are in-process. Run **one** replica (scale vertically); with several
replicas, SSE subscribers and webhooks could land on different instances. Sessions need no
server state, so restarts and redeploys keep everyone signed in. After a restart, clients see a
new stream epoch and reconcile automatically (`resync`), and the poller re-reads refs for every
repository with subscribers.

Disable scale-to-zero: SSE streams and the poller need a running process.

## TLS and reverse proxies

Terminate TLS at the platform or a reverse proxy; the server speaks plain HTTP. With an `https`
`APP_ORIGIN` the server sets HSTS, `Secure` + `__Host-` session cookies and
`upgrade-insecure-requests`.

Reverse-proxy requirements:

- Set `TRUST_PROXY` to the number of proxies that append to `X-Forwarded-For` (Railway: `1`), so rate
  limits see the real client IP. Leave it `0` when the server is reachable directly.
- Do not buffer SSE: the server sends `X-Accel-Buffering: no` (nginx honors it); for other
  proxies disable response buffering for `/api/v1/repositories/*/events` and allow long-lived
  responses (heartbeats every 15 s keep idle connections open).
- Pass the `Host`/`Origin` headers through unchanged. State-changing requests are rejected unless
  `Origin` equals `APP_ORIGIN` (CSRF protection).
- Allow request bodies up to 25 MB on `/webhooks/github` (GitHub's maximum payload).

nginx example:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_read_timeout 1h;
  client_max_body_size 25m;
}
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `APP_ORIGIN` | `http://localhost:$PORT` | Public origin (scheme+host[+port]). OAuth redirect, CSRF, cookies, HSTS. |
| `NODE_ENV` | `production` in the image | `production` requires `APP_ORIGIN`, `SESSION_SECRET`, the relay, database and GitHub App variables. |
| `OIDC_ISSUER` | — | Auth relay issuer: `https://auth.chrisvouga.dev/realms/projects` (production) or `https://auth-dev.chrisvouga.dev/realms/projects-dev`. |
| `OIDC_CLIENT_ID` | — | Public client id from the relay registration (`app-<uuid>`). |
| `OIDC_REDIRECT_URI` | `$APP_ORIGIN/auth/callback` | Must equal the registered callback. |
| `OIDC_SCOPES` / `OIDC_IDP_HINT` | `openid email profile` / `google` | |
| `DATABASE_URL` | — | Opaque PostgreSQL URL (Vault). Required: the web client syncs through Zero, which needs it. |
| `ZERO` | `1` | `0` turns Zero sync off (API, CLI and MCP only). |
| `ZERO_CACHE_URL` | — | External zero-cache (internal URL). Default: run zero-cache as a child process. |
| `ZERO_PORT` | `4848` | Port of the embedded zero-cache (loopback). |
| `ZERO_UPSTREAM_DB` / `ZERO_CVR_DB` / `ZERO_CHANGE_DB` | `DATABASE_URL` / — / — | Replication source (direct connection) and zero-cache's own databases. |
| `ZERO_APP_ID` | `lanes_zero` | Names zero-cache's PostgreSQL schemas. |
| `ZERO_API_KEY` / `ZERO_ADMIN_PASSWORD` | random per boot | zero-cache → server key; zero-cache admin password. |
| `ZERO_REPLICA_FILE` | `$TMPDIR/lanes-zero-$PORT/replica.db` | zero-cache's SQLite replica (a cache). |
| `ZERO_CACHE_BIN` | the installed package | Path to zero-cache's `cli.js` (set in the image). |
| `ZERO_LOG_LEVEL` / `ZERO_NUM_SYNC_WORKERS` | `warn` / zero-cache default | |
| `DATABASE_SCHEMA` / `DATABASE_POOL_MAX` | `lanes` / `5` | Allocated schema; pool size. |
| `MIGRATE_ON_BOOT` | `1` | `0` to run `pnpm db:migrate` separately. |
| `TOKEN_ENCRYPTION_KEY` | — | ≥ 32 bytes. Encrypts stored GitHub tokens. |
| `ALLOW_ANONYMOUS_ONLY` | — | `1`: allow production without the GitHub App (public repositories only, no webhooks). |
| `SESSION_SECRET` | random (dev only) | ≥ 32 bytes. Encrypts the session cookie. Rotating it signs everyone out. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | GitHub App (or OAuth App) credentials. Without them: anonymous, public repos only. |
| `GITHUB_APP_SLUG` | — | Optional; exposed to the UI for install links. |
| `GITHUB_OAUTH_SCOPES` | `read:user` | OAuth App fallback only; `repo read:user` to read private repos. GitHub Apps ignore scopes. |
| `GITHUB_WEBHOOK_SECRET` | — | Verifies `X-Hub-Signature-256`. Without it webhooks are off (polling only). |
| `GITHUB_PUBLIC_TOKEN` | — | Optional server token for anonymous reads of **verified-public** repos (higher rate limit). Never used for private repos. |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise Server: `https://ghe.example.com/api/v3`. |
| `GITHUB_WEB_URL` | `https://github.com` | GitHub Enterprise Server: `https://ghe.example.com`. |
| `STATIC_DIR` | `dist/web` | Built SPA, relative to the working directory. |
| `TRUST_PROXY` | `0` | Trusted proxy hops for `X-Forwarded-For`. |
| `SESSION_IDLE_TTL_HOURS` | `168` | Idle session lifetime. |
| `SESSION_ABSOLUTE_TTL_HOURS` | `720` | Absolute session lifetime. |
| `RATE_LIMIT_API_BURST` / `RATE_LIMIT_API_PER_SEC` | `300` / `30` | `/api` token bucket per session (or IP when signed out). |
| `RATE_LIMIT_AUTH_BURST` / `RATE_LIMIT_AUTH_PER_SEC` | `20` / `0.2` | `/auth` token bucket per IP. |
| `POLL_FAST_SECONDS` / `POLL_MAX_SECONDS` | `15` / `300` | Reconciliation poller range (see below). |

## How real-time sync works

1. GitHub delivers `push` / `create` / `delete` / `repository` / installation events to
   `/webhooks/github`. The server verifies the signature, drops already-seen delivery ids,
   answers `202` immediately and processes the event on an in-process queue (bounded retries with
   exponential back-off).
2. Ref-affecting events trigger a reconciliation: the server re-reads the refs from GitHub with
   conditional requests (unchanged = `304`, free against the rate limit) and publishes
   `refs.changed` only if the refs version actually changed. Bursts of pushes coalesce into one
   or two reads. Payload state is never applied blindly, so duplicate and out-of-order deliveries
   converge on GitHub's real state.
3. A poller covers missed webhooks, repositories without the App installed, and restarts. It only
   runs for repositories that currently have subscribers: first poll immediately, then
   `POLL_FAST_SECONDS` (or 60 s when webhooks are known to arrive), doubling with jitter while idle
   up to `POLL_MAX_SECONDS`, and stretched when the GitHub rate-limit budget runs low. With the
   defaults an idle repository costs about 16 polls (≈ 48 conditional requests, nearly all `304`)
   per hour while someone is watching it, and nothing when nobody is.
4. `GET /api/v1/repositories/:id/sync` reports the last successful sync, last error, webhook
   coverage, poll interval and current refs version.

Access control: an event stream is only opened after the caller proves read access to the
repository on GitHub. When a repository becomes private, is deleted or loses the App installation,
or a user revokes the App, affected streams receive `access.revoked` and are sealed; reconnecting
re-checks access.

## Security notes

- GitHub tokens live only inside the sealed session cookie (AES-256-GCM): the browser stores it
  but cannot read or change it, and JavaScript cannot see it (`HttpOnly`, `SameSite=Lax`,
  `__Host-` + `Secure` on https). The session id changes on sign-in.
- Logout and revocation end the session in the running process right away (an old copy of the
  cookie stops working). After a restart, an old copy stays valid until GitHub rejects its token
  or the session expires; revoking the app on GitHub ends every session at once.
- A token refresh that happens where no cookie can be written (an open event stream, a background
  poll) is kept in memory and written on the next request. If the process restarts in between,
  that user signs in again.
- OAuth uses PKCE (S256) and a single-use `state` bound to the pre-login session, valid 10 minutes.
  `returnTo` must be a same-origin relative path.
- Strict CSP, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`,
  `Permissions-Policy`, HSTS on https.
- Private repositories answer `404` to callers without access, exactly like missing ones.
- Logs never contain tokens; they are JSON lines on stdout/stderr.
