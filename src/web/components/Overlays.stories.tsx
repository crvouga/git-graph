// Overlays shown over the app shell: palette, context menus, dialogs, toasts, help and tooltips.
// They are driven by store state, so each story opens the fixture and then sets that state.

import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect } from "storybook/test";
import { AppShell } from "../App.tsx";
import { openContextMenuForFocus } from "../app/commands.ts";
import { app } from "../app/store.ts";
import { commits, Frame, openFixture, rowOf } from "../storybook/harness.tsx";

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
type Story = StoryObj<typeof meta>;

// ------------------------------------------------------------------ palette

export const CommandPalette: Story = {
  beforeEach: async () => {
    await openFixture();
    app.setPaletteOpen({ mode: "commands" });
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("dialog", { name: "Command palette" })).toBeVisible();
  },
};

export const CommandPaletteFiltered: Story = {
  beforeEach: async () => {
    await openFixture();
    app.setPaletteOpen({ mode: "commands", initial: "toggle" });
  },
};

/** Mutations are unavailable for a read-only folder; the palette says why. */
export const CommandPaletteUnavailableCommand: Story = {
  beforeEach: async () => {
    await openFixture();
    app.setPaletteOpen({ mode: "commands", initial: "create branch" });
  },
};

export const BranchFilter: Story = {
  beforeEach: async () => {
    await openFixture();
    app.setPaletteOpen({ mode: "branches" });
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("dialog", { name: "Branch filter" })).toBeVisible();
  },
};

export const OpenRepository: Story = {
  beforeEach: async () => {
    await openFixture();
    app.setPaletteOpen({ mode: "repos" });
  },
};

// ------------------------------------------------------------------ context menus

export const CommitMenu: Story = {
  beforeEach: () => openFixture(),
  play: async ({ canvas }) => {
    app.setKbRow(rowOf(commits["Start develop"]));
    openContextMenuForFocus();
    await expect(await canvas.findByRole("menu")).toBeVisible();
  },
};

export const BranchMenu: Story = {
  beforeEach: () => openFixture(),
  play: async ({ canvas }) => {
    app.setKbRow(rowOf(commits["Document usage"]));
    app.setRefCursor(0);
    openContextMenuForFocus();
    await expect(await canvas.findByRole("menu")).toBeVisible();
  },
};

// ------------------------------------------------------------------ dialogs

export const FormDialog: Story = {
  beforeEach: async () => {
    await openFixture();
    void app.ask({
      title: "Create Branch",
      message: `At commit ${commits["Add sub()"].slice(0, 8)}: Add sub()`,
      fields: [
        { name: "name", label: "Branch name", type: "text", required: true, placeholder: "feature/…" },
        { name: "checkout", label: "Check out after creating", type: "checkbox", value: true },
        { name: "from", label: "Start point", type: "select", value: "main", options: [{ value: "main", label: "main" }, { value: "develop", label: "develop" }] },
      ],
      confirmLabel: "Create Branch",
    });
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("alertdialog")).toBeVisible();
  },
};

export const DestructiveDialog: Story = {
  beforeEach: async () => {
    await openFixture();
    void app.ask({
      title: "Delete Branch",
      message: "Delete the branch conflict-a?",
      consequence: "conflict-a points at 22a9867a, which is not merged into any other branch. Its commit will become unreachable.",
      fields: [{ name: "force", label: "Force delete (not merged)", type: "checkbox", value: false }],
      confirmLabel: "Delete",
      danger: true,
    });
  },
};

export const CommandOutputDialog: Story = {
  beforeEach: async () => {
    await openFixture();
    void app.ask({
      title: "Run Git Command",
      output: { cwd: "/home/me/src/lanes", args: "git status --short", exitCode: 0, text: " M README.md\n M src/main.ts\n?? notes with space.txt\n" },
      confirmLabel: "Close",
    });
  },
};

// ------------------------------------------------------------------ notifications and help

export const Toasts: Story = {
  beforeEach: async () => {
    await openFixture();
    app.toast("success", "Created branch feature/x");
    app.toast("info", "Fetched origin", "2 branches updated");
    app.toast("error", "Could not push main", "! [rejected] main -> main (fetch first)\nUpdates were rejected because the remote contains work that you do not have locally.", { label: "Fetch and retry", run: () => {} });
  },
};

export const KeyboardShortcuts: Story = {
  beforeEach: async () => {
    await openFixture();
    app.setHelpOpen(true);
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  },
};

export const CommitTooltip: Story = {
  beforeEach: () => openFixture(),
  play: async () => {
    app.setTooltip({ x: 320, y: 330, row: rowOf(commits["Merge branch 'feature/auth' into develop"]) });
  },
};
