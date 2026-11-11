# Architecture

Ports and adapters around one repository interface and one command registry.

```
  ┌──────────── browser (SolidJS) ─────────────┐
  │ URL ⇄ ViewState      UI: palette/keys/menus │      every read: a Zero query
  │ Zero client (IndexedDB) ── queries ─────────┤      every write: a Zero mutator
  │ graph worker: order + layout + search       │
  │ browser agent: serves folders opened here   │──┐
  └───────────────┬─────────────────────────────┘  │ mutators (agent.*)
                  │ WebSocket /zero (same origin, session cookie)
  ┌───────────────▼──── hosted server (Hono) ───────────────────────┐
  │ /zero → zero-cache (child or sidecar) ⇄ /internal/zero/{query,mutate}│
  │ PostgreSQL "lanes": repos, refs, commits, reads, operations,     │
  │   demands, agents, visits (+ accounts, GitHub links)             │
  │ GitHub agent: demands → GitHubAdapter → SQL; webhooks + poller   │
  │ /api/v1, SSE, MCP over HTTP (unchanged, for agents and the CLI)  │
  └───────────────▲──────────────────────────────────────────────────┘
                  │ Zero client (token auth): queries for work, mutators to publish
  ┌───────────────┴──── companion (git-graph serve) ─┐
  │ CliGitAdapter → installed git, watchers           │   git-graph CLI / MCP (localhost API)
  └───────────────────────────────────────────────────┘
```

## Zero sync

The web client has a single data path: [Zero](https://zero.rocicorp.dev). Everything it shows is a
synced query (`src/zero/queries.ts`) answered from its local store at once and kept current by
zero-cache; everything it changes is a mutator (`src/zero/mutators.ts`). There are no loading
states: the UI renders what is synced, and more appears as it arrives.

- **zero-cache** runs as a child process in local development, or as an internal-only sidecar in
  production (`ZERO_CACHE_URL`). Browsers always reach it through the server's `/zero` proxy, so
  the origin and session cookie stay the same; the sidecar has no public hostname.
- **Repositories are published by source agents.** One generic `RepoSyncer` (`src/agent/`) turns
  any `RepositoryPort` into rows: info and capabilities, refs, history pages, working-tree status.
  The server runs it for GitHub (writing SQL directly), the companion runs it for local
  repositories, and a browser tab runs it for folders it opened (both through Zero mutators).
- **Demands** (`repo.open`): a viewer looking at a repository, with how much history. Agents serve
  open demands, verify access first (GitHub: with the viewer's token), and stop serving idle ones.
  The graph's window grows as the viewer scrolls (`repo.commits` with a larger limit, a deeper
  demand).
- **Reads** (`read.request`): commit details, diffs, files, blame, file history, worktrees,
  conflicts, "my GitHub repositories". A read is a row: the agent fills in the result, everyone
  who can see the repository shares it. Live reads (working tree) are re-run on change. The UI
  prefetches details and diffs around the cursor, so opening them is immediate.
- **Operations** (`op.enqueue`): every registry mutation (branch, tag, merge, push, stage…) is a
  row run by the repository's agent with `executeCommand`, including the destructive
  confirmation round trip (`confirm` state → the viewer accepts the exact consequence →
  `op.confirm` with the token). GitHub operations run with the requester's own token.
- **Permissions** are plain code: read rules in ZQL (`visibleRepos`: verified-public GitHub
  repositories, or an access row), write rules in the server mutators (`src/server/zero/`).
- **Order and layout** stay off the UI thread: the worker receives the synced commits as deltas
  and computes git's date/topo order (`orderCommits`) and the lane layout for the query's tips.

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

| Source | Detection | Published by |
|---|---|---|
| GitHub | HMAC-verified webhooks, deduped; adaptive ETag polling of repositories with open demands | the server's GitHub agent, SQL |
| Local | `fs.watch` on the git dirs and the working tree (40–60 ms debounce), digest dedupe | the companion, Zero mutators |
| Browser folder | 60 s re-check while the tab is open | the tab, Zero mutators |

Clients never poll: zero-cache pushes every change of a query's result. A refresh after a push
re-reads refs, walks changed tips down to known commits and publishes only what is new.

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
