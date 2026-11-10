// The whole application shell, rendered against the fixture repository (see storybook/harness.tsx).
// Each story is a URL state of the app; interaction stories drive it with the keyboard.

import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AppShell } from "./App.tsx";
import { app } from "./app/store.ts";
import { commits, Frame, freezeEngine, openFixture, openHome, setSession } from "./storybook/harness.tsx";

const meta = {
  title: "App/Shell",
  component: AppShell,
  render: () => (
    <Frame>
      <AppShell />
    </Frame>
  ),
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Home: Story = {
  beforeEach: () => openHome(),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Open a repository" })).toBeVisible();
  },
};

/** On a Lanes server: sign in first (Google, through the auth relay). */
export const HomeSignedOut: Story = {
  beforeEach: async () => {
    await openHome();
    setSession("signed-out");
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findAllByRole("button", { name: /^Sign in$/ })).not.toHaveLength(0);
  },
};

/** Signed in: connect GitHub next, for private repositories and live updates. */
export const HomeSignedInConnectGitHub: Story = {
  beforeEach: async () => {
    await openHome();
    setSession("signed-in");
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findAllByRole("button", { name: "Connect GitHub" })).toHaveLength(2); // control bar + home
  },
};

export const HomeWithRecents: Story = {
  beforeEach: async () => {
    await openHome();
    app.rememberRecent({ key: "github:solidjs:solid", name: "solidjs/solid", at: 1 });
    app.rememberRecent({ key: "local:abc123", name: "lanes", path: "/home/me/src/lanes", at: 2 });
  },
};

export const Graph: Story = {
  beforeEach: () => openFixture(),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("grid")).toBeVisible();
    await expect(canvas.getByText("Merge branch 'feature/auth' into develop")).toBeVisible();
  },
};

export const BranchFilter: Story = { beforeEach: () => openFixture({ branches: ["develop"] }) };
export const FirstParentHistory: Story = { beforeEach: () => openFixture({ display: { firstParent: true } }) };
export const WithoutRemotesOrTags: Story = { beforeEach: () => openFixture({ display: { remotes: false, tags: false } }) };

export const CommitDetails: Story = {
  beforeEach: () => openFixture({ commit: commits["Add logout"], view: "details" }),
  play: async ({ canvas }) => {
    const details = await canvas.findByRole("region", { name: "Commit details" });
    await expect(await within(details).findByText("auth.ts")).toBeVisible();
  },
};

export const MergeCommitDetails: Story = {
  beforeEach: () => openFixture({ commit: commits["Merge branch 'feature/auth' into develop"], view: "details" }),
  play: async ({ canvas }) => {
    await canvas.findByRole("region", { name: "Commit details" });
  },
};

export const RenameAndBinaryChanges: Story = {
  beforeEach: () => openFixture({ commit: commits["Remove old docs and update logo"], view: "details" }),
  play: async ({ canvas }) => {
    const details = await canvas.findByRole("region", { name: "Commit details" });
    await within(details).findByText("logo.bin");
  },
};

export const CompareCommits: Story = {
  beforeEach: () => openFixture({ commit: commits["Add sub()"], compare: commits["Add util module"], view: "details" }),
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: "Commit comparison" });
    await within(region).findByText("util.ts");
  },
};

export const FileDiff: Story = {
  beforeEach: () => openFixture({ commit: commits["Add sub()"], view: "diff", file: "src/util.ts" }),
  play: async ({ canvas }) => {
    const diff = await canvas.findByTestId("diff-view");
    await within(diff).findAllByText(/sub\(a: number, b: number\)/);
  },
};

export const FindInGraph: Story = {
  beforeEach: async () => {
    await openFixture();
    app.setFind("open", true);
    await app.runFind("auth");
  },
};

export const MissingBranch: Story = {
  beforeEach: () => openFixture({ branches: ["feature/deleted"] }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Not found in this repository/)).toBeVisible();
  },
};

export const RepositoryUnavailable: Story = {
  beforeEach: () => openFixture({}, { repo: { provider: "browser", id: "forgotten-folder" } }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Repository not found")).toBeVisible();
  },
};

export const MergeInProgress: Story = {
  beforeEach: async () => {
    await openFixture();
    await freezeEngine();
    app.setRepo("status", {
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [{ path: "conflict.txt", status: "M" }],
      operation: { kind: "merge" },
    });
  },
};

/** Keyboard-first: arrow to a commit, Enter opens details, Escape closes them. */
export const KeyboardNavigation: Story = {
  beforeEach: () => openFixture(),
  play: async ({ canvas, step }) => {
    const grid = canvas.getByRole("grid");
    grid.focus();
    await step("Move to the third commit and open it", async () => {
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
      await expect(await canvas.findByRole("region", { name: "Commit details" })).toBeVisible();
    });
    await step("Escape closes the details", async () => {
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(canvas.queryByRole("region", { name: "Commit details" })).toBeNull());
    });
  },
};
