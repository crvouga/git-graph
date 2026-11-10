# Architecture

Ports and adapters around one repository interface and one command registry.

```
            ┌──────────────── browser ────────────────┐
 URL ⇄ ViewState (core/url)        UI (SolidJS)        │
            │                       │  palette / keys / menus → registry (core/commands)
            │                       ▼
            │        Engine worker (web/engine/worker.ts)
            │          fetch + JSON parse, GraphLayout, search index,
            │          IndexedDB cache, SSE client, BroadcastChannel + Web Locks
            │             │ HttpRepository            │ BrowserGitRepository (read-only .git)
            └─────────────┼───────────────────────────┼──────────────┘
                          ▼                           ▼ File System Access
          ┌──────── hosted server (Hono) ────────┐   local folder
          │ /api/v1  = core/api/router + registry │
          │ GitHubAdapter (ETag cache, rate limit)│◀── webhooks (signed, deduped)
          │ sessions, OAuth+PKCE, CSRF, CSP       │──▶ poller (reconcile, backoff)
          │ EventHub → SSE                        │
          └──────────────────────────────────────┘
          ┌──────── companion (127.0.0.1:7420) ──┐
          │ /api/v1  = same router + registry     │   git-graph CLI / MCP
          │ CliGitAdapter → installed git         │◀── same registry, in-process
          │ watchers (gitdir, common dir, tree)   │
          │ bearer token, origin + host checks    │
          └──────────────────────────────────────┘
```

## Core contracts (`src/core`)

- `types.ts` — domain types, `Capabilities` (every unavailable capability carries a reason), the
  `GitMutation` union, stable `ErrorCode`s, `RepositoryEvent` + `EventEnvelope` (epoch + seq cursors).
- `port.ts` — `RepositoryPort`: reads, `mutate(m, precondition)`, `subscribe`.
- `commands/` — `CommandRegistry`, `executeCommand` (zod validation → availability/capability →
  destructive consequence + confirmation token → execute). `repo-commands.ts` defines queries, one
  command per `GitMutation` op, and `link.build`. The UI registers its own `ui` commands in the same registry.
- `url/state.ts` — total `parseUrl` (invalid input degrades with warnings) and canonical `serialize`.
- `graph/layout.ts` — streaming lane assignment (see below).
- `api/router.ts` / `api/client.ts` — the `/api/v1` HTTP surface (every route maps to a command) and
  its client (`HttpRepository`, fetch-based SSE with backoff + `Last-Event-ID`).
- `sync/hub.ts` — per-repository ring buffers, dedupe keys, resumable cursors, `resync` on gaps/restarts.

## Graph layout

Commits arrive children-first. Each commit takes the leftmost lane expecting it (or the first free
lane); lanes never move sideways, so a row's layout depends only on the rows above it. That makes
pagination a plain `append`, and a refresh after a push a `rebase`: lay out the new prefix, then walk
old rows until the lane state (including color bookkeeping) equals an old checkpoint (every 64 rows),
and splice the remaining rows verbatim. Property tests check that every commit connects to exactly its
parents and that paged/rebased layouts equal a full recompute. Colors follow branches the way Git Graph
does (a lane keeps its color; a new lane takes the lowest free color).

Rendering: rows are absolutely positioned DOM (`role=row`, accessible names) for the visible window
only; one SVG draws edges for that window, grouped into one path per color.

## Synchronization

| Source | Detection | Recovery |
|---|---|---|
| Local | `fs.watch` on worktree git dir, common dir (`refs`, `packed-refs`, `worktrees/`) and the working tree; 40–60 ms debounce; digest-based dedupe; every worktree of a common dir is notified | 5 s digest poll while subscribed |
| GitHub | HMAC-verified webhooks, durable delivery-id dedupe, coalesced per repo, then authoritative ref re-read (order-independent) | adaptive ETag polling (304s are free), backoff when idle, pause without subscribers |
| Browser | SSE (one tab per repo holds it via Web Locks; others get events over BroadcastChannel), focus/online/visibility triggers | 60 s safety poll when live, faster when polling; `resync` on epoch change |

The engine refreshes by reading refs (conditional request); if the version changed it fetches the first
page, aligns it with loaded rows and splices (selection and scroll anchor kept by object id), otherwise
it re-reads as many rows as were loaded. Each repository open is a session: requests of older sessions
are aborted and their results dropped.

## Security

- Hosted server: server-side sessions in an `HttpOnly` `SameSite=Lax` cookie; GitHub tokens never reach the
  browser; OAuth `state` + PKCE; `returnTo` restricted to same-origin paths; Origin/Sec-Fetch-Site CSRF
  checks; token-bucket rate limits; strict CSP and security headers; private repos 404 to callers without
  access; `GITHUB_PUBLIC_TOKEN` is only used for repos verified public.
- Companion: binds 127.0.0.1; bearer token for everything but `/health` and `/pair`; exact-origin CORS
  allowlist with Private Network Access preflight; Host header check (DNS rebinding); one-time pairing
  codes (120 s, single use, rate-limited) delivered in the URL fragment and stripped immediately.
- Git: argument arrays only, `--` before paths, literal pathspecs, user config/hooks/signing/credential
  helpers respected, no `--no-verify`, `--force-with-lease` for force pushes, no automatic retries.
