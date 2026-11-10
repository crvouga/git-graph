// Shared setup for stories. Stories render the real components against the real store; this
// module puts the store into a known state first:
//
//   openFixture({ commit: commits["Add logout"], view: "details" })  // the fixture repo, at a view
//   openHome()                                                       // no repository
//
// The fixture repository (scripts/storybook-fixture.ts) is copied into the browser's private file
// system and opened through the in-browser git reader, exactly like "Open Folder…" in the app.

import fixture from "virtual:lanes-fixture-repo";
import type { JSX } from "solid-js";
import { DEFAULT_DISPLAY, EMPTY_VIEW, type DisplayPrefs, type ViewState } from "../../core/url/state.ts";
import type { RepoRef } from "../../core/types.ts";
import { saveHandle } from "../app/handles.ts";
import { app, DEFAULT_COLUMNS } from "../app/store.ts";

export const FIXTURE_REPO = { provider: "browser", id: "storybook-fixture" } as const satisfies RepoRef;

/** Commit hashes of the fixture, by subject. */
export const commits = fixture.commits as Record<string, string> & {
  "Initial commit": string;
  "Add util module": string;
  "Add login stub": string;
  "Add logout": string;
  "Document usage": string;
  "Start develop": string;
  "Merge branch 'feature/auth' into develop": string;
  "Rename app.ts to main.ts": string;
  "Remove old docs and update logo": string;
  "Add sub()": string;
};

let installing: Promise<void> | null = null;

/** Copies the fixture's .git into OPFS once per browser and registers it as an opened folder. */
export function installFixtureRepo(): Promise<void> {
  installing ??= (async () => {
    const opfs = await navigator.storage.getDirectory();
    const dir = await opfs.getDirectoryHandle(`lanes-fixture-${fixture.head.slice(0, 12)}-${fixture.files.length}`, { create: true });
    const done = await dir.getFileHandle(".complete").then(
      () => true,
      () => false,
    );
    if (!done) {
      for (const f of fixture.files) {
        const parts = f.path.split("/");
        let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
        await w.close();
      }
      await dir.getFileHandle(".complete", { create: true });
    }
    await saveHandle(FIXTURE_REPO.id, dir);
  })();
  installing.catch(() => (installing = null));
  return installing;
}

/** Closes every overlay and restores default preferences, so stories never leak into each other. */
export function resetUi(): void {
  app.dialog()?.resolve(null);
  app.setPaletteOpen(false);
  app.setMenu(null);
  app.setHelpOpen(false);
  app.setTooltip(null);
  app.setFind({ open: false, text: "", matches: [], current: -1 });
  while (app.toasts.length) app.dismissToast();
  app.setColumns(DEFAULT_COLUMNS);
  app.setRefCursor(-1);
  app.setBusy(null);
  app.setAuth(SIGNED_OUT_NO_SERVER);
}

const SIGNED_OUT_NO_SERVER = { checked: true, serverAvailable: false, authenticated: false, user: null, github: null, loginEnabled: false, githubEnabled: false };

/** A deterministic avatar (no network in screenshots). */
export const AVATAR = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><rect width="18" height="18" fill="#6e7781"/><circle cx="9" cy="7" r="3.2" fill="#fff"/><path d="M3 16c1-3.5 3.5-5 6-5s5 1.5 6 5" fill="#fff"/></svg>')}`;

/** Pin the session shown by the UI: signed out (server reachable), signed in, GitHub connected. */
export function setSession(state: "signed-out" | "signed-in" | "github-connected"): void {
  app.setAuth({
    checked: true,
    serverAvailable: true,
    loginEnabled: true,
    githubEnabled: true,
    authenticated: state !== "signed-out",
    user: state === "signed-out" ? null : { name: "Alice Example", email: "alice@example.com", avatarUrl: null },
    github: state === "signed-out" ? null : state === "github-connected" ? { connected: true, login: "alice", name: "Alice A.", avatarUrl: AVATAR } : { connected: false },
  });
}

/** A view patch; `display` may be partial (merged over the defaults). */
export type ViewPatch = Partial<Omit<ViewState, "display">> & { display?: Partial<DisplayPrefs> };

function view(patch: ViewPatch): ViewState {
  const { display, ...rest } = patch;
  return { ...EMPTY_VIEW, branches: [], selected: [], ...rest, display: { ...DEFAULT_DISPLAY, ...display } };
}

export async function until(cond: () => boolean, what: string, timeout = 10_000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 16));
  }
}

/** The home screen (no repository open). */
export async function openHome(): Promise<void> {
  resetUi();
  app.navigate(view({}), { replace: true });
}

/**
 * Opens the fixture repository at `patch` and waits until the graph has loaded. Always reopens,
 * so every story starts from a fresh session (scroll, keyboard row, caches).
 */
export async function openFixture(patch: ViewPatch = {}, opts: { repo?: RepoRef } = {}): Promise<void> {
  await installFixtureRepo();
  resetUi();
  app.navigate(view({}), { replace: true });
  app.navigate(view({ repo: opts.repo ?? FIXTURE_REPO, ...patch }), { replace: true });
  await until(() => !app.repo.loading && (app.readySession() === app.sessionId() || !!app.repo.error), "the repository to open");
}

/** Fills the story canvas; the app lays itself out in a full-height column. */
export function Frame(props: { children: JSX.Element; height?: number }): JSX.Element {
  return <div style={{ height: props.height ? `${props.height}px` : "100vh", display: "flex", "flex-direction": "column", overflow: "hidden", background: "var(--bg)", color: "var(--fg)" }}>{props.children}</div>;
}

/** Row index of a fixture commit in the loaded graph. */
export function rowOf(hash: string): number {
  const r = app.rows.commits.findIndex((c) => c.hash === hash);
  if (r < 0) throw new Error(`Commit ${hash} is not in the graph`);
  return r;
}

/**
 * Stops the engine from pushing updates for the open repository (polling, sync status), so a story
 * can pin store state such as `app.setRepo("sync", …)` without it being overwritten. The graph stays.
 */
export async function freezeEngine(): Promise<void> {
  await app.engine.call({ method: "close", args: { session: app.sessionId() } });
}
