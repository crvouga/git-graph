# Performance

Measured on an Apple Silicon MacBook Air (macOS 27, Chrome Headless 158, Git 2.54), production build,
by `test/e2e/perf.spec.ts`, `test/e2e/sync.spec.ts` and the integration suites. The e2e budgets below
are enforced: the suite fails when one is exceeded.

## 100,000-commit history (`.fixtures/large-100000`, 31 branches, 37 tags)

| Metric | Measured | Budget |
|---|---|---|
| Time to first visible commits (navigation → first row, cold) | 885 ms | 1500 ms |
| Time to first usable graph (keyboard navigation works) | 905 ms | 2000 ms |
| DOM rows while scrolling (virtualized) | 34 | < 120 |
| Scroll frame rate while history streams in | 60 fps (p95 frame 18 ms) | > 50 fps |
| Palette keystroke → next frame, while history loads | p50 4 ms, p95 14 ms | p95 < 50 ms |
| Commit selection (Enter → details rendered) | 37 ms | 400 ms |
| Branch filter (navigate with `?branch=`, rows shown) | 828 ms | 1500 ms |
| Cached reopen (IndexedDB rows, then revalidate) | 74 ms (first rows from cache 17 ms) | 1200 ms |
| JS heap after loading/scrolling | 20 MB | — |
| Open a 40,000-line diff (20k-line file rewritten) | 215 ms (55 DOM lines) | 2500 ms |
| Graph layout of 100k rows (worker, unit test) | ~30 ms | 1500 ms |
| Companion: first page of 300 / full 100k stream | 306 ms (50 ms with a commit-graph) / ~500 ms | — |
| Browser `.git` reader: cold first page / warm | 650–810 ms / 1–2 ms | — |

## Freshness

| Metric | Measured | Target |
|---|---|---|
| Local commit (shell) → visible graph | ~205 ms | p95 < 500 ms |
| Ref updated from another linked worktree → visible graph | ~205 ms | p95 < 500 ms |
| Companion watcher: ref change → SSE event (20 changes) | p50 76 ms, p95 78 ms | — |
| Webhook receipt → visible graph (two tabs + an API subscriber) | 90–97 ms | p95 < 1 s |
| Webhook → SSE notification (server only, 20 events) | p95 3.7 ms (109 ms with 50 ms GitHub RTT) | — |
| Ten simultaneous pushes | 1–2 ref re-reads (coalesced) | no duplicate state changes |
| Idle repository traffic (default schedule, one viewer) | ~16 polls/h, ~48 requests/h, ~100% `304` | minimal |
| Graph rows recomputed for a push on top | prefix only (rows spliced at the first matching checkpoint) | no full reload |

`window.__lanesMetrics` (and the "Show Performance Metrics" command) exposes live timings: history page
latency, layout time, refresh time per reason, reused rows, search time, cache timings.
