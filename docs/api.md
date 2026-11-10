# HTTP API and event protocol (v1)

Base: `/api/v1` on the hosted server (GitHub repositories, session cookie) and on the companion at
`http://127.0.0.1:7420/api/v1` (local repositories, `Authorization: Bearer <token>`). The full schema is
served at `GET /api/v1/openapi.json`; every command's argument JSON schema is in `GET /api/v1/commands`.

## Reads

| Route | Command |
|---|---|
| `GET /repositories?query=&limit=` | `repo.list` |
| `GET /repositories/:id` | `repo.info` |
| `GET /repositories/:id/capabilities` | `repo.capabilities` |
| `GET /repositories/:id/refs` | `repo.refs` — `ETag` is the refs version; send `If-None-Match` for `304` |
| `GET /repositories/:id/commits?ref=&remotes=&tags=&stashes=&order=&first-parent=&cursor=&limit=` | `repo.history` |
| `GET /repositories/:id/commits/:hash` | `repo.commit` (immutable for full hashes) |
| `GET /repositories/:id/compare?base=&head=&path=` | `repo.compare` |
| `GET /repositories/:id/diff?hash=` · `?base=&head=` · `?working=staged|unstaged` (`&path=&context=`) | `repo.diff` |
| `GET /repositories/:id/search?text=` | `repo.search` |
| `GET /repositories/:id/file-history?path=` · `/blame?path=&rev=` · `/file?path=&rev=` | |
| `GET /repositories/:id/status` · `/worktrees` · `/remotes` · `/conflict?path=` | local only |
| `GET /repositories/:id/sync` | hosted server: last sync, last error, webhook coverage, poll interval |

## Commands and mutations

```http
POST /api/v1/commands/execute
{"command": "git.branch.delete", "args": {"repo": "local:AbC", "name": "old"}, "confirm": "<token>"}
```

`POST /repositories/:id/mutations {"mutation": {"op": "...", ...}, "precondition": {...}, "confirm": "..."}`
is equivalent to `git.<op>`.

Errors: `{"error": {"code", "message", "details"?}}` with stable codes — `BAD_REQUEST` 400,
`UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND`/`REF_NOT_FOUND`/`COMMIT_NOT_FOUND` 404,
`STALE_STATE`/`CONFLICT` 409, `GIT_FAILED` 422, `CONFIRMATION_REQUIRED` 428, `RATE_LIMITED` 429
(`details.retryAfter`), `UNSUPPORTED` 501, `UPSTREAM_ERROR` 502, `GIT_MISSING`/`OFFLINE` 503, `TIMEOUT` 504.

`CONFIRMATION_REQUIRED` carries `details.consequence` (exact target and effect) and `details.confirmToken`
(bound to the command and exact arguments). Preconditions: `{"refsVersion": "<v>"}` and/or
`{"ref": {"name": "refs/heads/x", "commit": "<sha>"}}` → `STALE_STATE` when violated.

## Events (SSE)

`GET /repositories/:id/events` — `text/event-stream`. Each frame:

```
id: <epoch>:<seq>
event: refs.changed
data: {"epoch":"…","seq":42,"at":1794273771015,"event":{"type":"refs.changed","repositoryId":"local:AbC","version":"35bc30f676c27b08"}}
```

Event types: `refs.changed {version}`, `commits.added {commits}`, `status.changed {worktreeId}`,
`worktree.changed {worktreeId}`, `operation.started|completed {operationId, op, ok}`, `sync.ok`,
`sync.failed {reason}`, `resync {reason}`, `access.revoked`. The first frame is `event: hello`.

Resume with `Last-Event-ID: <epoch>:<seq>` (or `?cursor=`). The server replays everything after the
cursor from its ring buffer, or sends `resync` when it cannot prove continuity (buffer overflow, server
restart → new epoch). On `resync`, re-read refs. Events are at-least-once and may coalesce bursts;
`refs.changed` always carries the authoritative version, so clients compare versions instead of counting events.

MCP exposes the same stream as `events_wait {repo, cursor?, timeoutMs?}` → `{events, cursor}`.
