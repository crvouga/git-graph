# Visual parity with Git Graph

Reference: mhutchie.git-graph **1.30.0**, VS Code dark theme variables (Dark+ values injected), system UI
font 13px, 1200×640 viewport, device scale 1, fixture `makeBasic()` (diverging branches, merge, three refs
on one commit, stash, staged/unstaged/untracked changes, remote-only branch, orphan branch, two worktrees).

## How the reference is captured

`scripts/parity/run.cjs` runs the extension's own host code (`out/gitGraphView.js` with its real Git
`DataSource`) under Node with a stub `vscode` module, and renders its webview bundle in headless Chromium
at the same viewport. Nothing from the extension is copied into this repository or its builds; the script
loads the user's installed copy. Five states are captured for both apps: default graph, expanded commit,
two-commit comparison, branch filter dropdown and commit context menu.

```bash
PW_PATH=$PWD/node_modules/@playwright/test node scripts/parity/run.cjs \
  ~/.vscode/extensions/mhutchie.git-graph-1.30.0 "$PWD/.fixtures/basic" /tmp/parity 1200 640 1
```

## Result

After the comparison these differences were fixed: lane color reuse (a color freed on the previous row is
reusable), 16 px lane offset and graph-column width, `origin/HEAD` label, solid grey line from uncommitted
changes, neutral selection colors, Git Graph file-status colors and `( +n | -m )` stats, "Displaying all
changes from … to …" comparison text, anchored "Filter Branches..." dropdown, Git Graph's context-menu
grouping/order, and column widths. Lanes and colors now match the reference row for row on the fixture.

Intentional differences: a "Repo:" selector is always shown (the web app has no workspace folder list);
context menus show the target, shortcuts and disabled reasons; a sync indicator and sign-in button sit
with the right-hand icons; details headers link both parents in full.
