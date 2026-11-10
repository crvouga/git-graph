# Agent guide

Use the structured interfaces. Do not drive the visual UI for anything a command can do.

## Interfaces (same command registry everywhere)

| Interface | Use it for |
|---|---|
| **MCP** — `git-graph mcp` (stdio) | Every command as a tool (`repo_history`, `git_branch_create`, `link_build`, …) plus `events_wait`, `sync_status`, `refresh`. Local repos run in-process; GitHub repos go to `LANES_SERVER_URL`. |
| **HTTP** — `/api/v1` on the hosted server (GitHub) or `http://127.0.0.1:7420/api/v1` on the companion (local, needs `Authorization: Bearer <token>`) | `GET /commands` (JSON schemas), `POST /commands/execute`, REST reads, `GET /repositories/:id/events` (SSE), `GET /openapi.json`. |
| **CLI** — `git-graph` | `commands --json`, `exec <id> --json '<args>' [--confirm <token>]`, `url …`, `events --repo …`. Exit codes: 0 ok, 1 error, 2 usage, 3 confirmation required, 4 unsupported, 5 not found, 6 unauthenticated, 7 companion unreachable. |

Repository keys: `github:<owner>:<repo>`, `local:<id>` (from `local.open {path}` / `git-graph open --json`), `browser:<id>` (UI only).

## Rules

1. **Discover first**: `GET /api/v1/commands` or MCP `listTools`. Read `capability` and call `repo.capabilities`;
   an unavailable capability comes with a `reason` — report it, don't work around it.
2. **Destructive commands** answer `CONFIRMATION_REQUIRED` (HTTP 428, CLI exit 3) with `details.consequence`
   and `details.confirmToken`. Show the consequence to the user and resend with `confirm: <token>` only
   with their approval. Never fabricate tokens. The token is bound to the exact arguments.
3. **Concurrency**: pass `precondition: { refsVersion }` (from `repo.refs`) or `{ ref: { name, commit } }` on
   mutations. `STALE_STATE` means re-read and re-plan. Never auto-retry a failed mutation.
4. **Stay current by subscribing**, not polling: SSE `GET /repositories/:id/events` (resume with `Last-Event-ID`)
   or MCP `events_wait {repo, cursor}`. A `resync` event means: re-read `repo.refs` (and history if the version changed).
5. **Hand users a link** to what you did: `link.build { repo, commit?, compare?, branches?, file?, view? }`.
6. GitHub repositories have no working tree, index, worktrees or hooks; local-only commands return `UNSUPPORTED` there.
7. Interactive git (editors, prompts) is not available over the API; ask the user to run `git-graph run -- <args>`.

## Typical flow

```jsonc
// 1. inspect
{"command":"repo.refs","args":{"repo":"local:AbC"}}
{"command":"repo.history","args":{"repo":"local:AbC","limit":50}}
// 2. act (non-destructive)
{"command":"git.branch.create","args":{"repo":"local:AbC","name":"fix/x","target":"<hash>","precondition":{"refsVersion":"<v>"}}}
// 3. destructive → 428 with consequence+token → ask → resend
{"command":"git.branch.delete","args":{"repo":"local:AbC","name":"old"},"confirm":"<token>"}
// 4. link
{"command":"link.build","args":{"repo":"local:AbC","commit":"<hash>"}}
```

## Working on this codebase

- `pnpm check`, `pnpm test`, `pnpm test:e2e` (production build). Fixtures: `node test/fixtures/make-fixtures.ts [--large]`.
- Erasable TypeScript only (Node runs `.ts` directly); import local files with `.ts` extensions.
- Commands live in `src/core/commands/` — add a command there, not in a single interface.
- UI elements have stable roles/labels (`grid` "Commit graph…", `row` with `data-hash`, `region` "Commit details",
  `tree` "Changed files", `combobox` in the palette). Prefer them in Playwright.

## UI changes: always through Storybook

Full guide: [docs/ui-development.md](docs/ui-development.md). Required for any change under `src/web/`
that can alter what is rendered:

1. Develop in Storybook (`pnpm storybook`, MCP at `http://localhost:6006/mcp`), not the running app.
   Find the story for the UI you touch; if none shows that state, write it first.
2. Add or update stories for every new or changed state, with `play` assertions for behaviour.
   `pnpm test:storybook` must pass.
3. Run `pnpm ui:compare` and look at every image in `.ui-shots/compare/`. Show the user the before/after
   images (absolute paths) in your reply.
4. After opening the PR, run `pnpm ui:publish --pr <number>` so the description has the before and
   after screenshots. Re-run after later UI changes. A UI PR without them is not ready.

## Branches and pull requests

- `main` is the only long-lived branch. Branch from `origin/main`, open a PR into `main`.
- Merges are squash-only; the PR title becomes the commit title on `main`, so write it as one.
  Head branches are deleted automatically after merge.
- `main` takes no direct pushes or force pushes. A PR merges once the single required check, **CI ok**, passes.
  Queue it right away: `gh pr merge --auto --squash`.
- Every green CI run on `main` deploys (`.github/workflows/deploy.yml`, once `FLY_API_TOKEN` is set).
- GitHub settings (merge methods, branch rules, security) live in `.github/repo-settings.json`.
  Change them there, then `pnpm github:plan` / `pnpm github:apply`. Don't change them in the GitHub UI;
  the weekly drift check fails if you do. To add a CI job to the gate, add it to `ci-ok.needs`.
