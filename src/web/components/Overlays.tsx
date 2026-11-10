// Context menu, dialogs, toasts, shortcut help, tooltip and the find widget.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { app, type DialogSpec } from "../app/store.ts";
import { shortcutCommands } from "../app/commands.ts";
import { formatShortcut } from "../app/platform.ts";
import { fuzzyScore } from "./Palette.tsx";
import { formatDate } from "./GraphView.tsx";
import { IconClose, IconDown, IconUp } from "./icons.tsx";
import { WORKING } from "../../core/url/state.ts";

// ---------------------------------------------------------------------------

export function ContextMenu() {
  const m = () => app.menu()!;
  const [active, setActive] = createSignal(-1);
  let el!: HTMLDivElement;
  const enabled = () => m().items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const close = (refocus = true) => {
    const r = m().restore;
    app.setMenu(null);
    if (refocus) requestAnimationFrame(() => (r && document.contains(r) && r !== document.body ? r.focus() : app.focusGraph()));
  };
  onMount(() => {
    // Keep on screen.
    const r = el.getBoundingClientRect();
    const x = Math.min(m().x, window.innerWidth - r.width - 8);
    const y = m().y + r.height > window.innerHeight - 8 ? Math.max(8, m().y - r.height) : m().y;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${y}px`;
    setActive(m().items.findIndex((it) => !it.separator));
    el.focus();
  });
  let typed = "";
  let typedAt = 0;
  const onKey = (e: KeyboardEvent) => {
    const items = m().items;
    const nav = items.map((it, i) => (!it.separator ? i : -1)).filter((i) => i >= 0);
    const pos = nav.indexOf(active());
    if (e.key === "ArrowDown") setActive(nav[(pos + 1) % nav.length]!);
    else if (e.key === "ArrowUp") setActive(nav[(pos - 1 + nav.length) % nav.length]!);
    else if (e.key === "Home") setActive(nav[0]!);
    else if (e.key === "End") setActive(nav[nav.length - 1]!);
    else if (e.key === "Enter" || e.key === " ") {
      const it = items[active()];
      if (it && !it.disabled) {
        close(false);
        it.run?.();
      } else if (it?.disabled) app.toast("info", `${it.label}: unavailable`, it.disabled);
    } else if (e.key === "Escape" || e.key === "Tab" || (e.key === "F10" && e.shiftKey)) close();
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = now;
      const hit = nav.find((i) => items[i]!.label.toLowerCase().startsWith(typed));
      if (hit !== undefined) setActive(hit);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  void enabled;
  return (
    <div class="fixed inset-0 z-50" onMouseDown={(e) => e.target === e.currentTarget && close()} onContextMenu={(e) => (e.preventDefault(), close())}>
      <div ref={el} class="menu fixed outline-none" role="menu" aria-label={m().title ? `Actions for ${m().title}` : "Actions"} tabIndex={-1} onKeyDown={onKey} aria-activedescendant={active() >= 0 ? `mi-${active()}` : undefined}>
        <Show when={m().title}>
          <div class="truncate px-2.5 pb-1 pt-0.5 text-xs opacity-70" aria-hidden="true">
            {m().title}
          </div>
        </Show>
        <For each={m().items}>
          {(it, i) =>
            it.separator ? (
              <div class="menu-sep" role="separator" />
            ) : (
              <div
                id={`mi-${i()}`}
                role="menuitem"
                class="menu-item"
                classList={{ active: active() === i() }}
                aria-disabled={!!it.disabled}
                title={it.disabled ?? undefined}
                onMouseMove={() => setActive(i())}
                onClick={() => {
                  if (it.disabled) return app.toast("info", `${it.label}: unavailable`, it.disabled);
                  close(false);
                  it.run?.();
                }}
              >
                <span class="flex min-w-0 flex-col">
                  <span classList={{ "text-del": !!it.danger && active() !== i() }}>{it.label}</span>
                  <Show when={it.disabled && active() === i()}>
                    <span class="truncate text-xs opacity-80">{it.disabled}</span>
                  </Show>
                </span>
                <Show when={it.shortcut}>
                  <span class="kbd">{formatShortcut(it.shortcut!)}</span>
                </Show>
              </div>
            )
          }
        </For>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Dialog() {
  const d = () => app.dialog() as DialogSpec;
  const [values, setValues] = createSignal<Record<string, string | boolean>>(Object.fromEntries((d().fields ?? []).map((f) => [f.name, f.value ?? (f.type === "checkbox" ? false : f.type === "select" ? (f.options?.[0]?.value ?? "") : "")])));
  let el!: HTMLDivElement;
  onMount(() => {
    const first = el.querySelector<HTMLElement>("input:not([type=checkbox]),textarea,select,input,button[data-primary]");
    (first ?? el).focus();
  });
  const submit = () => {
    for (const f of d().fields ?? []) {
      if (f.required && !String(values()[f.name] ?? "").trim()) {
        el.querySelector<HTMLElement>(`[name="${f.name}"]`)?.focus();
        return;
      }
    }
    d().resolve(values());
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      d().resolve(null);
    } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !(e.metaKey || e.ctrlKey)) && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Tab") {
      // Trap focus inside the dialog.
      const f = [...el.querySelectorAll<HTMLElement>("input,select,textarea,button,[tabindex='0']")].filter((x) => !x.hasAttribute("disabled"));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f[f.length - 1]!.focus();
      } else if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        f[0]!.focus();
      }
      return;
    } else return;
    e.stopPropagation();
  };
  const set = (k: string, v: string | boolean) => setValues({ ...values(), [k]: v });
  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]" style={{ background: "var(--scrim)" }} onKeyDown={onKey}>
      <div ref={el} class="menu w-[520px] max-w-[94vw] p-4" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-desc" tabIndex={-1}>
        <h2 id="dlg-title" class="m-0 mb-2 text-[14px] font-bold">
          {d().title}
        </h2>
        <div id="dlg-desc">
          <Show when={d().message}>
            <p class="m-0 mb-3 whitespace-pre-wrap opacity-90">{d().message}</p>
          </Show>
          <Show when={d().consequence}>
            <div class="mb-3 rounded border border-[var(--del)] p-2 whitespace-pre-wrap" role="alert">
              {d().consequence}
            </div>
          </Show>
        </div>
        <Show when={d().output}>
          {(o) => (
            <div class="mb-3">
              <Show when={o().cwd}>
                <div class="text-xs">
                  <b>Working directory:</b> <span class="mono">{o().cwd}</span>
                </div>
              </Show>
              <Show when={o().args}>
                <div class="text-xs">
                  <b>Command:</b> <span class="mono">{o().args}</span>
                </div>
              </Show>
              <Show when={o().exitCode !== undefined}>
                <div class="text-xs">
                  <b>Exit status:</b> <span classList={{ "text-del": o().exitCode !== 0, "text-add": o().exitCode === 0 }}>{o().exitCode}</span>
                </div>
              </Show>
              <pre class="mono mt-2 max-h-[50vh] overflow-auto rounded border border-[var(--border)] p-2 text-xs whitespace-pre-wrap" tabIndex={0} aria-label="Output">
                {o().text}
              </pre>
            </div>
          )}
        </Show>
        <For each={d().fields ?? []}>
          {(f) => (
            <div class="mb-3">
              <Show when={f.type === "checkbox"}>
                <label class="flex items-center gap-2">
                  <input type="checkbox" class="checkbox" name={f.name} checked={!!values()[f.name]} onChange={(e) => set(f.name, e.currentTarget.checked)} />
                  {f.label}
                </label>
              </Show>
              <Show when={f.type !== "checkbox"}>
                <label class="mb-1 block text-xs font-semibold" for={`fld-${f.name}`}>
                  {f.label}
                  {f.required ? " *" : ""}
                </label>
                <Show when={f.type === "text" || f.type === "readonly"}>
                  <input
                    id={`fld-${f.name}`}
                    name={f.name}
                    class="w-full rounded border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1"
                    value={String(values()[f.name] ?? "")}
                    readOnly={f.type === "readonly"}
                    placeholder={f.placeholder}
                    spellcheck={false}
                    autocomplete="off"
                    onInput={(e) => set(f.name, e.currentTarget.value)}
                    onFocus={(e) => f.type === "readonly" && e.currentTarget.select()}
                  />
                </Show>
                <Show when={f.type === "textarea"}>
                  <textarea
                    id={`fld-${f.name}`}
                    name={f.name}
                    class="mono min-h-[120px] w-full rounded border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1 text-xs"
                    value={String(values()[f.name] ?? "")}
                    placeholder={f.placeholder}
                    onInput={(e) => set(f.name, e.currentTarget.value)}
                  />
                  <div class="text-xs opacity-60">Mod+Enter submits</div>
                </Show>
                <Show when={f.type === "select"}>
                  <select id={`fld-${f.name}`} name={f.name} class="w-full rounded border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1" value={String(values()[f.name] ?? "")} onChange={(e) => set(f.name, e.currentTarget.value)}>
                    <For each={f.options ?? []}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                  </select>
                </Show>
              </Show>
              <Show when={f.help}>
                <div class="text-xs opacity-70">{f.help}</div>
              </Show>
            </div>
          )}
        </For>
        <div class="flex justify-end gap-2">
          <Show when={d().confirmLabel !== "Close" && d().confirmLabel !== "Done"}>
            <button class="rounded border border-[var(--border)] px-3 py-1" onClick={() => d().resolve(null)}>
              Cancel
            </button>
          </Show>
          <button data-primary class="rounded px-3 py-1 text-white" style={{ background: d().danger ? "var(--del)" : "var(--focus)" }} onClick={submit}>
            {d().confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Toasts() {
  return (
    <div class="fixed right-3 bottom-3 z-40 flex w-[380px] max-w-[94vw] flex-col gap-2" aria-live="polite" role="status">
      <For each={app.toasts}>
        {(t) => (
          <div class="menu flex items-start gap-2 p-3" role={t.kind === "error" ? "alert" : "status"} style={{ "border-left": `3px solid ${t.kind === "error" ? "var(--del)" : t.kind === "success" ? "var(--add)" : "var(--focus)"}` }}>
            <div class="min-w-0 flex-1">
              <div class="font-semibold">{t.message}</div>
              <Show when={t.detail}>
                <div class="mt-1 max-h-40 overflow-auto text-xs whitespace-pre-wrap opacity-80">{t.detail}</div>
              </Show>
              <Show when={t.action}>
                <button class="mt-1 text-link underline" onClick={() => t.action!.run()}>
                  {t.action!.label}
                </button>
              </Show>
            </div>
            <button class="icon-btn" aria-label="Dismiss notification (Escape)" onClick={() => app.dismissToast(t.id)}>
              <IconClose />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------------------

const LOCAL_SHORTCUTS: { keys: string; title: string; where: string }[] = [
  { keys: "Tab", title: "Move into the file list (details open)", where: "Details" },
  { keys: "ArrowDown", title: "Next file / ArrowUp previous", where: "Details" },
  { keys: "ArrowLeft", title: "Collapse folder / go to parent", where: "Details" },
  { keys: "Enter", title: "Open diff of the focused file", where: "Details" },
  { keys: "Space", title: "Stage / unstage the focused file", where: "Details (uncommitted)" },
  { keys: "v", title: "Toggle reviewed", where: "Details / Diff" },
  { keys: "n", title: "Next hunk (p previous)", where: "Diff" },
  { keys: "]", title: "Next file ([ previous)", where: "Diff" },
  { keys: "s", title: "Stage / unstage focused hunk", where: "Diff (uncommitted)" },
  { keys: "x", title: "Discard focused hunk (asks first)", where: "Diff (uncommitted)" },
  { keys: "ArrowLeft", title: "Resize focused column divider (ArrowRight wider)", where: "Column divider" },
  { keys: "Mod+Enter", title: "Submit multi-line field / save conflict resolution", where: "Dialogs" },
  { keys: "Shift+F10", title: "Actions for the focused palette item (worktrees)", where: "Palette" },
];

export function Help() {
  const [q, setQ] = createSignal("");
  let input!: HTMLInputElement;
  const restore = document.activeElement as HTMLElement | null;
  const close = () => {
    app.setHelpOpen(false);
    requestAnimationFrame(() => (restore && document.contains(restore) && restore !== document.body ? restore.focus() : app.focusGraph()));
  };
  const rows = createMemo(() => {
    const all = [
      ...shortcutCommands().flatMap((c) => c.shortcuts!.map((s) => ({ keys: s, title: c.title, where: c.category }))),
      ...LOCAL_SHORTCUTS,
    ];
    const query = q().trim();
    if (!query) return all;
    return all.filter((r) => fuzzyScore(query, `${r.title} ${r.where} ${formatShortcut(r.keys)} ${r.keys}`) > 0);
  });
  onMount(() => input.focus());
  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]" style={{ background: "var(--scrim)" }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="menu flex max-h-[80vh] w-[620px] max-w-[94vw] flex-col p-3" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="mb-2 flex items-center gap-2">
          <h2 class="m-0 text-[14px] font-bold">Keyboard shortcuts</h2>
          <input
            ref={input}
            class="ml-auto w-64 rounded border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1"
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
        </div>
        <div class="overflow-auto" role="table" aria-label="Shortcuts">
          <For each={rows()}>
            {(r) => (
              <div class="flex items-center gap-3 border-b border-[var(--border)] py-1" role="row">
                <span class="w-40 flex-none" role="cell">
                  <kbd>{formatShortcut(r.keys)}</kbd>
                </span>
                <span class="flex-1" role="cell">
                  {r.title}
                </span>
                <span class="text-xs opacity-60" role="cell">
                  {r.where}
                </span>
              </div>
            )}
          </For>
        </div>
        <div class="mt-2 text-xs opacity-70">Everything else is in the command palette ({formatShortcut("Mod+Shift+P")} or F1). Browser-reserved shortcuts (new tab, reload, close…) are never captured.</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Tooltip() {
  const t = () => app.tooltip()!;
  const c = () => app.rows.commits[t().row];
  const refs = () => (c() ? (app.refsByCommit().get(c()!.hash) ?? []) : []);
  onCleanup(() => {});
  return (
    <Show when={c()}>
      <div class="tooltip" role="tooltip" id="commit-tooltip" style={{ left: `${Math.min(t().x, window.innerWidth - 430)}px`, top: `${Math.min(t().y, window.innerHeight - 160)}px` }}>
        <Show when={c()!.hash !== WORKING} fallback={<div>{c()!.subject} — not yet committed</div>}>
          <div class="mono">{c()!.hash}</div>
          <div class="font-semibold">{c()!.subject}</div>
          <div>
            {c()!.author.name} &lt;{c()!.author.email}&gt; · {formatDate(c()!.author.date)}
          </div>
          <div>{c()!.parents.length > 1 ? `Merge of ${c()!.parents.length} parents` : c()!.parents.length ? `Parent ${c()!.parents[0]!.slice(0, 8)}` : "Root commit"}</div>
          <Show when={refs().length}>
            <div>Refs: {refs().map((r) => r.short).join(", ")}</div>
          </Show>
          <Show when={c()!.hash === app.headCommit()}>
            <div>This is HEAD</div>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

// ---------------------------------------------------------------------------

export function FindWidget() {
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus();
    input.select();
  });
  createEffect(() => {
    if (app.find.open) requestAnimationFrame(() => input?.focus());
  });
  let t: ReturnType<typeof setTimeout> | null = null;
  return (
    <div class="menu absolute top-1 right-4 z-30 flex items-center gap-1 px-2 py-1" role="search" aria-label="Find commits">
      <input
        ref={input}
        class="w-64 rounded border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-0.5"
        placeholder="Find (message, author, hash, ref)"
        aria-label="Find commits"
        value={app.find.text}
        onInput={(e) => {
          const v = e.currentTarget.value;
          app.setFind("text", v);
          if (t) clearTimeout(t);
          t = setTimeout(() => void app.runFind(v), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") app.findStep(e.shiftKey ? -1 : 1);
          else if (e.key === "Escape") {
            app.setFind("open", false);
            app.focusGraph();
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <span class="w-20 text-center text-xs opacity-80" aria-live="polite">
        {app.find.text ? (app.find.matches.length ? `${app.find.current + 1} of ${app.find.matches.length}` : "No results") : ""}
      </span>
      <button class="icon-btn" aria-label="Previous match (Shift+Enter)" onClick={() => app.findStep(-1)}>
        <IconUp />
      </button>
      <button class="icon-btn" aria-label="Next match (Enter)" onClick={() => app.findStep(1)}>
        <IconDown />
      </button>
      <button
        class="icon-btn"
        aria-label="Close find (Escape)"
        onClick={() => {
          app.setFind("open", false);
          app.focusGraph();
        }}
      >
        <IconClose />
      </button>
    </div>
  );
}
