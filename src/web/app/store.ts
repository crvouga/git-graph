// Application controller. The URL (ViewState) is the source of truth for shareable navigation;
// everything else here is ephemeral UI state or data pushed by the engine worker.

import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { AppError, repoKey, type Capabilities, type HistoryQuery, type Ref, type RefsSnapshot, type RepoInfo, type RepoRef, type WorkingTreeStatus } from "../../core/types.ts";
import { EMPTY_VIEW, parseUrl, serialize, shouldPush, WORKING, type ViewState } from "../../core/url/state.ts";
import { Engine, GraphRows } from "../engine/client.ts";
import type { EngineEvent, SourceConfig, SyncInfo } from "../engine/protocol.ts";
import { loadHandle } from "./handles.ts";
import { address } from "./address.ts";
import { IN_STORYBOOK } from "./env.ts";

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
// Persistence helpers (localStorage is only used for per-user preferences, never credentials
// for GitHub; the companion bearer token is a localhost-only secret stored per origin).
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

export interface CompanionConfig {
  baseUrl: string;
  token: string | null;
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
    error: { code: string; message: string } | null;
    loading: boolean;
    missingRefs: string[];
  }>({ info: null, caps: null, refs: null, status: null, sync: null, error: null, loading: false, missingRefs: [] });

  const [auth, setAuth] = createStore<AuthState>({
    checked: false,
    serverAvailable: false,
    authenticated: false,
    user: null,
    github: null,
    loginEnabled: false,
    githubEnabled: false,
  });

  const [companion, setCompanionSignal] = createSignal<CompanionConfig>(load("lanes.companion", { baseUrl: "http://127.0.0.1:7420", token: null }));
  const [columns, setColumnsSignal] = createSignal<Columns>(load("lanes.columns.v2", DEFAULT_COLUMNS));
  const [recents, setRecents] = createSignal<RecentRepo[]>(load("lanes.recents", []));
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
  const [busy, setBusy] = createSignal<string | null>(null);
  const [metrics, setMetrics] = createStore<Record<string, number>>({});
  (globalThis as { __lanesMetrics?: Record<string, number> }).__lanesMetrics = metrics;
  /** Restores focus after nested views close: details → commit row, diff → file item. */
  const focusMemory = { detailsFrom: null as string | null, diffFrom: null as string | null };

  let session = 0;
  const [sessionSig, setSessionSig] = createSignal(0);
  let toastId = 0;

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
    const repoChanged = (prev.repo ? repoKey(prev.repo) : null) !== (next.repo ? repoKey(next.repo) : null);
    const queryChanged =
      prev.branches.join("\n") !== next.branches.join("\n") ||
      prev.display.remotes !== next.display.remotes ||
      prev.display.tags !== next.display.tags ||
      prev.display.stashes !== next.display.stashes ||
      prev.display.order !== next.display.order ||
      prev.display.firstParent !== next.display.firstParent;
    if (repoChanged || queryChanged || prev.worktree !== next.worktree) void openRepo(next);
    else if (next.commit && next.commit !== prev.commit) void revealCommit(next.commit);
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

  // ------------------------------------------------------------------ repository sessions

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

  async function sourceFor(r: RepoRef): Promise<SourceConfig> {
    if (r.provider === "github") return { kind: "server", baseUrl: `${location.origin}/api/v1` };
    if (r.provider === "local") {
      const c = companion();
      if (!c.token) throw new AppError("UNAUTHENTICATED", "This is a local repository. Connect the git-graph companion first (run `git-graph open .` in the repository, or use “Connect local companion…”).");
      return { kind: "companion", baseUrl: `${c.baseUrl}/api/v1`, token: c.token };
    }
    const handle = await loadHandle(r.id);
    if (!handle) throw new AppError("NOT_FOUND", "This browser no longer has access to that folder. Use “Open folder…” to pick it again.");
    const perm = await (handle as FileSystemDirectoryHandle & { queryPermission?: (o: object) => Promise<string> }).queryPermission?.({ mode: "read" });
    if (perm && perm !== "granted") throw new AppError("FORBIDDEN", "The browser needs your permission to read this folder again.", { reauthorize: r.id });
    return { kind: "fs", handle };
  }

  async function openRepo(v: ViewState) {
    const mySession = ++session;
    const r = v.repo;
    batch(() => {
      rows.apply({ t: "rows", session: mySession, kind: "reset", commits: [], layout: { from: 0, nodeLane: new Int16Array(0), nodeColor: new Int16Array(0), edgeStart: new Uint32Array(1), edges: new Int16Array(0), tail: new Int16Array(0), width: 0 }, complete: false, stale: true, refs: { head: { kind: "none" }, refs: [], version: "" } });
      setRowsVersion((x) => x + 1);
      setRepo(reconcile({ info: null, caps: null, refs: null, status: null, sync: null, error: null, loading: !!r, missingRefs: [] }));
      setFind({ open: find.open, text: find.text, matches: [], current: -1 });
      setKbRow(0);
      setRefCursor(-1);
    });
    if (!r) {
      void engine.call({ method: "close", args: { session: mySession - 1 } }).catch(() => {});
      return;
    }
    const key = repoKey(r);
    try {
      const source = await sourceFor(r);
      if (mySession !== session) return;
      const res = await engine.call<{ row: number }>({
        method: "open",
        args: { session: mySession, repoKey: key, source, query: queryFor(v), initial: 300, ensure: v.at ?? (v.commit && v.commit !== WORKING ? v.commit : v.commit) ?? null },
      });
      if (mySession !== session) return;
      setRepo("loading", false);
      setSessionSig(mySession);
      const target = v.at ?? v.commit;
      if (target) {
        if (res.row >= 0) {
          setKbRow(res.row);
          requestAnimationFrame(() => scrollToRow(res.row, v.at ? "top" : "center"));
        } else if (v.commit) {
          toast("error", `Commit ${v.commit.slice(0, 10)} was not found`, "It may have been rewritten or deleted, or it is not reachable from the branches shown. Try “Show All” branches.");
        }
      }
      const info = repo.info;
      if (info) rememberRecent({ key, name: info.name, path: info.worktreePath, at: Date.now() });
    } catch (e) {
      if (mySession !== session) return;
      const err = AppError.from(e);
      if (err.code === "CANCELLED") return;
      setRepo({ loading: false, error: { code: err.code, message: err.message } });
    }
  }

  engine.on((ev: EngineEvent) => {
    if ("session" in ev && ev.session !== session) return; // stale session: never touch the new view
    switch (ev.t) {
      case "rows": {
        const anchor = captureAnchor();
        rows.apply(ev);
        if (ev.kind !== "append") {
          setRepo("refs", ev.refs);
          checkMissingRefs(ev.refs);
        }
        setRowsVersion((x) => x + 1);
        if (ev.kind !== "append") restoreAnchor(anchor);
        if (find.open && find.text) void runFind(find.text, true);
        break;
      }
      case "repo":
        setRepo({ info: ev.info, caps: ev.caps });
        break;
      case "status":
        setRepo("status", ev.status);
        break;
      case "sync":
        setRepo("sync", ev.sync);
        break;
      case "error":
        if (ev.error.code === "UNAUTHENTICATED" || ev.error.code === "FORBIDDEN" || ev.error.code === "NOT_FOUND") {
          setRepo("error", ev.error);
          if (ev.error.code === "UNAUTHENTICATED") void checkSession();
        } else toast("error", ev.error.message);
        break;
      case "metric": {
        setMetrics(ev.name, Math.round(ev.value * 10) / 10);
        const log = ((globalThis as { __lanesEvents?: unknown[] }).__lanesEvents ??= []);
        log.push({ at: Date.now(), metric: ev.name, value: Math.round(ev.value) });
        if (log.length > 100) log.shift();
        break;
      }
      case "event": {
        // Recent repository events, for diagnostics and automated tests.
        const log = ((globalThis as { __lanesEvents?: unknown[] }).__lanesEvents ??= []);
        log.push({ at: Date.now(), ...ev.event });
        if (log.length > 100) log.shift();
        break;
      }
    }
  });

  function checkMissingRefs(snap: RefsSnapshot) {
    const v = view();
    const names = new Set<string>();
    for (const r of snap.refs) {
      names.add(r.short);
      names.add(r.name);
    }
    const missing = v.branches.filter((b) => !names.has(b));
    setRepo("missingRefs", missing);
    if (v.focusBranch && !names.has(v.focusBranch)) setRepo("missingRefs", [...missing, v.focusBranch]);
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

  // ------------------------------------------------------------------ geometry & scrolling

  let scrollEl: HTMLElement | null = null;
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
    if (r < 0 && hash !== WORKING) {
      r = await engine.call<number>({ method: "ensure", args: { session, hash } }).catch(() => -1);
    }
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
    if (!rows.complete && r > rows.length - 400) void engine.call({ method: "loadMore", args: { session, count: 1000 } }).catch(() => {});
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
      void engine.call<number>({ method: "ensure", args: { session, hash: c.parents[alt ? 1 : 0] ?? c.parents[0]! } }).then((r) => r >= 0 && jumpTo(r));
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

  let findSeq = 0;
  async function runFind(text: string, keepCurrent = false) {
    const seq = ++findSeq;
    setFind("text", text);
    if (!text.trim()) {
      setFind({ matches: [], current: -1 });
      return;
    }
    const matches = await engine.call<number[]>({ method: "search", args: { session, text } }).catch(() => [] as number[]);
    if (seq !== findSeq) return;
    let current = keepCurrent && find.current >= 0 ? Math.min(find.current, matches.length - 1) : matches.findIndex((r) => r >= kbRow());
    if (current < 0 && matches.length) current = 0;
    setFind({ matches, current });
    if (!keepCurrent && current >= 0) jumpTo(matches[current]!);
    if (!matches.length && /^[0-9a-f]{4,40}$/i.test(text.trim()) && !rows.complete) {
      // Hash not loaded yet: ask the repository, then load history until it appears.
      const r = await engine.call<number>({ method: "ensure", args: { session, hash: text.trim().toLowerCase(), maxRows: 200_000 } }).catch(() => -1);
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

  // ------------------------------------------------------------------ session, companion, recents

  async function checkSession() {
    try {
      const res = await fetch("/api/v1/session", { credentials: "include", headers: { accept: "application/json" } });
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok || !ct.includes("json")) throw new Error("no server");
      const s = (await res.json()) as { authenticated: boolean; user?: AuthUser | null; github?: AuthGitHub | null; loginUrl?: string | null; githubConnectUrl?: string | null };
      setAuth({ checked: true, serverAvailable: true, authenticated: s.authenticated, user: s.user ?? null, github: s.github ?? null, loginEnabled: !!s.loginUrl, githubEnabled: !!s.githubConnectUrl });
    } catch {
      setAuth({ checked: true, serverAvailable: false, authenticated: false, user: null, github: null, loginEnabled: false, githubEnabled: false });
    }
  }
  function loginUrl() {
    return `/auth/login?returnTo=${encodeURIComponent(address.path())}`;
  }
  function githubConnectUrl() {
    return `/auth/github/connect?returnTo=${encodeURIComponent(address.path())}`;
  }

  function setCompanion(c: CompanionConfig) {
    setCompanionSignal(c);
    save("lanes.companion", c);
  }

  /** One-time pairing: `git-graph open` puts a single-use code in the URL fragment (never sent to servers). */
  async function pairFromFragment() {
    const m = /(?:^|[#&])pair=([A-Za-z0-9_-]{6,128})/.exec(address.hash());
    if (!m) return;
    const code = m[1]!;
    const port = /(?:^|[#&])companion=(\d{2,5})/.exec(address.hash())?.[1];
    // Strip the code from the address bar and history immediately.
    address.replace(address.path());
    const base = port ? `http://127.0.0.1:${port}` : companion().baseUrl;
    await pairCompanion(code, base);
  }

  async function pairCompanion(code: string, baseUrl = companion().baseUrl): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const body = (await res.json().catch(() => null)) as { token?: string; error?: { message: string } } | null;
      if (!res.ok || !body?.token) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setCompanion({ baseUrl, token: body.token });
      toast("success", "Connected to the local git-graph companion");
      return true;
    } catch (e) {
      toast("error", "Could not pair with the local companion", `${e instanceof Error ? e.message : String(e)} — run \`git-graph pair\` and paste the new code.`);
      return false;
    }
  }

  function rememberRecent(r: RecentRepo) {
    const list = [r, ...recents().filter((x) => x.key !== r.key)].slice(0, 20);
    setRecents(list);
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

  // ------------------------------------------------------------------ visibility → engine

  const sendVisibility = () =>
    void engine.call({ method: "visibility", args: { visible: document.visibilityState === "visible", focused: document.hasFocus(), online: navigator.onLine } }).catch(() => {});
  document.addEventListener("visibilitychange", sendVisibility);
  window.addEventListener("focus", sendVisibility);
  window.addEventListener("online", sendVisibility);
  window.addEventListener("offline", sendVisibility);

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
    checkSession,
    loginUrl,
    githubConnectUrl,
    companion,
    setCompanion,
    pairCompanion,
    pairFromFragment,
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
    openRepo,
    sessionId: () => session,
    /** Reactive id of the session whose repository finished opening (0 = none yet). */
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
