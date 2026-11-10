# Creating the GitHub App for Lanes

People sign in to Lanes through the shared auth relay (Google), then **connect GitHub** through a
**GitHub App** using user-to-server tokens (stored encrypted in PostgreSQL). Requests are made with
the user's own token, so a user only ever sees repositories they can access on GitHub *and* where the
App is installed. An OAuth App also works (see the end), with fewer guarantees.

Replace `<APP_ORIGIN>` below with your public origin, e.g. `https://git-graph.example.com`.

## 1. Register the App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App** (for an organization:
**Organization settings → Developer settings → GitHub Apps**).

| Field | Value |
| --- | --- |
| GitHub App name | e.g. `Lanes (example.com)` — becomes the slug for `GITHUB_APP_SLUG` |
| Homepage URL | `<APP_ORIGIN>` |
| Callback URL | `<APP_ORIGIN>/auth/github/callback` (add `http://localhost:8787/auth/github/callback` as a second callback for local development) |
| Expire user authorization tokens | **ON** (8-hour tokens with refresh tokens; the server refreshes them) |
| Request user authorization (OAuth) during installation | ON (optional, smoother first run) |
| Enable Device Flow | OFF |
| Setup URL | leave empty |
| Webhook → Active | ON |
| Webhook URL | `<APP_ORIGIN>/webhooks/github` |
| Webhook secret | a long random string (`openssl rand -hex 32`) → `GITHUB_WEBHOOK_SECRET` |
| SSL verification | Enabled |

### Repository permissions

| Permission | Access | Why |
| --- | --- | --- |
| **Contents** | **Read-only** — or **Read and write** if you want branch/tag create, rename and delete from Lanes | commits, refs, diffs, files, blame; writes for branch/tag management |
| **Metadata** | Read-only (mandatory) | repository info, visibility |

Nothing else is needed. No organization or account permissions.

### Subscribe to events

- **Push**
- **Create**
- **Delete**
- **Repository**

`installation` and `installation_repositories` events are delivered to every GitHub App
automatically (no checkbox); Lanes uses them to revoke access when the App is removed from a
repository. `github_app_authorization` is also automatic and ends a user's sessions when they
revoke the App.

### Where can this GitHub App be installed?

- *Only on this account* for a private deployment for one user/org.
- *Any account* for a public deployment.

Click **Create GitHub App**.

## 2. Collect the credentials

On the App's page:

- **Client ID** → `GITHUB_CLIENT_ID`
- **Generate a new client secret** → `GITHUB_CLIENT_SECRET`
- the slug in the App's public URL (`https://github.com/apps/<slug>`) → `GITHUB_APP_SLUG`
- the webhook secret you chose → `GITHUB_WEBHOOK_SECRET`

A private key is **not** needed (Lanes only uses user-to-server tokens).

## 3. Install the App

Open `https://github.com/apps/<slug>` → **Install** → choose the account and repositories.
Users can view any repository they have access to **where the App is installed**; public
repositories can also be viewed anonymously (no installation needed, lower rate limit).

## 4. Configure and verify

Set the variables (see [deploy.md](deploy.md)) and restart the server. Then:

1. Open `<APP_ORIGIN>` and sign in. You return to the page you started from.
2. `GET <APP_ORIGIN>/api/v1/session` shows `"authenticated": true` and your login (never a token).
3. In the App settings → **Advanced → Recent Deliveries**, the `ping` delivery shows `202`.
   Push to an installed repository and watch the graph update.

## OAuth App fallback

If you cannot use a GitHub App: **Settings → Developer settings → OAuth Apps → New OAuth App**,
Authorization callback URL `<APP_ORIGIN>/auth/github/callback`. Set `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`. Differences:

- Tokens do not expire (no refresh). Sign-out ends the server session; revoke the token at
  github.com → Settings → Applications if needed.
- Scopes come from `GITHUB_OAUTH_SCOPES` (default `read:user`, public repositories only). To view
  private repositories set `GITHUB_OAUTH_SCOPES="repo read:user"` — note `repo` grants **write**
  access to all of the user's repositories; a GitHub App is strongly preferred.
- OAuth Apps have no App webhooks. Configure a repository or organization webhook manually
  (Settings → Webhooks → Add webhook: payload URL `<APP_ORIGIN>/webhooks/github`, content type
  `application/json`, the same secret, events Push / Branch or tag creation / Branch or tag
  deletion / Repositories), or rely on polling.

## Security checklist

- Keep `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` and `SESSION_SECRET` in your platform's
  secret store, not in the image.
- Grant **Contents: Read and write** only if you want branch/tag management in the hosted app;
  everything else is read-only. Even with write access, Lanes only exposes branch and tag
  create/rename/delete, each gated by the user's own permission and an optimistic precondition,
  and destructive deletes require explicit confirmation.
- `GITHUB_PUBLIC_TOKEN` is optional. If you set it, prefer a fine-grained token with *Public
  repositories (read-only)* access; the server additionally refuses to use it for any repository
  that is not verifiably public.
