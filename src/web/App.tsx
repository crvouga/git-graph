import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { app } from "./app/store.ts";
import { currentContext, invoke, openGitHubInput, registry, shortcutCommands } from "./app/commands.ts";
import { isTypingTarget, matches, formatShortcut } from "./app/platform.ts";
import { ControlBar } from "./components/ControlBar.tsx";
import { GraphView } from "./components/GraphView.tsx";
import { DiffView } from "./components/DiffView.tsx";
import { Palette } from "./components/Palette.tsx";
import { ContextMenu, Dialog, FindWidget, Help, Toasts, Tooltip } from "./components/Overlays.tsx";
import { fsAccessSupported } from "./app/handles.ts";

function inGraphScope(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return true;
  if (t === document.body) return true;
  if (t.closest(".details .files") || t.closest('[data-testid="diff-view"]') || t.closest('[role="dialog"],[role="alertdialog"],[role="menu"]')) return false;
  return !!t.closest(".graph-scroll") || !!t.closest(".controls") || !!t.closest(".details");
}

function onGlobalKey(e: KeyboardEvent) {
  if (app.dialog() || app.menu() || app.paletteOpen() || app.helpOpen()) return; // overlays own the keyboard
  if (e.defaultPrevented) return;
  const typing = isTypingTarget(e.target);
  const inDiff = e.target instanceof HTMLElement && !!e.target.closest('[data-testid="diff-view"]');
  for (const cmd of shortcutCommands()) {
    for (const s of cmd.shortcuts!) {
      if (!matches(e, s)) continue;
      const scope = cmd.scope ?? "graph";
      if (typing && scope !== "global") continue;
      if (scope === "graph" && (!inGraphScope(e.target) || inDiff)) continue;
      // While the diff is open, Escape closes it; Mod+F etc. stay global.
      e.preventDefault();
      e.stopPropagation();
      void invoke(cmd.id, currentContext());
      return;
    }
  }
}

export function Home() {
  const [input, setInput] = createSignal("");
  let el!: HTMLInputElement;
  onMount(() => el.focus());
  return (
    <main class="flex flex-1 items-start justify-center overflow-auto pt-[10vh]">
      <div class="w-[560px] max-w-[94vw]">
        <h1 class="m-0 mb-1 text-[18px] font-bold">Open a repository</h1>
        <p class="m-0 mb-4 opacity-75">Paste a GitHub repository or URL, or open a local repository.</p>
        <form
          class="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (input().trim()) openGitHubInput(input().trim());
          }}
        >
          <label for="home-input" class="sr-only">
            GitHub repository
          </label>
          <input
            id="home-input"
            ref={el}
            class="flex-1 rounded border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1.5"
            placeholder="owner/repo or https://github.com/owner/repo"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            spellcheck={false}
            autocomplete="off"
          />
          <button class="rounded bg-[var(--focus)] px-3 text-white" type="submit">
            Open
          </button>
        </form>
        <div class="mt-3 flex flex-wrap gap-2">
          <button class="rounded border border-[var(--border)] px-2 py-1" onClick={() => invoke("companion.connect")}>
            Connect local companion…
          </button>
          <Show when={fsAccessSupported}>
            <button class="rounded border border-[var(--border)] px-2 py-1" onClick={() => invoke("repo.openFolder")}>
              Open folder (read-only)…
            </button>
          </Show>
          <Show when={app.auth.serverAvailable && !app.auth.authenticated}>
            <button class="rounded border border-[var(--border)] px-2 py-1" onClick={() => invoke("account.signIn")}>
              Sign in with GitHub
            </button>
          </Show>
        </div>
        <Show when={app.recents().length}>
          <h2 class="mt-6 mb-1 text-[13px] font-bold">Recent</h2>
          <ul class="m-0 list-none p-0" aria-label="Recent repositories">
            <For each={app.recents().slice(0, 8)}>
              {(r) => (
                <li>
                  <button
                    class="w-full truncate rounded px-2 py-1 text-left hover:bg-[var(--hover)]"
                    onClick={() => {
                      const [provider, ...rest] = r.key.split(":");
                      const repo = provider === "github" ? { provider: "github" as const, owner: rest[0]!, name: rest[1]! } : { provider: provider as "local" | "browser", id: rest[0]! };
                      app.navigate({ ...app.view(), repo, branches: [], commit: null, compare: null, selected: [], view: "graph", file: null, at: null, worktree: null });
                    }}
                  >
                    {r.name} <span class="text-xs opacity-60">{r.path ?? r.key}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <p class="mt-6 text-xs opacity-60">
          Local repositories with full Git (staging, worktrees, push…): run <code>git-graph open .</code> in a terminal. Commands: {formatShortcut("Mod+Shift+P")} · Shortcuts: ?
        </p>
      </div>
    </main>
  );
}

export function Banners() {
  const err = () => app.repo.error;
  return (
    <>
      <Show when={app.urlWarnings().length}>
        <div class="flex items-center gap-2 border-b border-[var(--warn)] px-3 py-1 text-xs" role="status">
          Some link parameters were ignored: {app.urlWarnings().join("; ")}
        </div>
      </Show>
      <Show when={app.repo.missingRefs.length}>
        <div class="flex items-center gap-2 border-b border-[var(--warn)] px-3 py-1" role="alert">
          <span>
            Not found in this repository: <b>{app.repo.missingRefs.join(", ")}</b> — the branch may have been deleted or renamed.
          </span>
          <button class="text-link underline" onClick={() => invoke("branches.showAll")}>
            Show all branches
          </button>
        </div>
      </Show>
      <Show when={app.repo.status?.operation}>
        <div class="flex items-center gap-2 border-b border-[var(--warn)] px-3 py-1" role="alert">
          <b>{app.repo.status!.operation!.kind} in progress</b>
          <span class="opacity-80">{app.repo.status!.conflicted.length ? `${app.repo.status!.conflicted.length} conflicted file(s)` : "ready to continue"}</span>
          <button class="text-link underline" onClick={() => app.navigate({ commit: "working", view: "details", file: null, compare: null })}>
            Review
          </button>
          <button class="text-link underline" onClick={() => invoke("git.operation.continue")}>
            Continue
          </button>
          <button class="text-link underline" onClick={() => invoke("git.operation.abort")}>
            Abort
          </button>
        </div>
      </Show>
      <Show when={err()}>
        <div class="m-6 max-w-[640px] rounded border border-[var(--del)] p-4" role="alert">
          <div class="font-bold">{err()!.code === "NOT_FOUND" ? "Repository not found" : err()!.code === "UNAUTHENTICATED" ? "Connection needed" : err()!.code === "FORBIDDEN" ? "Access denied" : "Could not open repository"}</div>
          <div class="mt-1 whitespace-pre-wrap">{err()!.message}</div>
          <Show when={err()!.code === "NOT_FOUND" && app.view().repo?.provider === "github" && !app.auth.authenticated && app.auth.serverAvailable}>
            <div class="mt-2">
              Private repositories need you to sign in.{" "}
              <a class="text-link underline" href={app.loginUrl()}>
                Sign in with GitHub
              </a>
            </div>
          </Show>
          <Show when={app.view().repo?.provider === "local"}>
            <div class="mt-2">
              <button class="text-link underline" onClick={() => invoke("companion.connect")}>
                Connect local companion…
              </button>
            </div>
          </Show>
          <Show when={app.view().repo?.provider === "browser"}>
            <div class="mt-2">
              <button class="text-link underline" onClick={() => invoke("repo.openFolder")}>
                Open folder again…
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}

/** The application: session check, companion pairing and opening the repository in the URL. */
export function App() {
  onMount(() => {
    void app.checkSession();
    void app.pairFromFragment().then(() => {
      if (app.view().repo) void app.openRepo(app.view());
    });
  });
  return <AppShell />;
}

/** Layout and keyboard handling only, driven entirely by the store. Stories render this. */
export function AppShell() {
  onMount(() => window.addEventListener("keydown", onGlobalKey));
  onCleanup(() => window.removeEventListener("keydown", onGlobalKey));
  void registry;
  return (
    <div class="flex h-full flex-col" data-app="lanes">
      <ControlBar />
      <Banners />
      <Show when={app.view().repo} fallback={<Home />}>
        <div class="relative flex min-h-0 flex-1 flex-col">
          <Show when={!app.repo.error}>
            <GraphView />
          </Show>
          <Show when={app.repo.loading && !app.rows.length}>
            <div class="absolute top-12 left-1/2 -translate-x-1/2 opacity-70" role="status">
              Loading repository…
            </div>
          </Show>
          <Show when={app.find.open}>
            <FindWidget />
          </Show>
          <Show when={app.view().view === "diff" && app.view().file && app.view().commit}>
            <DiffView />
          </Show>
        </div>
      </Show>
      <Show when={app.paletteOpen()}>
        <Palette />
      </Show>
      <Show when={app.menu()}>
        <ContextMenu />
      </Show>
      <Show when={app.dialog()}>
        <Dialog />
      </Show>
      <Show when={app.helpOpen()}>
        <Help />
      </Show>
      <Show when={app.tooltip()}>
        <Tooltip />
      </Show>
      <Toasts />
    </div>
  );
}
