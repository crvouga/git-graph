// Compact top controls (Git Graph layout): repo, branch filter, remote toggle; icons on the right.

import { createMemo, Show } from "solid-js";
import { accountAvatar, accountLabel, canConnectGitHub, githubLogin } from "../app/account.ts";
import { app } from "../app/store.ts";
import { invoke } from "../app/commands.ts";
import { formatShortcut } from "../app/platform.ts";
import { IconFetch, IconGear, IconPlug, IconRefresh, IconSearch, IconUser } from "./icons.tsx";

function ago(t: number | null): string {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(t).toLocaleString();
}

export function ControlBar() {
  const v = app.view;
  const branchLabel = createMemo(() => {
    const b = v().branches;
    if (!b.length) return "Show All";
    return b.length === 1 ? b[0]! : `${b.length} branches`;
  });
  const sync = () => app.repo.sync;
  const syncText = createMemo(() => {
    const s = sync();
    if (!s) return { dot: "var(--fg-muted)", label: "Not connected", detail: "" };
    const when = `Last synchronized ${ago(s.lastSuccessAt)}`;
    if (s.connection === "offline") return { dot: "var(--del)", label: "Offline — showing cached data", detail: `${when}${s.lastError ? `\nLast error: ${s.lastError}` : ""}` };
    if (s.lastError) return { dot: "var(--warn)", label: "Sync problem", detail: `${s.lastError}\n${when}` };
    if (s.stale || s.fromCache) return { dot: "var(--warn)", label: s.fromCache ? "Cached — checking for changes" : "Checking for changes", detail: when };
    if (s.connection === "live") return { dot: "var(--add)", label: `Live${s.leader ? "" : " (shared with another tab)"}`, detail: when };
    return { dot: "var(--focus)", label: "Polling for changes", detail: when };
  });
  return (
    <div class="controls border-b border-[var(--border)]" role="toolbar" aria-label="Graph controls">
      <span />
      <div class="controls-center">
      <label class="ctl">
        Repo:
        <button class="dropdown-btn" aria-haspopup="listbox" title={`Open repository (${formatShortcut("o")})`} onClick={() => invoke("repo.open")}>
          {app.repo.info?.name ?? (v().repo ? (v().repo!.provider === "github" ? `${(v().repo as { owner: string }).owner}/${(v().repo as { name: string }).name}` : "…") : "Open…")}
        </button>
      </label>
      <Show when={v().repo}>
        <label class="ctl">
          Branches:
          <button class="dropdown-btn" data-dropdown="branches" aria-haspopup="listbox" title={`Filter branches (${formatShortcut("b")})`} onClick={() => invoke("branches.filter")}>
            {branchLabel()}
          </button>
        </label>
        <label class="ctl" style={{ "font-weight": 400 }}>
          <input type="checkbox" class="checkbox" checked={v().display.remotes} onChange={() => invoke("view.toggleRemotes")} />
          Show Remote Branches
        </label>
      </Show>
      </div>
      <div class="controls-right">
        <Show when={v().repo}>
          <span class="mr-2 flex items-center gap-1.5 text-xs opacity-80" title={`${syncText().label}\n${syncText().detail}`} aria-label={`${syncText().label}. ${syncText().detail}`} role="status" data-testid="sync-status">
            <span style={{ width: "8px", height: "8px", "border-radius": "50%", background: syncText().dot, display: "inline-block" }} />
            <span class="hidden xl:inline">{syncText().label}</span>
          </span>
          <Show when={app.busy()}>
            <span class="mr-2 text-xs opacity-80" role="status">
              {app.busy()}…
            </span>
          </Show>
          <button class="icon-btn" aria-label={`Find (${formatShortcut("Mod+F")})`} title={`Find (${formatShortcut("Mod+F")})`} onClick={() => invoke("find.open")}>
            <IconSearch />
          </button>
          <button class="icon-btn" aria-label="View options" title="View options" onClick={() => app.setPaletteOpen({ mode: "commands", initial: "View: " })}>
            <IconGear />
          </button>
          <button
            class="icon-btn"
            aria-label="Fetch from remotes"
            title={app.repo.caps?.fetch.available ? "Fetch from remote(s)" : `Fetch unavailable: ${(app.repo.caps?.fetch as { reason?: string } | undefined)?.reason ?? ""}`}
            aria-disabled={!app.repo.caps?.fetch.available}
            onClick={() => invoke("git.fetch")}
          >
            <IconFetch />
          </button>
          <button class="icon-btn" aria-label={`Refresh (${formatShortcut("r")})`} title={`Refresh (${formatShortcut("r")}) — normally automatic`} onClick={() => invoke("graph.refresh")}>
            <IconRefresh />
          </button>
        </Show>
        <Show when={app.companion().token}>
          <span class="icon-btn" title={`Local companion paired (${app.companion().baseUrl})`} aria-label="Local companion paired">
            <IconPlug />
          </span>
        </Show>
        <Show when={app.auth.serverAvailable && (app.auth.loginEnabled || app.auth.authenticated)}>
          <Show
            when={app.auth.authenticated}
            fallback={
              <button class="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs whitespace-nowrap" onClick={() => invoke("account.signIn")}>
                Sign in
              </button>
            }
          >
            <Show when={canConnectGitHub(app.auth)}>
              <button class="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs whitespace-nowrap" title="Link GitHub to see private repositories and get live updates" onClick={() => invoke("account.connectGitHub")}>
                Connect GitHub
              </button>
            </Show>
            <button
              class="icon-btn ml-1"
              title={`Signed in as ${accountLabel(app.auth)}${githubLogin(app.auth) ? ` · GitHub @${githubLogin(app.auth)}` : ""}`}
              aria-label={`Account: ${accountLabel(app.auth)}${githubLogin(app.auth) ? `, GitHub @${githubLogin(app.auth)}` : ", GitHub not connected"}. Open account commands`}
              onClick={() => app.setPaletteOpen({ mode: "commands", initial: "Account: " })}
            >
              <Show when={accountAvatar(app.auth)} fallback={<IconUser />}>
                <img src={accountAvatar(app.auth)!} alt="" width="18" height="18" style={{ "border-radius": "50%" }} />
              </Show>
            </button>
          </Show>
        </Show>
      </div>
    </div>
  );
}
