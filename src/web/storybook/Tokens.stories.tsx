// The theme tokens from styles.css. Use these variables in components; never hard-code colors.

import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For } from "solid-js";
import { PALETTE } from "../components/GraphView.tsx";

const TOKENS = {
  Surface: ["--bg", "--panel", "--panel-2", "--menu-bg", "--input-bg", "--hover", "--selected", "--selected-strong", "--scrim"],
  Text: ["--fg", "--fg-dim", "--fg-muted", "--link"],
  Lines: ["--border", "--header-border", "--input-border", "--badge-border", "--focus"],
  Status: ["--add", "--del", "--warn", "--add-bg", "--del-bg", "--file-added", "--file-modified", "--file-deleted", "--file-renamed"],
};

const meta = { title: "Foundations/Tokens", parameters: { layout: "padded" } } satisfies Meta;
export default meta;

function Swatch(p: { name: string; value: string }) {
  return (
    <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
      <div style={{ width: "36px", height: "24px", background: p.value, border: "1px solid var(--border)", "border-radius": "3px" }} />
      <span class="mono" style={{ "font-size": "12px" }}>
        {p.name}
      </span>
    </div>
  );
}

export const Colors: StoryObj = {
  render: () => (
    <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fill, minmax(260px, 1fr))", gap: "20px", color: "var(--fg)" }}>
      <For each={Object.entries(TOKENS)}>
        {([group, names]) => (
          <section>
            <h3 style={{ margin: "0 0 8px", "font-size": "13px" }}>{group}</h3>
            <div style={{ display: "grid", gap: "6px" }}>
              <For each={names}>{(n) => <Swatch name={n} value={`var(${n})`} />}</For>
            </div>
          </section>
        )}
      </For>
    </div>
  ),
};

export const LanePalette: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: "6px", color: "var(--fg)" }}>
      <For each={PALETTE}>{(c, i) => <Swatch name={`lane ${i()} · ${c}`} value={c} />}</For>
    </div>
  ),
};

export const Typography: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: "8px", color: "var(--fg)" }}>
      <div style={{ "font-size": "18px", "font-weight": 700 }}>Heading 18 bold — Open a repository</div>
      <div>Body 13 — The default UI size (var(--font)).</div>
      <div style={{ opacity: 0.75 }}>Secondary 13 at 75% opacity</div>
      <div class="text-xs opacity-60">Caption 12 at 60% opacity</div>
      <div class="mono">Mono — 788aca456dfcb0341087203dba391af1f6ef4781 (var(--mono))</div>
    </div>
  ),
};
