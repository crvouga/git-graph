import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { app } from "../app/store.ts";
import type { SyncInfo } from "../engine/protocol.ts";
import { Frame, freezeEngine, openFixture, openHome } from "../storybook/harness.tsx";
import { ControlBar } from "./ControlBar.tsx";

const meta = {
  title: "Components/ControlBar",
  component: ControlBar,
  render: () => (
    <Frame height={48}>
      <ControlBar />
    </Frame>
  ),
} satisfies Meta<typeof ControlBar>;
export default meta;
type Story = StoryObj<typeof meta>;

const sync = (s: Partial<SyncInfo>): SyncInfo => ({ connection: "live", lastSuccessAt: Date.now(), lastError: null, stale: false, fromCache: false, refsVersion: "v1", pending: 0, leader: true, ...s });

/** Opens the fixture, stops engine updates and pins the sync indicator. */
const withSync = (s: Partial<SyncInfo> | null) => async () => {
  await openFixture();
  await freezeEngine();
  app.setRepo("sync", s ? sync(s) : null);
};

export const NoRepository: Story = { beforeEach: () => openHome() };
export const Live: Story = { beforeEach: withSync({ connection: "live" }) };
export const Polling: Story = { beforeEach: withSync({ connection: "polling" }) };
export const CachedCheckingForChanges: Story = { beforeEach: withSync({ fromCache: true, stale: true }) };
export const SyncProblem: Story = { beforeEach: withSync({ connection: "polling", lastError: "HTTP 502 from api.github.com" }) };
export const Offline: Story = { beforeEach: withSync({ connection: "offline", lastError: "Network unreachable" }) };
export const FilteredToOneBranch: Story = { beforeEach: () => openFixture({ branches: ["develop"] }) };
export const FilteredToSeveralBranches: Story = { beforeEach: () => openFixture({ branches: ["develop", "main", "feature/auth"] }) };
