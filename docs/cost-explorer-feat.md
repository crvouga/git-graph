# Build: CI cost explorer with what-if projections and budgets

## Context
We have a local-first web app that shows git graphs. Add a CI cost feature to it,
starting with GitHub Actions. Users should be able to:
1. See what CI costs today, broken down by workflow, job, trigger, runner, branch and PR.
2. Turn jobs on or off per trigger (for example, "don't run `e2e` on `pull_request`,
   only on `merge_group`") and see the projected monthly cost change right away.
3. Set budgets and see when the current setup or a scenario is projected to go over.

Repo/stack notes: [path to repo, framework, local storage layer, e.g. IndexedDB/SQLite/etc.]
Target repos to test against: [org/repo]

## Before writing code
- Read the codebase and follow its patterns: how data is synced and stored locally, how the
  git graph gets its data, state management, routing, components, tests. Reuse what exists.
  Don't add a parallel architecture.
- Write a short plan (data model, sync, cost engine, UI, integration points) and stop for
  my review before you implement.

## Keep it local-first
- All data and calculations stay on the user's machine. No backend unless the app already has one.
- The GitHub token goes wherever the app already keeps credentials. It is never logged or exported.
- Sync is incremental and can resume: store a cursor per repo, respect rate limits (back off
  using the `x-ratelimit-*` headers), and work offline against cached data.

## Data to collect (GitHub REST API)
- Workflow runs: `GET /repos/{o}/{r}/actions/runs` (event, head_sha, head_branch,
  pull_requests, run_attempt, conclusion, created_at). Default to 90 days back; make it
  configurable.
- Jobs for each run: `GET .../actions/runs/{id}/jobs?filter=all` (name, started_at,
  completed_at, conclusion, labels, runner_name, runner_group_name).
- Workflow files: fetch and parse the YAML at the default branch to list
  workflow × job × trigger, including `paths` / `paths-ignore`, `branches`, job-level `if:`,
  matrix expansion, `needs`, and reusable workflows (`uses:`).
- Required checks: branch protection and rulesets, so we can warn when a scenario turns off
  a job that is a required status check.
- Optional, admin only: org billing usage endpoints, to reconcile our estimate against
  GitHub's actual billed numbers. Degrade gracefully when access is denied.

## Cost engine (pure, fully unit-tested, kept separate from the UI)
- Cost of a job = ceil(billed minutes) × rate for its runner. Billing rounds up per job.
- Runner rates live in an editable table (OS, size, architecture, GPU, larger runners,
  self-hosted at a user-set $/min, defaulting to 0). Fill defaults from GitHub's current
  pricing docs and store a "last verified" date. Don't hardcode prices from memory.
- Support included free minutes and plan allowance as a setting.
- Edge cases: re-runs (each attempt costs money), cancelled jobs (bill elapsed time),
  skipped jobs (0), matrix legs (each leg is its own job), queued time (not billed).
- Baseline per job × trigger, computed from history: runs per week, p50/p90 billed
  minutes, the share of triggers where the job actually ran (this captures path filters
  and `if:`), and the re-run rate.
- A scenario is a set of overrides on that baseline: turn a job × trigger on or off, move
  a job to another trigger, change the runner type, change duration (e.g. "with caching
  −30%"), change how often it runs (PR volume growth %), or limit it to certain paths.
- Projection: monthly cost for the next N months with a confidence band from historical
  variance (p50–p90). A scenario's output is a diff against baseline in $ and minutes.
- Turning a job off has knock-on effects: jobs that `needs:` it may not run either. Model
  that, or at least flag it.

## Budgets
- Budgets can be scoped to the whole account, a repo, a workflow, or a trigger, per month.
- Show actual month-to-date spend, the projected month-end figure, and the projected date
  the budget is exceeded (for baseline and for each scenario).
- Show alerts in the app at configurable thresholds (e.g. 50/80/100%). Local only.

## UI
- **Overview:** spend over time, stacked by workflow, with a toggle to stack by trigger instead.
- **Job × trigger matrix:** each cell shows $/month, runs/month and average minutes, plus
  a checkbox to turn it on or off. Toggling updates the totals and the projection
  immediately, with a visible delta ("−$412/mo, −18%"). Badge the required checks and warn
  before they are turned off.
- **Projection chart:** baseline vs scenario lines, a budget line, and the confidence band.
- **Scenarios:** save, name, duplicate and compare side by side; export and import as JSON.
- **Bonus:** for a saved scenario, generate the suggested workflow YAML changes as a diff.
- **Git graph integration:** overlay CI cost on commits and branches (cost per commit, per
  PR, per branch lifetime). Clicking a commit shows its runs and jobs with cost. A heatmap
  mode highlights expensive commits and branches. Hook into the graph's existing data and
  rendering layer.

## Quality bar
- Unit tests for the cost engine: rounding, matrix, re-runs, cancelled/skipped jobs,
  toggles, `needs` knock-on, projections, budget crossing date.
- Fixture tests for workflow YAML parsing (path filters, matrix, reusable workflows,
  multiple triggers).
- A small fixture dataset so the feature can be demoed without a token.
- Performance: handle 50k+ jobs; scenario recalculation stays under 100ms (aggregate
  ahead of time, keep the math off the render path).
- Accessible charts and tables; works in dark and light themes if the app supports both.

## Delivery
Ship in phases, each one working on its own:
1. Sync and storage, plus the cost engine and its tests.
2. Overview and the job × trigger matrix with toggles.
3. Projections, scenarios and budgets.
4. Git graph overlay.
5. Optional extras: YAML diff export, billing reconciliation.

At the end of each phase, report what works, what is stubbed, and any assumptions made
about pricing or billing rules.
