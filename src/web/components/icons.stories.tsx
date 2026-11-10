import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For } from "solid-js";
import * as icons from "./icons.tsx";

const meta = { title: "Foundations/Icons", parameters: { layout: "padded" } } satisfies Meta;
export default meta;

/** Every icon in src/web/components/icons.tsx, at the size the UI uses. */
export const All: StoryObj = {
  render: () => (
    <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fill, minmax(120px, 1fr))", gap: "12px", color: "var(--fg)" }}>
      <For each={Object.entries(icons)}>
        {([name, Icon]) => (
          <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "8px", border: "1px solid var(--border)", "border-radius": "4px" }}>
            <Icon />
            <span class="mono" style={{ "font-size": "11px" }}>
              {name}
            </span>
          </div>
        )}
      </For>
    </div>
  ),
};
