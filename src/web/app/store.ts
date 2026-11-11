// Application controller. The URL (ViewState) is the source of truth for shareable navigation;
// repository data comes from Zero (src/web/app/zero.ts); the engine worker turns it into rows.

import { batch, createComputed, createMemo, createRoot, createSignal, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { AppError, parseRepoKey, repoKey, type Capabilities, type Commit, type HistoryQuery, type Ref, type RefsSnapshot, type RepoInfo, type RepoRef, type WorkingTreeStatus } from "../../core/types.ts";
import { EMPTY_VIEW, parseUrl, serialize, shouldPush, WORKING, type ViewState } from "../../core/url/state.ts";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import { rowToCommit, snapshotOf, type CommitRow, type RefRow } from "../../zero/rows.ts";
import type { RepoSync } from "../../zero/schema.ts";
import { Engine, GraphRows } from "../engine/client.ts";
import type { EngineEvent, SyncInfo } from "../engine/protocol.ts";
import { address } from "./address.ts";
import { IN_STORYBOOK } from "./env.ts";
import { requestRead, serveBrowserRepo } from "./sync.ts";
import { boot, connection, live, mutate, zero } from "./zero.ts";

/** A repository as Zero syncs it (src/zero/schema.ts). */
interface RepoRow {
  id: string;
  info?: RepoInfo | null;
  caps?: Capabilities | null;
  head: import("../../core/types.ts").HeadState;
  refs_version: string;
  status?: WorkingTreeStatus | null;
  commit_count: number;
  history_complete: boolean;
  sync: RepoSync;
}

/** Signed in through the auth relay (Google). */
export interface AuthUser {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}
/** The account's GitHub connection (private repositories, live sync). */
export type AuthGitHub = { connected: true; login: string; name: string | null; avatarUrl: string | null } | { connected: false };
export interface AuthState {
  checked: boolean;
  serverAvailable: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  github: AuthGitHub | null;
  /** The server offers sign-in / connecting GitHub. */
  loginEnabled: boolean;
  githubEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Persistence helpers: localStorage holds per-device preferences only (columns, theme, and the
// recent list of signed-out visitors). Everything else is synced by Zero.
// ---------------------------------------------------------------------------

function load<T>(key: string, dflt: T): T {
  if (IN_STORYBOOK) return dflt; // stories start from defaults, whatever this browser saved before
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : dflt;
  } catch {
    return dflt;
  }
}
function save(key: string, v: unknown) {
  if (IN_STORYBOOK) return;
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore quota */
  }
}

export interface Columns {
  graph: number | null; // null = auto from graph width
  date: number;
  author: number;
  hash: number;
  showDate: boolean;
  showAuthor: boolean;
  showHash: boolean;
}

export interface RecentRepo {
  key: string;
  name: string;
  path?: string;
  at: number;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  message: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface DialogField {
  name: string;
  label: string;
  type: "text" | "textarea" | "checkbox" | "select" | "readonly";
  value?: string | boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  help?: string;
}

export interface DialogSpec {
  title: string;
  message?: string;
  /** Exact consequence of a destructive action. */
  consequence?: string;
  fields?: DialogField[];
  confirmLabel: string;
  danger?: boolean;
  /** Pre-formatted output (Run Git command results). */
  output?: { cwd?: string; args?: string; exitCode?: number; text: string };
  resolve: (values: Record<string, string | boolean> | null) => void;
}

export interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  disabled?: string | null;
  danger?: boolean;
  run?: () => void;
  separator?: boolean;
}

export interface MenuSpec {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
  /** Element to refocus when the menu closes. */
  restore?: HTMLElement | null;
}

export interface FileFocus {
  path: string;
}

export const DEFAULT_COLUMNS: Columns = { graph: null, date: 124, author: 110, hash: 76, showDate: true, showAuthor: true, showHash: true };

export const ROW_H = 24;
export const DETAILS_H = 250;
export const LANE_W = 16;
export const GRAPH_PAD = 16;

// ---------------------------------------------------------------------------

function createApp() {
  const engine = new Engine();
  const rows = new GraphRows();
  const [rowsVersion, setRowsVersion] = createSignal(0);
  const [view, setViewSignal] = createSignal<ViewState>(parseUrl(address.href()).state);
  const [urlWarnings, setUrlWarnings] = createSignal<string[]>(parseUrl(address.href()).warnings);

  const [repo, setRepo] = createStore<{
    info: RepoInfo | null;
    caps: Capabilities | null;
    refs: RefsSnapshot | null;
    status: WorkingTreeStatus | null;
    sync: SyncInfo | null;
    error: { code: string; message: string; details?: Record<string, unknown> } | null;
    missingRefs: string[];
  }>({ info: null, caps: null, refs: null, status: null, sync: null, error: null, missingRefs: [] });

  const [auth, setAuth] = createStore<AuthState>({
    checked: true,
    serverAvailable: boot.server,
    authenticated: !!boot.accountId,
    user: null,
    github: null,
    loginEnabled: boot.loginEnabled,
    githubEnabled: boot.githubEnabled,
  });

  const [columns, setColumnsSignal] = createSignal<Columns>(load("lanes.columns.v2", DEFAULT_COLUMNS));
  const [localRecents, setLocalRecents] = createSignal<RecentRepo[]>(load("lanes.recents", []));
  const [theme, setThemeSignal] = createSignal<"system" | "light" | "dark">(load("lanes.themePref", "system"));

  // Keyboard cursor (row index), focused ref within the row, and transient overlays.
  const [kbRow, setKbRow] = createSignal(0);
  const [refCursor, setRefCursor] = createSignal(-1);
  const [paletteOpen, setPaletteOpen] = createSignal<false | { initial?: string; mode?: "commands" | "repos" | "branches" | "worktrees" }>(false);
  const [find, setFind] = createStore<{ open: boolean; text: string; matches: number[]; current: number }>({ open: false, text: "", matches: [], current: -1 });
  const [menu, setMenu] = createSignal<MenuSpec | null>(null);
  const [dialog, setDialog] = createSignal<DialogSpec | null>(null);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [tooltip, setTooltip] = createSignal<{ x: number; y: number; row: number } | null>(null);
  const [toasts, setToasts] = createStore<Toast[]>([]);
  /** A queued operation the user is waiting on (shown as plain text, never as a spinner). */
  const [busy, setBusy] = createSignal<string | null>(null);
  const [metrics, setMetrics] = createStore<Record<string, number>>({});
  (globalThis as { __lanesMetrics?: Record<string, number> }).__lanesMetrics = metrics;
  /** Restores focus after nested views close: details → commit row, diff → file item. */
  const focusMemory = { detailsFrom: null as string | null, diffFrom: null as string | null };

  let session = 0;
  const [sessionSig, setSessionSig] = createSignal(0);
  let toastId = 0;
  // Declared up front: Zero can deliver local rows synchronously while the computeds below are set up.
  const waiters = new Set<{ hash: string; resolve: (r: number) => void }>();
  const initialTarget = { done: false, session: -1 };
  let scrollEl: HTMLElement | null = null;
  const lastVisit = new Map<string, number>();
  let findSeq = 0;
  let findJump = false;
  /** The text of the last search the user ran; sync re-runs repeat it, never text still being typed. */
  let findSearched = "";

  // ------------------------------------------------------------------ account (Zero)

  const account = live<{ id: string; name?: string | null; email?: string | null; picture?: string | null; github?: { github_login: string; github_name?: string | null; github_avatar_url?: string | null } | null }>(() =>
    boot.accountId ? queries.me.account({}) : null,
  );
  createComputed(() => {
    const a = account.data();
    if (!boot.accountId || !a) return;
    setAuth({
      user: { name: a.name ?? null, email: a.email ?? null, avatarUrl: a.picture ?? null },
      github: a.github ? { connected: true, login: a.github.github_login, name: a.github.github_name ?? null, avatarUrl: a.github.github_avatar_url ?? null } : { connected: false },
    });
  });

  const visits = live<{ repo_id: string; name: string; path?: string | null; visited_at: number }[]>(() => (boot.accountId ? queries.me.visits({}) : null));
  const recents = createMemo<RecentRepo[]>(() => {
    const v = visits.data();
    if (!boot.accountId || !v) return localRecents();
    return v.map((r) => ({ key: r.repo_id, name: r.name, ...(r.path ? { path: r.path } : {}), at: r.visited_at }));
  });

  const agentsQ = live<{ id: string; kind: string; name: string; last_seen_at?: number | null }[]>(() => (boot.accountId ? queries.me.agents({}) : null));
  /** This account's companions; `online` when one checked in recently. */
  const companions = createMemo(() => {
    const now = Date.now();
    return (agentsQ.data() ?? []).filter((a) => a.kind === "companion").map((a) => ({ id: a.id, name: a.name, online: !!a.last_seen_at && now - a.last_seen_at < 3 * 60_000 }));
  });

  // ------------------------------------------------------------------ derived

  const refsByCommit = createMemo(() => {
    const m = new Map<string, Ref[]>();
    const snap = repo.refs;
    if (!snap) return m;
    const showRemotes = view().display.remotes;
    const showTags = view().display.tags;
    const showStashes = view().display.stashes;
    for (const r of snap.refs) {
      if (r.kind === "remote" && !showRemotes) continue;
      if (r.kind === "tag" && !showTags) continue;
      if (r.kind === "stash" && !showStashes) continue;
      const list = m.get(r.commit) ?? [];
      list.push(r);
      m.set(r.commit, list);
    }
    const order = { head: 0, remote: 1, tag: 2, stash: 3 } as const;
    for (const [k, l] of m) {
      // Combine "main" and "origin/main" on the same commit into one label (Git Graph default).
      const locals = new Set(l.filter((r) => r.kind === "head").map((r) => r.short));
      const kept = l.filter((r) => !(r.kind === "remote" && r.remote && locals.has(r.short.slice(r.remote.length + 1))));
      kept.sort((a, b) => order[a.kind] - order[b.kind] || a.short.localeCompare(b.short));
      m.set(k, kept);
    }
    return m;
  });

  /** Remote names combined into a local branch label ("main" + "origin" segments). */
  function combinedRemotes(r: Ref): string[] {
    if (r.kind !== "head" || !view().display.remotes) return [];
    return (repo.refs?.refs ?? []).filter((x) => x.kind === "remote" && x.remote && x.commit === r.commit && x.short === `${x.remote}/${r.short}`).map((x) => x.remote!);
  }

  const headCommit = createMemo(() => {
    const h = repo.refs?.head;
    return h && (h.kind === "branch" || h.kind === "detached") ? h.commit : null;
  });
  const headBranch = createMemo(() => {
    const h = repo.refs?.head;
    return h?.kind === "branch" ? h.ref.replace(/^refs\/heads\//, "") : null;
  });

  // ------------------------------------------------------------------ toasts

  function toast(kind: Toast["kind"], message: string, detail?: string, action?: Toast["action"]) {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-4), { id, kind, message, detail, action }]);
    if (kind !== "error") setTimeout(() => dismissToast(id), 5000);
    return id;
  }
  function dismissToast(id?: number) {
    setToasts((t) => (id === undefined ? t.slice(0, -1) : t.filter((x) => x.id !== id)));
  }

  // ------------------------------------------------------------------ URL navigation

  function navigate(patch: Partial<ViewState> | ((v: ViewState) => ViewState), opts: { replace?: boolean } = {}) {
    const prev = view();
    const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
    const url = serialize(next);
    const push = !opts.replace && shouldPush(prev, next);
    if (url !== address.path()) {
      if (push) address.push(url);
      else address.replace(url);
    }
    applyView(next, prev);
  }

  function applyView(next: ViewState, prev: ViewState) {
    setViewSignal(next);
    const sameRepo = (prev.repo ? repoKey(prev.repo) : null) === (next.repo ? repoKey(next.repo) : null);
    if (sameRepo && next.commit && next.commit !== prev.commit) void revealCommit(next.commit);
    document.title = next.repo ? `${repoLabelOf(next.repo)} · Lanes` : "Lanes";
  }

  address.onPop(() => {
    const prev = view();
    const p = parseUrl(address.href());
    setUrlWarnings(p.warnings);
    applyView(p.state, prev);
  });

  function repoLabelOf(r: RepoRef) {
    if (r.provider === "github") return `${r.owner}/${r.name}`;
    return recents().find((x) => x.key === repoKey(r))?.name ?? r.id;
  }

  // ------------------------------------------------------------------ the open repository (Zero)
  //
  // Opening a repository is a demand ("I am looking at this, with this much history"); the
  // repository's agent publishes it and Zero syncs it here. The graph is computed from whatever
  // part of it is already in the local store, and updates as more arrives.

  const INITIAL_WINDOW = 1500;
  const GROW = 2000;
  const repoId = createMemo(() => {
    const r = view().repo;
    return r ? repoKey(r) : null;
  });
  const [win, setWin] = createSignal(INITIAL_WINDOW);
  /** The browser-folder agent registered the repository (browser repos open after that). */
  const [served, setServed] = createSignal<string | null>(null);
  /** Commits this session has handed to the worker. */
  const sent = new Map<string, true>();
  /** Commit details already requested for prefetch. */
  const prefetched = new Set<string>();
  let refsDigest = "";

  const repoRow = live<RepoRow>(() => (repoId() ? queries.repo.byId({ repoId: repoId()! }) : null));
  const refRows = live<RefRow[]>(() => (repoId() ? queries.repo.refs({ repoId: repoId()! }) : null));
  const demand = live<{ state: string; error?: { code: string; message: string; details?: Record<string, unknown> } | null }>(() => (repoId() ? queries.repo.demand({ repoId: repoId()! }) : null));
  const commitRows = live<CommitRow[]>(() => (repoId() ? queries.repo.commits({ repoId: repoId()!, limit: win() }) : null));

  /** Tell the repository's agent we are looking (and how deep); repeated while we look. */
  function openDemand(id: string) {
    mutate(mutators.repo.open({ repoId: id, depth: win() + 500, now: Date.now() }));
  }

  createComputed(
    on(repoId, (id) => {
      const mySession = ++session;
      setWin(INITIAL_WINDOW);
      setServed(null);
      sent.clear();
      refsDigest = "";
      batch(() => {
        rows.apply({ t: "rows", session: mySession, kind: "reset", commits: [], layout: { from: 0, nodeLane: new Int16Array(0), nodeColor: new Int16Array(0), edgeStart: new Uint32Array(1), edges: new Int16Array(0), tail: new Int16Array(0), width: 0 }, complete: false, stale: true, refs: { head: { kind: "none" }, refs: [], version: "" } });
        setRowsVersion((x) => x + 1);
        setRepo(reconcile({ info: null, caps: null, refs: null, status: null, sync: null, error: null, missingRefs: [] }));
        setFind({ open: find.open, text: find.text, matches: [], current: -1 });
        setKbRow(0);
        setRefCursor(-1);
      });
      void engine.call({ method: "reset", args: { session: mySession } }).catch(() => {});
      setSessionSig(mySession);
      if (!id) return;
      const ref = parseRepoKey(id);
      if (ref?.provider === "local" && !boot.accountId) {
        setRepo("error", { code: "UNAUTHENTICATED", message: "Local repositories are synced to your account by the git-graph companion. Sign in first." });
        return;
      }
      if (ref?.provider === "browser") {
        void serveBrowserRepo(id).then(
          (here) => {
            if (session !== mySession) return;
            setServed(id);
            openDemand(id);
            // Opened in another browser: what it synced is shown; without that there is nothing.
            if (!here && !repoRow.data()) setRepo("error", { code: "NOT_FOUND", message: "This browser does not have that folder. Use “Open folder…” to pick it again, or open it from the browser that has it." });
          },
          (e) => {
            if (session !== mySession) return;
            const err = AppError.from(e);
            setRepo("error", { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
          },
        );
      } else openDemand(id);
      const keepAlive = setInterval(() => session === mySession && repoId() && openDemand(id), 4 * 60_000);
      onCleanup(() => clearInterval(keepAlive));
    }),
  );

  // Commits → worker, as deltas against what this session already sent. Re-runs when a new
  // session starts: the rows may have been delivered just before the reset cleared them.
  createComputed(() => {
    sessionSig();
    const list = commitRows.data();
    const id = repoId();
    if (!list || !id) return;
    const add: Commit[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      if (r.repo_id !== id) continue;
      seen.add(r.hash);
      if (!sent.has(r.hash)) {
        sent.set(r.hash, true);
        add.push(rowToCommit(r));
      }
    }
    const remove: string[] = [];
    for (const h of sent.keys()) if (!seen.has(h)) remove.push(h);
    for (const h of remove) sent.delete(h);
    if (add.length || remove.length) void engine.call({ method: "commits", args: { session, add, remove } }).catch(() => {});
  });

  // Repository row, refs and the view's query → store and worker.
  createComputed(() => {
    sessionSig();
    const r = repoRow.data();
    const id = repoId();
    const refList = refRows.data();
    if (!id || !r || r.id !== id) return;
    if (repo.error?.code === "NOT_FOUND") setRepo("error", null);
    const snap = snapshotOf(r.head, r.refs_version, (refList ?? []).filter((x) => x.repo_id === id));
    const synced = commitRows.data()?.length ?? 0;
    const complete = r.history_complete && synced >= r.commit_count;
    const v = view();
    batch(() => {
      setRepo({ info: r.info ?? null, caps: r.caps ?? null, status: r.status ?? null });
      // Refs rows can arrive after the repository row with the same version: compare content.
      const digest = `${snap.version}|${JSON.stringify(snap.head)}|${snap.refs.map((x) => `${x.name}=${x.commit}`).join(",")}`;
      if (digest !== refsDigest) {
        refsDigest = digest;
        setRepo("refs", snap);
      }
    });
    void engine
      .call({ method: "state", args: { session, state: { refs: snap, query: queryFor(v), status: r.status ?? null, complete } } })
      .catch(() => {});
    if (r.info) rememberRecent({ key: id, name: r.info.name, ...(r.info.worktreePath ? { path: r.info.worktreePath } : {}), at: Date.now() });
  });

  // Why a repository cannot be shown (the viewer's demand failed).
  createComputed(() => {
    const d = demand.data();
    const ref = repoId() ? parseRepoKey(repoId()!) : null;
    if (ref?.provider === "browser" && served() !== repoId() && repo.error) return;
    if (d?.state === "error" && d.error) setRepo("error", d.error);
    else if (repo.error && d?.state === "ok") setRepo("error", null);
  });

  // Freshness: the agent's report plus our own connection to the server.
  createComputed(() => {
    const r = repoRow.data();
    const c = connection();
    if (!repoId()) return;
    const s = r?.sync ?? {};
    const offline = c.name !== "connected";
    setRepo("sync", {
      connection: offline ? (c.name === "connecting" ? "connecting" : "offline") : (s.state ?? "polling"),
      lastSuccessAt: s.lastSuccessAt ?? null,
      lastError: s.lastError ?? null,
      stale: offline || !!s.lastError,
      fromCache: offline,
      refsVersion: r?.refs_version ?? null,
      pending: 0,
      leader: true,
    });
  });

  function queryFor(v: ViewState): HistoryQuery {
    return {
      refs: v.branches,
      includeRemotes: v.display.remotes,
      includeTags: v.display.tags,
      includeStashes: v.display.stashes,
      firstParent: v.display.firstParent,
      order: v.display.order,
    };
  }

  /** More history: widen the synced window (and the agent's depth). */
  function growWindow() {
    const r = repoRow.data();
    if (!r || !repoId()) return;
    const synced = commitRows.data()?.length ?? 0;
    if (synced < win()) {
      // The agent has not published that far yet: ask it to.
      if (!r.history_complete) openDemand(repoId()!);
      return;
    }
    setWin((w) => Math.min(w + GROW, 50_000));
    openDemand(repoId()!);
  }

  /** Row of `hash`, widening the window until it appears (or history ends). */
  function ensureRow(hash: string, maxWindow = 50_000): Promise<number> {
    const find = () => rows.index.get(hash) ?? (hash.length < 40 ? findPrefix(hash) : -1);
    const now = find();
    if (now >= 0 || hash === WORKING) return Promise.resolve(now);
    return new Promise((resolve) => {
      const w = { hash, resolve };
      waiters.add(w);
      const step = () => {
        if (!waiters.has(w)) return;
        const r = repoRow.data();
        const synced = commitRows.data()?.length ?? 0;
        const done = !!r && r.history_complete && synced >= r.commit_count;
        if (done || win() >= maxWindow) {
          waiters.delete(w);
          return resolve(find());
        }
        growWindow();
        setTimeout(step, 400);
      };
      setTimeout(step, 50);
      setTimeout(() => {
        if (waiters.delete(w)) resolve(find());
      }, 30_000);
    });
  }

  engine.on((ev: EngineEvent) => {
    if ("session" in ev && ev.session !== session) return; // stale session: never touch the new view
    switch (ev.t) {
      case "rows": {
        const anchor = captureAnchor();
        rows.apply(ev);
        setRowsVersion((x) => x + 1);
        if (ev.kind !== "append") {
          checkMissingRefs(ev.refs);
          restoreAnchor(anchor);
        }
        if (find.open && findSearched) void runFind(findSearched, true);
        for (const w of [...waiters]) {
          const r = rows.index.get(w.hash) ?? (w.hash.length < 40 ? findPrefix(w.hash) : -1);
          if (r >= 0) {
            waiters.delete(w);
            w.resolve(r);
          }
        }
        if (!initialTarget.done) revealInitial();
        break;
      }
      case "metric": {
        setMetrics(ev.name, Math.round(ev.value * 10) / 10);
        break;
      }
    }
  });

  /** A deep link to a commit (or ?at=) is revealed once, as soon as its row exists. */
  function revealInitial() {
    if (initialTarget.session !== session) {
      initialTarget.session = session;
      initialTarget.done = false;
    }
    const v = view();
    const target = v.at ?? v.commit;
    if (!target || target === WORKING) {
      initialTarget.done = true;
      return;
    }
    const r = rows.index.get(target) ?? findPrefix(target);
    if (r >= 0) {
      initialTarget.done = true;
      setKbRow(r);
      requestAnimationFrame(() => scrollToRow(r, v.at ? "top" : "center"));
      return;
    }
    if (rows.length) {
      initialTarget.done = true;
      void ensureRow(target).then((row) => {
        if (row >= 0) {
          setKbRow(row);
          requestAnimationFrame(() => scrollToRow(row, v.at ? "top" : "center"));
        } else if (v.commit) {
          toast("error", `Commit ${v.commit.slice(0, 10)} was not found`, "It may have been rewritten or deleted, or it is not reachable from the branches shown. Try “Show All” branches.");
        }
      });
    }
  }

  function checkMissingRefs(snap: RefsSnapshot) {
    if (!snap.version) return;
    const v = view();
    const names = new Set<string>();
    for (const r of snap.refs) {
      names.add(r.short);
      names.add(r.name);
    }
    const missing = v.branches.filter((b) => !names.has(b) && !/^[0-9a-f]{40,64}$/i.test(b));
    if (v.focusBranch && !names.has(v.focusBranch)) missing.push(v.focusBranch);
    setRepo("missingRefs", missing);
  }

  /** Keep the same commit at the same screen position across refreshes (selection by object id). */
  function captureAnchor(): { hash: string; offset: number; kbHash: string | null } | null {
    const el = scrollEl;
    if (!el || rows.length === 0) return null;
    const top = Math.floor(el.scrollTop / ROW_H);
    const c = rows.commits[Math.min(top, rows.length - 1)];
    return c ? { hash: c.hash, offset: el.scrollTop - rowTop(top), kbHash: rows.commits[kbRow()]?.hash ?? null } : null;
  }
  function restoreAnchor(a: ReturnType<typeof captureAnchor>) {
    if (!a || !scrollEl) return;
    const r = rows.index.get(a.hash);
    if (a.kbHash) {
      const k = rows.index.get(a.kbHash);
      if (k !== undefined) setKbRow(k);
    }
    if (r !== undefined) {
      const el = scrollEl;
      requestAnimationFrame(() => {
        el.scrollTop = rowTop(r) + a.offset;
      });
    }
  }

  // Prefetch the details of commits around the cursor, so opening them shows everything at once.
  createComputed(
    on([kbRow, rowsVersion], () => {
      const id = repoId();
      if (!id || !rows.length) return;
      const r0 = kbRow();
      for (let r = Math.max(0, r0 - 2); r <= Math.min(rows.length - 1, r0 + 3); r++) {
        const c = rows.commits[r]!;
        if (c.hash !== WORKING && !prefetched.has(`${id}|${c.hash}`)) {
          prefetched.add(`${id}|${c.hash}`);
          requestRead({ repoId: id, method: "commit", params: [c.hash] });
        }
      }
    }),
  );

// ------------------------------------------------------------------ geometry & scrolling

  function setScrollEl(el: HTMLElement | null) {
    scrollEl = el;
  }
  const expandedRow = createMemo(() => {
    rowsVersion();
    const v = view();
    if (!v.commit || v.view === "graph") return -1;
    return rows.index.get(v.commit) ?? findPrefix(v.commit);
  });
  function findPrefix(h: string): number {
    if (h.length >= 40) return -1;
    for (let i = 0; i < rows.length; i++) if (rows.commits[i]!.hash.startsWith(h)) return i;
    return -1;
  }
  function rowTop(r: number): number {
    const e = expandedRow();
    return r * ROW_H + (e >= 0 && r > e ? DETAILS_H : 0);
  }
  function rowAt(y: number): number {
    const e = expandedRow();
    if (e >= 0 && y >= (e + 1) * ROW_H) {
      if (y < (e + 1) * ROW_H + DETAILS_H) return e;
      return Math.floor((y - DETAILS_H) / ROW_H);
    }
    return Math.floor(y / ROW_H);
  }
  function scrollToRow(r: number, where: "center" | "top" | "nearest" = "nearest") {
    const el = scrollEl;
    if (!el) return;
    const top = rowTop(r);
    const h = el.clientHeight;
    const extra = r === expandedRow() ? DETAILS_H : 0;
    if (where === "top") el.scrollTop = top;
    else if (where === "center") el.scrollTop = Math.max(0, top - h / 2 + (ROW_H + extra) / 2);
    else {
      if (top < el.scrollTop + 30) el.scrollTop = Math.max(0, top - 30);
      else if (top + ROW_H + extra > el.scrollTop + h) el.scrollTop = top + ROW_H + extra - h + 4;
    }
  }

  async function revealCommit(hash: string) {
    let r = rows.index.get(hash) ?? findPrefix(hash);
    if (r < 0 && hash !== WORKING) r = await ensureRow(hash);
    if (r >= 0) {
      setKbRow(r);
      requestAnimationFrame(() => scrollToRow(r, "center"));
    } else toast("error", `Commit ${hash.slice(0, 10)} is not in the loaded history`);
  }

  // ------------------------------------------------------------------ selection

  function primaryHash() {
    return view().commit;
  }

  /** Enter: open details for the keyboard row (Git Graph: click a commit). */
  function openDetails(row = kbRow()) {
    const c = rows.commits[row];
    if (!c) return;
    focusMemory.detailsFrom = c.hash;
    navigate({ commit: c.hash, compare: null, view: "details", file: null, selected: [] });
    setKbRow(row);
    requestAnimationFrame(() => scrollToRow(row, "nearest"));
  }

  function closeDetails() {
    const back = focusMemory.detailsFrom ?? view().commit;
    // Closing details clears the selection (Git Graph behaviour); the keyboard cursor stays put.
    navigate({ view: "graph", file: null, compare: null, commit: null, selected: [] });
    if (back) {
      const r = rows.index.get(back);
      if (r !== undefined) setKbRow(r);
    }
    focusGraph();
  }

  /** Space: toggle a commit in the multi-selection (nonadjacent selection by keyboard). */
  function toggleSelect(row = kbRow()) {
    const c = rows.commits[row];
    if (!c || c.hash === WORKING) return;
    const v = view();
    if (!v.commit) {
      navigate({ commit: c.hash, view: "graph" }, { replace: true });
      return;
    }
    if (v.commit === c.hash) {
      const [next, ...rest] = v.selected;
      navigate({ commit: next ?? null, selected: rest, view: next ? v.view : "graph", compare: null }, { replace: true });
      return;
    }
    const sel = v.selected.includes(c.hash) ? v.selected.filter((x) => x !== c.hash) : [...v.selected, c.hash];
    navigate({ selected: sel }, { replace: true });
  }

  /** Compare the keyboard row with the primary selection (Git Graph: Cmd/Ctrl+click). */
  function compareWith(row = kbRow()) {
    const c = rows.commits[row];
    const v = view();
    if (!c) return;
    const base = v.commit ?? v.selected[0];
    if (!base || base === c.hash) {
      toast("info", "Select a commit first (Space), then compare another commit with it.");
      return;
    }
    focusMemory.detailsFrom = c.hash;
    navigate({ commit: base, compare: c.hash, view: "details", file: null, selected: v.selected.filter((x) => x !== c.hash && x !== base) });
  }

  function openDiff(path: string) {
    focusMemory.diffFrom = path;
    navigate({ view: "diff", file: path });
  }
  function closeDiff() {
    const path = focusMemory.diffFrom ?? view().file;
    navigate({ view: "details", file: null });
    restoreFocus(() => (path ? document.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(path)}"]`) : null));
  }

  /**
   * Deferred focus restoration that never steals focus: it only applies if, by the time it runs,
   * focus is lost (on <body> or a detached element) — not if the user already opened something else.
   */
  function restoreFocus(target: () => HTMLElement | null | undefined) {
    const owner = document.activeElement;
    // Synchronous when the target exists already, so keys typed right after closing never hit <body>.
    const now = target();
    if (now && document.contains(now) && (owner === document.body || !owner || !document.contains(owner) || owner === now || owner.closest('[role="search"],[role="dialog"],[role="alertdialog"],[role="menu"]'))) {
      now.focus({ preventScroll: true });
      return;
    }
    requestAnimationFrame(() => {
      const a = document.activeElement;
      const lost = !a || a === document.body || !document.contains(a) || a === owner;
      if (!lost) return;
      const t = target();
      if (t && document.contains(t)) t.focus({ preventScroll: true });
      else scrollEl?.focus({ preventScroll: true });
    });
  }

  function focusGraph() {
    restoreFocus(() => scrollEl);
  }

  function moveKb(delta: number) {
    const n = rows.length;
    if (!n) return;
    const r = Math.max(0, Math.min(n - 1, kbRow() + delta));
    setKbRow(r);
    setRefCursor(-1);
    const v = view();
    // With details open, arrows move the details to the adjacent commit (Git Graph behaviour).
    if (v.commit && v.view !== "graph" && !v.compare) navigate({ commit: rows.commits[r]!.hash, file: null }, { replace: true });
    scrollToRow(r);
    maybeLoadMore(r);
  }

  function maybeLoadMore(r: number) {
    if (!rows.complete && r > rows.length - 400) growWindow();
  }

  function jumpTo(r: number) {
    if (r < 0 || r >= rows.length) return;
    setKbRow(r);
    setRefCursor(-1);
    const v = view();
    if (v.commit && v.view !== "graph" && !v.compare) navigate({ commit: rows.commits[r]!.hash, file: null }, { replace: true });
    scrollToRow(r, "center");
    maybeLoadMore(r);
  }

  /** Parent/child traversal. `alt` follows the second parent / another child. */
  function toParent(alt = false) {
    const c = rows.commits[kbRow()];
    if (!c) return;
    const ps = c.parents.filter((p) => rows.index.has(p));
    const p = alt ? (ps[1] ?? ps[0]) : ps[0];
    if (p !== undefined) jumpTo(rows.index.get(p)!);
    else if (c.parents.length && !rows.complete) {
      void ensureRow(c.parents[alt ? 1 : 0] ?? c.parents[0]!).then((r) => r >= 0 && jumpTo(r));
    } else toast("info", "This commit has no parent in the shown history");
  }
  function toChild(alt = false) {
    const r0 = kbRow();
    const c = rows.commits[r0];
    if (!c) return;
    const kids: number[] = [];
    for (let r = r0 - 1; r >= 0; r--) if (rows.commits[r]!.parents.includes(c.hash)) kids.push(r);
    if (!kids.length) return toast("info", "This commit has no child in the shown history");
    // Prefer the child in the same lane (same branch); alt picks another one.
    const lane = rows.nodeLane[r0];
    const same = kids.find((r) => rows.commits[r]!.parents[0] === c.hash && rows.nodeLane[r] === lane) ?? kids[kids.length - 1]!;
    jumpTo(alt ? (kids.find((r) => r !== same) ?? same) : same);
  }

  function goHead() {
    const h = repo.status && rows.commits[0]?.hash === WORKING ? WORKING : headCommit();
    if (!h) return toast("info", "HEAD is not available for this repository");
    const r = rows.index.get(h === WORKING ? (headCommit() ?? h) : h);
    if (r !== undefined) jumpTo(r);
    else void revealCommit(h);
  }

  function nextStash(dir: 1 | -1) {
    const stashes = new Set((repo.refs?.refs ?? []).filter((r) => r.kind === "stash").map((r) => r.commit));
    if (!stashes.size) return toast("info", "No stashes in this repository");
    const n = rows.length;
    for (let i = 1; i <= n; i++) {
      const r = (kbRow() + dir * i + n) % n;
      if (stashes.has(rows.commits[r]!.hash)) return jumpTo(r);
    }
    toast("info", "No stash in the loaded commits");
  }

  // ------------------------------------------------------------------ find

  async function runFind(text: string, keepCurrent = false) {
    const seq = ++findSeq;
    // A re-run after new rows (keepCurrent) can supersede the user's own search while it is in
    // flight; the jump that search owes must still happen.
    if (!keepCurrent) {
      findJump = true;
      findSearched = text;
      setFind("text", text);
    }
    if (!text.trim()) {
      findJump = false;
      setFind({ matches: [], current: -1 });
      return;
    }
    const refNames: Record<string, string[]> = {};
    for (const r of repo.refs?.refs ?? []) (refNames[r.commit] ??= []).push(r.short);
    const matches = await engine.call<number[]>({ method: "search", args: { session, text, refs: refNames } }).catch(() => [] as number[]);
    if (seq !== findSeq) return;
    const jump = findJump;
    findJump = false;
    let current = !jump && find.current >= 0 ? Math.min(find.current, matches.length - 1) : matches.findIndex((r) => r >= kbRow());
    if (current < 0 && matches.length) current = 0;
    setFind({ matches, current });
    if (jump && current >= 0) jumpTo(matches[current]!);
    const t = text.trim().toLowerCase();
    if (!matches.length && /^[0-9a-f]{4,64}$/.test(t) && repoId()) {
      // A hash that is not in the graph yet: look it up, then widen the window until it shows.
      const hit = (await zero.run(queries.repo.commitsByPrefix({ repoId: repoId()!, prefix: t }))) as { hash: string }[];
      const r = await ensureRow(hit[0]?.hash ?? t, 200_000);
      if (seq === findSeq && r >= 0) {
        setFind({ matches: [r], current: 0 });
        jumpTo(r);
      }
    }
  }
  function findStep(dir: 1 | -1) {
    if (!find.matches.length) return;
    const cur = (find.current + dir + find.matches.length) % find.matches.length;
    setFind("current", cur);
    jumpTo(find.matches[cur]!);
  }

  // ------------------------------------------------------------------ account, recents

  function loginUrl() {
    return `/auth/login?returnTo=${encodeURIComponent(address.path())}`;
  }
  function githubConnectUrl() {
    return `/auth/github/connect?returnTo=${encodeURIComponent(address.path())}`;
  }

  /** A companion's pairing code from `git-graph pair` / `git-graph open` (#claim=…): bind it to us. */
  function claimFromFragment() {
    const m = /(?:^|[#&])claim=([A-Za-z0-9_-]{6,128})/.exec(address.hash());
    if (!m) return;
    const code = m[1]!;
    // Strip the code from the address bar and history immediately.
    address.replace(address.path());
    if (!boot.accountId) {
      toast("error", "Sign in to connect the companion", "Then run `git-graph pair` again.", { label: "Sign in", run: () => (location.href = loginUrl()) });
      return;
    }
    void mutate(mutators.agent.claim({ code, now: Date.now() })).server.then((r) => {
      if (r.type === "error") toast("error", "Could not connect the companion", r.error?.message);
      else toast("success", "Companion connected: your local repositories sync to this account");
    });
  }

  function rememberRecent(r: RecentRepo) {
    const prev = lastVisit.get(r.key);
    if (prev && r.at - prev < 60_000) return;
    lastVisit.set(r.key, r.at);
    if (boot.accountId) {
      mutate(mutators.repo.visit({ repoId: r.key, name: r.name, path: r.path ?? null, now: r.at }));
      return;
    }
    const list = [r, ...localRecents().filter((x) => x.key !== r.key)].slice(0, 20);
    setLocalRecents(list);
    save("lanes.recents", list);
  }

  function setColumns(c: Columns) {
    setColumnsSignal(c);
    save("lanes.columns.v2", c);
  }

  function setTheme(t: "system" | "light" | "dark") {
    setThemeSignal(t);
    save("lanes.themePref", t);
    try {
      if (t === "system") {
        localStorage.removeItem("lanes.theme");
        delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem("lanes.theme", t);
        document.documentElement.dataset.theme = t;
      }
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ dialogs

  function ask(spec: Omit<DialogSpec, "resolve">): Promise<Record<string, string | boolean> | null> {
    const restore = document.activeElement as HTMLElement | null;
    return new Promise((resolve) => {
      setDialog({
        ...spec,
        resolve: (v) => {
          setDialog(null);
          resolve(v);
          restoreFocus(() => (restore && restore !== document.body ? restore : null));
        },
      });
    });
  }

  // Replace ?at= while scrolling (no history entries).
  let atTimer: ReturnType<typeof setTimeout> | null = null;
  function onScrolled(top: number) {
    if (atTimer) clearTimeout(atTimer);
    atTimer = setTimeout(() => {
      const r = rowAt(top);
      const c = rows.commits[r];
      const at = r > 0 && c && c.hash !== WORKING ? c.hash : null;
      if (at !== view().at) navigate({ at }, { replace: true });
    }, 400);
    maybeLoadMore(rowAt(top + (scrollEl?.clientHeight ?? 0)));
  }

  // Preload recent repositories (refs and the newest commits), so switching to one is instant.
  const preloads: { cleanup: () => void }[] = [];
  createComputed(
    on(
      () => recents()
        .slice(0, 5)
        .map((r) => r.key)
        .join("\n"),
      (keys) => {
        for (const p of preloads.splice(0)) p.cleanup();
        if (IN_STORYBOOK || !keys) return;
        for (const key of keys.split("\n")) {
          preloads.push(zero.preload(queries.repo.byId({ repoId: key }), { ttl: "5m" }));
          preloads.push(zero.preload(queries.repo.refs({ repoId: key }), { ttl: "5m" }));
          preloads.push(zero.preload(queries.repo.commits({ repoId: key, limit: INITIAL_WINDOW }), { ttl: "5m" }));
        }
      },
    ),
  );

  return {
    engine,
    rows,
    rowsVersion,
    bumpRows: () => setRowsVersion((x) => x + 1),
    view,
    urlWarnings,
    repo,
    setRepo,
    auth,
    /** Stories and tests only: pin the session state. */
    setAuth,
    loginUrl,
    githubConnectUrl,
    claimFromFragment,
    companions,
    columns,
    setColumns,
    recents,
    rememberRecent,
    theme,
    setTheme,
    kbRow,
    setKbRow,
    refCursor,
    setRefCursor,
    paletteOpen,
    setPaletteOpen,
    find,
    setFind,
    runFind,
    findStep,
    menu,
    setMenu,
    dialog,
    ask,
    helpOpen,
    setHelpOpen,
    tooltip,
    setTooltip,
    toasts,
    toast,
    dismissToast,
    busy,
    setBusy,
    metrics,
    refsByCommit,
    combinedRemotes,
    headCommit,
    headBranch,
    navigate,
    repoId,
    ensureRow,
    sessionId: () => session,
    /** Reactive id of the current repository session. */
    readySession: sessionSig,
    setScrollEl,
    getScrollEl: () => scrollEl,
    expandedRow,
    rowTop,
    rowAt,
    scrollToRow,
    onScrolled,
    primaryHash,
    openDetails,
    closeDetails,
    toggleSelect,
    compareWith,
    openDiff,
    closeDiff,
    focusGraph,
    restoreFocus,
    moveKb,
    jumpTo,
    toParent,
    toChild,
    goHead,
    nextStash,
    revealCommit,
    focusMemory,
  };
}

export type App = ReturnType<typeof createApp>;

export const app: App = createRoot(() => createApp());

export { EMPTY_VIEW };
