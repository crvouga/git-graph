# Lanes

A fast, keyboard-first, URL-driven Git graph for the web. The graph is the home screen; it looks and
behaves like mhutchie's Git Graph for VS Code (the visual reference — no code is shared), runs in any
modern browser, and works with:

| Source | How | What you get |
|---|---|---|
| **GitHub** | `https://<host>/github/<owner>/<repo>` | Public repos anonymously; private repos after GitHub sign-in. Browse, compare, diff, branch/tag management. Live updates via webhooks + SSE. |
| **Local, full Git** | `git-graph open .` | The installed `git` through a localhost companion: staging hunks, commits, worktrees, merge/rebase/cherry-pick/revert/reset, conflicts, stash, remotes, push/pull/fetch, "Run Git command…". Live updates from filesystem watchers. |
| **Local, read-only** | "Open Folder in Browser…" | The `.git` directory parsed in a Web Worker (packfiles, deltas) through the File System Access API. No install. |

Every view is a URL, every action is a command (palette, shortcuts, context menus, HTTP API, CLI and MCP
all use the same registry), and 100,000-commit histories stay at 60 fps.

## Quick start

Requirements: Node ≥ 22.12 (24+ recommended), Git ≥ 2.30, pnpm 12 (`corepack enable`).

```bash
pnpm install
pnpm build                       # dist/web (SPA), dist/server, dist/cli, dist/companion
pnpm start                       # production server on http://localhost:8787 (APP_ORIGIN defaults to it)
node dist/cli/git-graph.mjs open .   # opens this repo through the local companion
```

Development: `pnpm dev:server` (API on :8787) and `pnpm dev` (Vite on :5173, proxies `/api` and `/auth`).
Run `git-graph serve --allow-origin http://localhost:5173` and `git-graph open . --app-origin http://localhost:5173`.

### Example deep links (local production server)

```
http://localhost:8787/github/mhutchie/vscode-git-graph
http://localhost:8787/github/mhutchie/vscode-git-graph?branch=master
http://localhost:8787/github/mhutchie/vscode-git-graph?commit=881a9e613045bacbbadf8940f6b6c5b8bd699335
http://localhost:8787/github/mhutchie/vscode-git-graph?compare=e44a48bb...881a9e61
http://localhost:8787/github/mhutchie/vscode-git-graph?commit=881a9e613045bacbbadf8940f6b6c5b8bd699335&file=CHANGELOG.md
http://localhost:8787/github/owner/repo?branch=main&focus-branch=feature/auth&commit=abc123&compare=def456&file=src/index.ts&view=diff
http://localhost:8787/?repo=owner/repo&provider=github          (normalized to the path form)
http://localhost:8787/local/<id>?commit=<hash>                   (id printed by `git-graph open`)
```

URL parameters: `branch` (repeatable), `focus-branch`, `commit`, `compare` (`<hash>` or `<a>...<b>`),
`select` (comma list), `file`, `view` (`graph|details|diff`), `q`, `remotes=0`, `tags=0`, `stashes=0`,
`order=topo|author-date`, `first-parent=1`, `at` (top row). Invalid parameters are ignored with a visible
notice; missing branches are explained with a "Show all branches" action. Credentials never appear in URLs.

## Keyboard

`Mod` = ⌘ on macOS, Ctrl elsewhere. Press `?` for the searchable list.

| Keys | Action |
|---|---|
| `Mod+Shift+P` / `F1` | Command palette (shows target, shortcut, or why an action is unavailable) |
| `↑ ↓` `j k` `PgUp PgDn` `Home End` | Move between commits |
| `Mod+↓` / `Mod+↑` (`+Shift` for the other branch) | Parent / child |
| `Enter` | Open details in place · `Tab` into files · `Enter` diff · `Esc` back (focus returns) |
| `Space` / `c` | Toggle selection (nonadjacent) / compare with the selected commit |
| `← →` | Choose a branch/tag label on the focused row |
| `Shift+F10` / Menu key | Context menu for the focused commit, label, file or hunk |
| `Mod+F` or `/` | Find (message, author, hash, ref); `Enter`/`Shift+Enter` next/previous |
| `h` `s` `b` `o` `w` `r` `y` `i` | HEAD, next stash, branch filter, open repo, switch worktree, refresh, copy link, tooltip |
| Diff: `n p` `] [` `s` `x` `v` | Hunks, files, stage/unstage hunk, discard hunk, reviewed |

Columns are resizable with the keyboard ("Resize Columns…", then `←/→`). Browser-reserved shortcuts are never bound.

## Architecture

```
src/core        pure, shared: types, RepositoryPort, command registry, URL state, graph layout, API router/client, event hub, git parsers
src/web         SolidJS app; all data through Zero sync; graph worker does ordering, layout, search
src/zero        Zero schema, synced queries, mutators (shared by web, server, companion)
src/agent       source agents: publish a repository (any RepositoryPort) into Zero, run queued operations
src/server      Hono: static SPA, sign-in + sessions, Zero endpoints + embedded zero-cache, GitHub agent, /api/v1, webhooks, SSE, poller
src/github      GitHub adapter (REST, ETag cache, rate limits)
src/companion   localhost service: Git CLI adapter, watchers, pairing, origin/host checks
src/browser-git read-only .git reader for the File System Access path
src/cli         git-graph CLI (open/url/compare/commands/exec/events/run/serve/mcp)
src/mcp         MCP server over stdio, backed by the registry
```

See [docs/architecture.md](docs/architecture.md), [docs/api.md](docs/api.md) (HTTP + event protocol),
[AGENTS.md](AGENTS.md), [docs/deploy.md](docs/deploy.md), [docs/github-app.md](docs/github-app.md),
[docs/performance.md](docs/performance.md) and [docs/parity.md](docs/parity.md).

## Testing

```bash
pnpm check                                 # typecheck
pnpm test                                  # unit + property + adapter contract + real-git integration (vitest)
node test/fixtures/make-fixtures.ts --large   # 100k-commit fixture (once)
pnpm test:e2e                              # builds, then Playwright against the production build
pnpm storybook                             # UI development: every component and state, real fixture repo
pnpm test:storybook                        # every story as a browser test
pnpm ui:compare                            # before/after screenshots of every story vs origin/main
```

UI work is done in Storybook; see [docs/ui-development.md](docs/ui-development.md).

All tests use disposable fixture repositories and a local bare remote; GitHub tests use a fake GitHub
(OAuth with PKCE, private repos, webhooks). Nothing touches real repositories or github.com.
