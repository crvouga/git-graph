import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { Ref } from "../../core/types.ts";
import { laneColor, RefBadge } from "./GraphView.tsx";

const ref = (r: Partial<Ref> & Pick<Ref, "kind" | "short">): Ref => ({ name: `refs/heads/${r.short}`, target: "0".repeat(40), commit: "0".repeat(40), ...r });

const meta = {
  title: "Components/RefBadge",
  component: RefBadge,
  parameters: { layout: "padded" },
  render: (args) => (
    <div style={{ display: "flex", "align-items": "center", gap: "6px", height: "24px" }}>
      <RefBadge {...args} />
    </div>
  ),
  args: { r: ref({ kind: "head", short: "main" }), color: laneColor(0), focused: false, index: 0, remotes: [], head: false },
  argTypes: { color: { control: "color" } },
} satisfies Meta<typeof RefBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Branch: Story = {};
export const CheckedOut: Story = { args: { head: true } };
export const TrackedOnRemote: Story = { args: { remotes: ["origin"] } };
export const RemoteBranch: Story = { args: { r: ref({ kind: "remote", short: "origin/hotfix/urgent", remote: "origin" }), color: laneColor(1) } };
export const Tag: Story = { args: { r: ref({ kind: "tag", short: "v1.0", message: "Release 1.0" }), color: laneColor(2) } };
export const Stash: Story = { args: { r: ref({ kind: "stash", short: "stash@{0}" }), color: laneColor(3) } };
export const Focused: Story = { args: { focused: true } };
export const CheckedOutInWorktree: Story = { args: { r: ref({ kind: "head", short: "feature/auth", checkedOutAt: "../wt-feature" }), color: laneColor(4) } };

/** Every lane color, in order. */
export const LaneColors: Story = {
  render: () => (
    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
      {Array.from({ length: 12 }, (_, i) => (
        <RefBadge r={ref({ kind: "head", short: `lane-${i}` })} color={laneColor(i)} focused={false} index={i} remotes={[]} head={false} />
      ))}
    </div>
  ),
};
