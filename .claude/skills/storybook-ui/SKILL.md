---
name: storybook-ui
description: Required workflow for any change to the web UI in src/web (components, styles, layout, overlays, copy). Develop in Storybook, add stories, and produce before/after screenshots for the user and the pull request.
---

# UI changes go through Storybook

Read `docs/ui-development.md` once per session; it has the harness API and examples.

1. `pnpm storybook` (background). Use the `storybook` MCP server from `.mcp.json`
   (`stories-find-by-component`, `stories-preview`, `get-storybook-story-instructions`) to find the
   story for the UI you are changing. If none shows the state, write it first.
2. Make the change. Add or update stories (`src/web/**/*.stories.tsx`) for every new or changed
   state, with `play` assertions for behaviour. `pnpm test:storybook` must pass.
3. `pnpm ui:compare` (add `--stories <words>` while iterating). Read every image in
   `.ui-shots/compare/` and check for unintended changes. Embed the before/after images in your reply
   using their absolute paths.
4. After opening the PR: `pnpm ui:publish --pr <number>`. Re-run steps 3–4 after further UI changes.
