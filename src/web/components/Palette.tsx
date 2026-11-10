// Fuzzy command palette. Modes: commands, repositories, branch filter, worktrees.
// Every item shows its target, shortcut and (when disabled) the reason.

import { createEffect, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { AppError, type RepoInfo, type Worktree } from "../../core/types.ts";
import { parseGitHubInput } from "../../core/url/state.ts";
import { app } from "../app/store.ts";
import { commandAvailability, commandTarget, commandTitle, currentContext, executeRemote, invoke, invokeMutation, openGitHubInput, openMenu, openWorktreePath, paletteCommands, portCall } from "../app/commands.ts";
import { formatShortcut } from "../app/platform.ts";

export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - t.length * 0.01 + (direct === 0 || t[direct - 1] === " " ? 50 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    score += i === prev + 1 ? 8 : i === 0 || t[i - 1] === " " || t[i - 1] === "." || t[i - 1] === "/" ? 6 : 1;
    prev = i;
    ti = i + 1;
  }
  return score - t.length * 0.01;
}

interface Item {
  key: string;
  label: string;
  detail?: string;
  hint?: string;
  shortcut?: string;
  disabled?: string | null;
  checked?: boolean;
  run: () => void | Promise<void>;
  menu?: () => void;
}

export function Palette() {
  const mode = () => (app.paletteOpen() || { mode: "commands" }).mode ?? "commands";
  const [q, setQ] = createSignal((app.paletteOpen() || {}).initial ?? "");
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;
  let listEl!: HTMLDivElement;
  const ctx = currentContext();
  const restore = document.activeElement as HTMLElement | null;

  const close = (refocus = true) => {
    app.setPaletteOpen(false);
    if (refocus) requestAnimationFrame(() => (restore && document.contains(restore) && restore !== document.body ? restore.focus() : app.focusGraph()));
  };

  const [ghRepos] = createResource(
    () => (mode() === "repos" && app.auth.authenticated ? q() : null),
    async (query) => {
      const res = await fetch(`/api/v1/repositories?limit=30${query ? `&query=${encodeURIComponent(query)}` : ""}`, { credentials: "include" });
      return res.ok ? ((await res.json()) as RepoInfo[]) : [];
    },
  );
  const [worktrees] = createResource(
    () => (mode() === "worktrees" ? app.sessionId() : null),
    () => portCall<Worktree[]>("worktrees", []),
  );

  const items = createMemo<Item[]>(() => {
    const m = mode();
    if (m === "commands") {
      return paletteCommands().map((cmd) => {
        const av = commandAvailability(cmd, ctx);
        const target = commandTarget(cmd, ctx);
        return {
          key: cmd.id,
          label: `${cmd.category}: ${commandTitle(cmd, ctx)}`,
          detail: target ? `on ${target}` : cmd.description,
          shortcut: cmd.shortcuts?.[0],
          disabled: av.enabled ? null : (av.reason ?? "Unavailable"),
          hint: cmd.destructive ? "asks for confirmation" : undefined,
          run: () => {
            close(false);
            void (cmd.kind === "mutation" ? invokeMutation(cmd.id, ctx) : invoke(cmd.id, ctx));
          },
        };
      });
    }
    if (m === "repos") {
      const out: Item[] = [];
      const text = q().trim();
      const gh = text ? parseGitHubInput(text) : null;
      if (gh) {
        out.push({ key: "gh-open", label: `Open GitHub repository ${gh.repo.provider === "github" ? `${gh.repo.owner}/${gh.repo.name}` : ""}`, detail: text, run: () => { close(false); openGitHubInput(text); } });
      }
      if (text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:\\/.test(text) || text === ".") {
        out.push({
          key: "local-open",
          label: `Open local path ${text}`,
          detail: app.companion().token ? "via the git-graph companion" : undefined,
          disabled: app.companion().token ? null : "Connect the local companion first (run `git-graph open <path>` or use “Connect Local Companion…”)",
          run: () => (close(false), void openLocalPath(text)),
        });
      }
      for (const r of app.recents()) {
        out.push({
          key: `recent:${r.key}`,
          label: r.name,
          detail: r.path ?? r.key,
          hint: "recent",
          run: () => {
            close(false);
            const [provider, ...rest] = r.key.split(":");
            const repo = provider === "github" ? { provider: "github" as const, owner: rest[0]!, name: rest[1]! } : { provider: provider as "local" | "browser", id: rest[0]! };
            app.navigate({ ...app.view(), repo, branches: [], focusBranch: null, commit: null, compare: null, selected: [], view: "graph", file: null, at: null, worktree: null });
          },
        });
      }
      for (const r of ghRepos() ?? []) {
        if (out.some((x) => x.key === `recent:${r.key}`)) continue;
        out.push({ key: `gh:${r.key}`, label: r.name, detail: r.description, hint: r.visibility, run: () => { close(false); openGitHubInput(r.name); } });
      }
      out.push({ key: "folder", label: "Open Folder in Browser (read-only)…", detail: "File System Access API", run: () => (close(false), void invoke("repo.openFolder")) });
      out.push({ key: "companion", label: "Connect Local Companion…", detail: "full Git via `git-graph serve`", run: () => (close(false), void invoke("companion.connect")) });
      return out;
    }
    if (m === "branches") {
      const v = app.view();
      const refs = (app.repo.refs?.refs ?? []).filter((r) => r.kind === "head" || (r.kind === "remote" && v.display.remotes && !r.symbolicTarget));
      const out: Item[] = [
        {
          key: "all",
          label: "Show All",
          checked: v.branches.length === 0,
          run: () => app.navigate({ branches: [], focusBranch: null }),
        },
      ];
      for (const r of refs) {
        const on = v.branches.includes(r.short);
        out.push({
          key: r.name,
          label: r.short,
          detail: r.kind === "remote" ? "remote" : r.short === app.headBranch() ? "checked out" : r.checkedOutAt ? `in worktree ${r.checkedOutAt}` : undefined,
          checked: on,
          run: () => app.navigate({ branches: on ? v.branches.filter((b) => b !== r.short) : [...v.branches, r.short] }),
        });
      }
      return out;
    }
    // worktrees
    return (worktrees() ?? []).map((w) => ({
      key: w.path,
      label: w.path,
      detail: `${w.branch ? w.branch.replace(/^refs\/heads\//, "") : w.detached ? `detached at ${w.head?.slice(0, 8)}` : "bare"}${w.isMain ? " · main worktree" : ""}${w.locked ? ` · locked${w.lockReason ? `: ${w.lockReason}` : ""}` : ""}${w.prunable ? " · prunable" : ""}`,
      hint: w.isCurrent ? "current" : undefined,
      disabled: w.isCurrent ? "This is the worktree you are viewing" : w.prunable ? `Directory is missing (${w.prunableReason ?? "prunable"})` : null,
      run: () => (close(false), void openWorktreePath(w.path)),
      menu: () => openMenu("worktree", { commit: null, ref: null, file: null, hunk: null, worktree: w }),
    }));
  });

  const filtered = createMemo(() => {
    const query = mode() === "repos" ? "" : q();
    if (mode() === "repos" && q() && !parseGitHubInput(q())) {
      return items()
        .map((it) => ({ it, s: fuzzyScore(q(), `${it.label} ${it.detail ?? ""}`) }))
        .filter((x) => x.s > 0 || x.it.key === "local-open")
        .sort((a, b) => b.s - a.s)
        .map((x) => x.it);
    }
    if (!query) return items();
    return items()
      .map((it) => ({ it, s: fuzzyScore(query, it.label) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (a.it.disabled ? 1 : 0) - (b.it.disabled ? 1 : 0) || b.s - a.s)
      .map((x) => x.it);
  });

  createEffect(() => {
    filtered();
    setActive(0);
  });
  createEffect(() => {
    const i = active();
    listEl?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  });

  onMount(() => input.focus());

  const onKey = (e: KeyboardEvent) => {
    const n = filtered().length;
    if (e.key === "ArrowDown") setActive((active() + 1) % Math.max(n, 1));
    else if (e.key === "ArrowUp") setActive((active() - 1 + n) % Math.max(n, 1));
    else if (e.key === "PageDown") setActive(Math.min(n - 1, active() + 8));
    else if (e.key === "PageUp") setActive(Math.max(0, active() - 8));
    else if (e.key === "Enter") {
      const it = filtered()[active()];
      if (it && !it.disabled) void it.run();
      else if (it?.disabled) app.toast("info", `${it.label} is unavailable`, it.disabled);
    } else if (e.key === "Escape") close();
    else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      const it = filtered()[active()];
      if (it?.menu) {
        close(false);
        it.menu();
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const placeholder = () =>
    ({
      commands: "Type a command (actions show their target, shortcut, or why they are unavailable)",
      repos: "owner/repo, a GitHub URL, a local path, or search recent repositories",
      branches: "Filter Branches...",
      worktrees: "Pick a worktree — Enter opens it, Shift+F10 for lock/unlock/remove",
    })[mode()];

  // The branch filter opens as a dropdown under its control (Git Graph layout); others are centered.
  const anchor = mode() === "branches" ? document.querySelector<HTMLElement>('[data-dropdown="branches"]')?.getBoundingClientRect() : null;
  const panelStyle = anchor ? { position: "fixed" as const, left: `${anchor.left}px`, top: `${anchor.bottom}px`, width: `${Math.max(anchor.width, 240)}px`, margin: "0" } : {};
  return (
    <div class="fixed inset-0 z-50" onMouseDown={(e) => e.target === e.currentTarget && close()} style={{ background: "transparent" }}>
      <div
        class="menu flex flex-col p-0"
        classList={{ "mx-auto mt-[8vh] w-[640px] max-w-[94vw]": !anchor }}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-label={mode() === "branches" ? "Branch filter" : "Command palette"}
      >
        <input
          ref={input}
          class="m-2 rounded border border-[var(--focus)] bg-[var(--input-bg)] px-2 py-1 outline-none"
          placeholder={placeholder()}
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={filtered().length ? `pal-${active()}` : undefined}
          aria-autocomplete="list"
          spellcheck={false}
          autocomplete="off"
        />
        <div ref={listEl} id="palette-list" role="listbox" class="max-h-[60vh] overflow-auto px-1 pb-1">
          <For each={filtered()} fallback={<div class="px-3 py-2 text-muted">{worktrees.loading ? "Loading…" : worktrees.error ? AppError.from(worktrees.error).message : "No matches"}</div>}>
            {(it, i) => (
              <div
                id={`pal-${i()}`}
                data-i={i()}
                role="option"
                aria-selected={active() === i()}
                aria-disabled={!!it.disabled}
                aria-checked={it.checked}
                aria-description={it.detail}
                title={it.detail}
                class="menu-item flex-col !items-stretch !gap-0 !whitespace-normal"
                classList={{ active: active() === i() }}
                onMouseMove={() => setActive(i())}
                onClick={() => (it.disabled ? app.toast("info", `${it.label} is unavailable`, it.disabled) : void it.run())}
              >
                <div class="flex items-center gap-2">
                  <Show when={it.checked !== undefined}>
                    <span class="w-4" aria-hidden="true">
                      {it.checked ? "✓" : ""}
                    </span>
                  </Show>
                  <span class="truncate" classList={{ "opacity-60": !!it.disabled }}>
                    {it.label}
                  </span>
                  <Show when={it.hint}>
                    <span class="text-xs opacity-70">{it.hint}</span>
                  </Show>
                  <Show when={it.shortcut}>
                    <span class="kbd ml-auto">{formatShortcut(it.shortcut!)}</span>
                  </Show>
                </div>
                <Show when={(it.disabled || it.detail) && mode() !== "branches"}>
                  <div class="truncate text-xs opacity-75">{it.disabled ? `Unavailable: ${it.disabled}` : it.detail}</div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

async function openLocalPath(path: string) {
  if (!app.companion().token) return;
  try {
    const res = await fetch(`${app.companion().baseUrl}/api/v1/commands/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${app.companion().token}`, "x-client": "ui" },
      body: JSON.stringify({ command: "local.open", args: { path } }),
    });
    const body = (await res.json()) as { ok: boolean; result?: RepoInfo; error?: { message: string } };
    if (!body.ok || !body.result) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    const info = body.result;
    app.rememberRecent({ key: info.key, name: info.name, path: info.worktreePath, at: Date.now() });
    app.navigate({ ...app.view(), repo: { provider: "local", id: info.key.split(":")[1]! }, branches: [], commit: null, compare: null, selected: [], view: "graph", file: null, at: null, worktree: null });
  } catch (e) {
    app.toast("error", `Could not open ${path}`, e instanceof Error ? e.message : String(e));
  }
}
export { executeRemote, openLocalPath };
