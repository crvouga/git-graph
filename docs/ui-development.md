# UI development

All UI work happens in Storybook. Stories render the real components against the real store and
the real graph engine, reading a real git repository, so what you see in a story is what users see.

```bash
pnpm storybook          # http://127.0.0.1:6006 (also serves the Storybook MCP at /mcp)
pnpm test:storybook     # every story as a browser test: renders, play functions pass
pnpm ui:compare         # before/after screenshots against origin/main
pnpm ui:publish --pr N  # put them in pull request N's description
```

## The loop

1. **Start Storybook** (`pnpm storybook`) and open the story for the UI you are changing. If no
   story shows the state you need, **write the story first**: it is the "before".
2. **Change the component** with Storybook open (hot reload). Check both themes (toolbar) and the
   Accessibility panel.
3. **Cover the new state** with a story. Add a `play` function when behaviour matters (keyboard,
   focus, something appearing); `pnpm test:storybook` runs it.
4. **Compare**: `pnpm ui:compare` builds Storybook at the base commit and at your working tree,
   screenshots every story in dark and light, and writes `.ui-shots/compare/*.png`
   (Before | After | Diff) plus `.ui-shots/report.md`. Look at every changed image. Unexpected
   changes are regressions.
5. **Publish**: after opening the pull request, `pnpm ui:publish --pr <number>` adds the
   before/after section to its description. Re-run both commands after further UI changes.

`pnpm ui:compare --stories overlays,controlbar` limits the run to story ids containing those words;
`--base HEAD` compares against the last commit. `pnpm ui:shots --url http://127.0.0.1:6006 --stories x`
takes plain screenshots from the running Storybook (quick look without a build).

## Where things are

| Path | What |
|---|---|
| `.storybook/main.ts`, `preview.tsx` | Config. Reuses `vite.config.ts` (Solid + Tailwind) and `styles.css`. |
| `src/web/**/*.stories.tsx` | Stories, next to their component. |
| `src/web/storybook/harness.tsx` | `openFixture()`, `openHome()`, `Frame`, `commits`, `rowOf()`, `freezeEngine()`. |
| `scripts/storybook-fixture.ts` | Builds the fixture repository (the e2e "basic" repo) stories browse. |
| `scripts/ui-shots.ts`, `ui-compare.ts`, `ui-publish.ts` | Screenshot, compare, publish. |

## Writing stories

Components read the global store (`src/web/app/store.ts`), so a story sets store state in
`beforeEach` and renders the component:

```tsx
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, within } from "storybook/test";
import { AppShell } from "../App.tsx";
import { app } from "../app/store.ts";
import { commits, Frame, openFixture } from "../storybook/harness.tsx";

const meta = {
  title: "Overlays",
  component: AppShell,
  render: () => (
    <Frame>
      <AppShell />
    </Frame>
  ),
} satisfies Meta<typeof AppShell>;
export default meta;

export const CommitDetails: StoryObj<typeof meta> = {
  // Any URL state: commit, compare, view, file, branches, display…
  beforeEach: () => openFixture({ commit: commits["Add logout"], view: "details" }),
  play: async ({ canvas }) => {
    const details = await canvas.findByRole("region", { name: "Commit details" });
    await expect(await within(details).findByText("auth.ts")).toBeVisible();
  },
};

export const Toast: StoryObj<typeof meta> = {
  beforeEach: async () => {
    await openFixture();
    app.toast("error", "Could not push main", "rejected");
  },
};
```

- `openFixture(view)` opens the fixture repository at a URL state and waits for the graph;
  `openHome()` shows the start screen. Both close every overlay first, so stories never leak.
- Pure components (`RefBadge`) take `args` instead and get Controls for free.
- Overlays that measure the DOM (context menus, tooltips) are opened in `play`, after render.
- To pin state the engine would otherwise update (sync status), call `freezeEngine()` first.
- Small components: wrap in `<Frame height={…}>`; screenshots are cropped to the story.
- Wait for content with `findBy…` in `play`: screenshots are taken once `play` finishes.
- Tag a story `tags: ["no-screenshot"]` only if it can never be stable.

The fixture is read-only (the browser git reader), so working-tree states (staging, conflicts)
come from setting `app.setRepo("status", …)` rather than from the repository.

Storybook runs with `import.meta.env.LANES_STORYBOOK` set (`src/web/app/env.ts`): the URL lives in
memory (`src/web/app/address.ts`) and saved preferences are ignored, so every story starts from
the defaults whatever the browser stored.

## Screenshots are deterministic

The fixture repository is byte-for-byte reproducible (fixed dates and authors), and screenshots
use a 1200×720 viewport, UTC, en-US, a fixed clock and no animations. Two runs of the same code
produce identical pixels, so any difference in `ui:compare` comes from the change.

## Agents

- Register the Storybook MCP (`.mcp.json`, `http://localhost:6006/mcp`, needs `pnpm storybook`
  running): `stories-find-by-component`, `stories-preview`, `docs-show`, `test-run`, and
  `get-storybook-story-instructions` before writing stories.
- Show the user the before/after images from `.ui-shots/compare/` (absolute paths) in your reply,
  and publish them to the pull request with `pnpm ui:publish`.

## CI

The **Storybook** job runs `pnpm test:storybook` and screenshots every story (failing on render
errors). On pull requests it runs `pnpm ui:compare` against the base branch and uploads
`.ui-shots/` as the `ui-shots` artifact.
