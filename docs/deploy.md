# Deploying the Lanes server

The hosted server (`src/server/main.ts`, bundled to `dist/server/server.mjs`) serves:

- the web app (static files from `STATIC_DIR`, with SPA fallback),
- GitHub sign-in (`/auth/login`, `/auth/callback`, `POST /auth/logout`),
- the shared API at `/api/v1` (GitHub repositories only; local repositories are served by the
  `git-graph` CLI companion on the user's machine),
- GitHub webhooks at `POST /webhooks/github`,
- real-time updates over Server-Sent Events (`/api/v1/repositories/:id/events`),
- `GET /health`.

It is a single Node process with no database. Sessions and recent webhook delivery ids persist
to `DATA_DIR` (sessions encrypted with a key derived from `SESSION_SECRET`).

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
docker run -d --name lanes -p 8787:8787 --env-file .env \
  -e NODE_ENV=production -e APP_ORIGIN=https://git-graph.example.com \
  -v lanes-data:/data lanes
```

The image runs `node dist/server/server.mjs` as the unprivileged `node` user, with
`STATIC_DIR=/app/dist/web` and `DATA_DIR=/data`. Mount a volume at `/data` so sessions and the
webhook de-duplication log survive restarts. A `HEALTHCHECK` probes `/health`.

## 4. Fly.io (or any container host)

`deploy/fly.toml` is a working example:

```sh
fly launch --no-deploy --copy-config -c deploy/fly.toml
fly volumes create lanes_data --size 1 -c deploy/fly.toml
fly secrets set -c deploy/fly.toml \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  GITHUB_CLIENT_ID=Iv1.xxxx GITHUB_CLIENT_SECRET=xxxx GITHUB_WEBHOOK_SECRET=xxxx
fly deploy -c deploy/fly.toml --dockerfile Dockerfile .
```

Set `APP_ORIGIN` in `fly.toml` to your public origin (custom domain or `*.fly.dev`).

Other hosts (Render, Railway, Cloud Run, Kubernetes, a VM): run the image, expose port 8787,
set the environment variables below, mount persistent storage at `/data`, and route
`https://<your-domain>` to it.

### Run exactly one instance

The event hub, poller and session cache are in-process. Run **one** replica (scale vertically);
with several replicas, SSE subscribers and webhooks could land on different instances. Sessions
survive restarts via `DATA_DIR`. After a restart, clients see a new stream epoch and reconcile
automatically (`resync`), and the poller re-reads refs for every repository with subscribers.

Disable scale-to-zero (`auto_stop_machines = "off"` on Fly): SSE streams and the poller need a
running process.

## TLS and reverse proxies

Terminate TLS at the platform or a reverse proxy; the server speaks plain HTTP. With an `https`
`APP_ORIGIN` the server sets HSTS, `Secure` + `__Host-` session cookies and
`upgrade-insecure-requests`.

Reverse-proxy requirements:

- Set `TRUST_PROXY` to the number of proxies that append to `X-Forwarded-For` (Fly: `1`), so rate
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
| `NODE_ENV` | — | `production` requires `SESSION_SECRET`. |
| `SESSION_SECRET` | random (dev only) | ≥ 32 bytes. Encrypts persisted sessions. Rotating it signs everyone out. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | GitHub App (or OAuth App) credentials. Without them: anonymous, public repos only. |
| `GITHUB_APP_SLUG` | — | Optional; exposed to the UI for install links. |
| `GITHUB_OAUTH_SCOPES` | `read:user` | OAuth App fallback only; `repo read:user` to read private repos. GitHub Apps ignore scopes. |
| `GITHUB_WEBHOOK_SECRET` | — | Verifies `X-Hub-Signature-256`. Without it webhooks are off (polling only). |
| `GITHUB_PUBLIC_TOKEN` | — | Optional server token for anonymous reads of **verified-public** repos (higher rate limit). Never used for private repos. |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise Server: `https://ghe.example.com/api/v3`. |
| `GITHUB_WEB_URL` | `https://github.com` | GitHub Enterprise Server: `https://ghe.example.com`. |
| `STATIC_DIR` | `dist/web` | Built SPA, relative to the working directory. |
| `DATA_DIR` | `.data` | Encrypted sessions + webhook delivery log. Empty string = memory only. |
| `TRUST_PROXY` | `0` | Trusted proxy hops for `X-Forwarded-For`. |
| `SESSION_IDLE_TTL_HOURS` | `168` | Idle session lifetime. |
| `SESSION_ABSOLUTE_TTL_HOURS` | `720` | Absolute session lifetime. |
| `RATE_LIMIT_API_BURST` / `RATE_LIMIT_API_PER_SEC` | `300` / `30` | `/api` token bucket per session (or IP when signed out). |
| `RATE_LIMIT_AUTH_BURST` / `RATE_LIMIT_AUTH_PER_SEC` | `20` / `0.2` | `/auth` token bucket per IP. |
| `POLL_FAST_SECONDS` / `POLL_MAX_SECONDS` | `15` / `300` | Reconciliation poller range (see below). |

## How real-time sync works

1. GitHub delivers `push` / `create` / `delete` / `repository` / installation events to
   `/webhooks/github`. The server verifies the signature, records the delivery id durably,
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

- GitHub tokens live only in the server-side session store (encrypted at rest). The browser holds
  an opaque random session id in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-` + `Secure` on
  https).
- OAuth uses PKCE (S256) and a single-use `state` bound to the pre-login session, valid 10 minutes.
  `returnTo` must be a same-origin relative path.
- Strict CSP, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`,
  `Permissions-Policy`, HSTS on https.
- Private repositories answer `404` to callers without access, exactly like missing ones.
- Logs never contain tokens; they are JSON lines on stdout/stderr.
