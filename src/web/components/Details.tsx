// Commit details / comparison / uncommitted changes, expanded in place under the selected row.

import { createEffect, createMemo, createResource, createSignal, For, Show, on } from "solid-js";
import { AppError, type CommitDetails, type Diff, type FileChange, type WorkingTreeStatus } from "../../core/types.ts";
import { WORKING } from "../../core/url/state.ts";
import { app } from "../app/store.ts";
import { executeRemote, invokeMutation, openMenu, portCall, BINDERS, type UiContext } from "../app/commands.ts";
import { formatDate } from "./GraphView.tsx";
import { IconClose, IconFile, IconFolder, IconList, IconTree } from "./icons.tsx";

// ---------------------------------------------------------------------------
// Reviewed-file tracking (Git Graph "Code Review"): persisted per commit / comparison, 90-day expiry.
// ---------------------------------------------------------------------------

const REVIEW_KEY = "lanes.review";
const NINETY_DAYS = 90 * 24 * 3600 * 1000;
type ReviewStore = Record<string, { files: string[]; at: number }>;

function loadReviews(): ReviewStore {
  try {
    const s = JSON.parse(localStorage.getItem(REVIEW_KEY) ?? "{}") as ReviewStore;
    const now = Date.now();
    for (const k of Object.keys(s)) if (now - s[k]!.at > NINETY_DAYS) delete s[k];
    return s;
  } catch {
    return {};
  }
}
const [reviews, setReviews] = createSignal<ReviewStore>(loadReviews());
function saveReviews(s: ReviewStore) {
  setReviews(s);
  try {
    localStorage.setItem(REVIEW_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
export function reviewKey(): string | null {
  const v = app.view();
  if (!v.repo || !v.commit || v.commit === WORKING) return null;
  return `${app.repo.info?.key ?? ""}|${v.commit}|${v.compare ?? ""}`;
}
export function isReviewed(path: string): boolean {
  const k = reviewKey();
  return !!k && !!reviews()[k]?.files.includes(path);
}
export function setReviewed(path: string, on: boolean) {
  const k = reviewKey();
  if (!k) return;
  const s = { ...reviews() };
  const files = new Set(s[k]?.files ?? []);
  if (on) files.add(path);
  else files.delete(path);
  s[k] = { files: [...files], at: Date.now() };
  saveReviews(s);
}

// ---------------------------------------------------------------------------
// File tree with compact folders
// ---------------------------------------------------------------------------

export interface FileEntry extends FileChange {
  area: "commit" | "staged" | "unstaged" | "untracked" | "conflicted";
}

interface TreeItem {
  key: string;
  depth: number;
  folder: string | null;
  file: FileEntry | null;
  label: string;
}

function buildTree(files: FileEntry[], collapsed: Set<string>, tree: boolean): TreeItem[] {
  if (!tree) return files.map((f) => ({ key: `${f.area}:${f.path}`, depth: 0, folder: null, file: f, label: f.path }));
  interface Node {
    dirs: Map<string, Node>;
    files: FileEntry[];
  }
  const root: Node = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let n = root;
    for (const p of parts.slice(0, -1)) {
      let d = n.dirs.get(p);
      if (!d) n.dirs.set(p, (d = { dirs: new Map(), files: [] }));
      n = d;
    }
    n.files.push(f);
  }
  const out: TreeItem[] = [];
  const walk = (n: Node, depth: number, prefix: string) => {
    for (const [name0, d0] of [...n.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      let name = name0;
      let d = d0;
      // Compact folders that only contain a single folder.
      while (d.files.length === 0 && d.dirs.size === 1) {
        const [cn, cd] = [...d.dirs.entries()][0]!;
        name = `${name}/${cn}`;
        d = cd;
      }
      const path = prefix ? `${prefix}/${name}` : name;
      out.push({ key: `dir:${path}`, depth, folder: path, file: null, label: name });
      if (!collapsed.has(path)) walk(d, depth + 1, path);
    }
    for (const f of n.files.sort((a, b) => a.path.localeCompare(b.path))) out.push({ key: `${f.area}:${f.path}`, depth, folder: null, file: f, label: f.path.split("/").pop()! });
  };
  walk(root, 0, "");
  return out;
}

function diffToFiles(d: Diff): FileEntry[] {
  return d.files.map((f) => {
    let add = 0;
    let del = 0;
    for (const h of f.hunks) for (const l of h.lines) l.kind === "add" ? add++ : l.kind === "del" ? del++ : 0;
    return { path: f.path, oldPath: f.oldPath, status: f.status, binary: f.binary, additions: add, deletions: del, area: "commit" as const };
  });
}

function workingFiles(s: WorkingTreeStatus): FileEntry[] {
  return [
    ...s.conflicted.map((f) => ({ ...f, area: "conflicted" as const })),
    ...s.staged.map((f) => ({ ...f, area: "staged" as const })),
    ...s.unstaged.map((f) => ({ ...f, area: "unstaged" as const })),
    ...s.untracked.map((p) => ({ path: p, status: "?" as const, area: "untracked" as const })),
  ];
}

const AREA_TITLE = { conflicted: "Merge Conflicts", staged: "Staged Changes", unstaged: "Changes", untracked: "Untracked Files", commit: "" } as const;

export function Details() {
  const v = app.view;
  const [treeMode, setTreeMode] = createSignal<boolean>(localStorage.getItem("lanes.fileView") !== "list");
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const [active, setActive] = createSignal(0);
  let listEl!: HTMLDivElement;

  const isWorking = () => v().commit === WORKING;
  const pair = createMemo(() => {
    const a = v().commit;
    const b = v().compare;
    if (!a || !b) return null;
    // Compare older → newer regardless of the order they were selected in.
    const ra = app.rows.index.get(a) ?? 0;
    const rb = app.rows.index.get(b) ?? 0;
    return ra > rb ? { base: a, head: b } : { base: b, head: a };
  });

  const [details] = createResource(
    () => (!isWorking() && !v().compare && v().commit && app.repo.caps ? { h: v().commit!, s: app.sessionId() } : null),
    async ({ h }) => {
      const full = app.rows.commits[app.rows.index.get(h) ?? -1]?.hash ?? h;
      return portCall<CommitDetails>("commit", [full]);
    },
  );
  const [comparison] = createResource(
    () => (pair() && app.repo.caps ? { ...pair()!, s: app.sessionId() } : null),
    async (p) => portCall<Diff>("diff", [{ kind: "compare", base: p.base, head: p.head }]),
  );

  const files = createMemo<FileEntry[]>(() => {
    if (isWorking()) return app.repo.status ? workingFiles(app.repo.status) : [];
    if (v().compare) return comparison() ? diffToFiles(comparison()!) : [];
    return details()?.files.map((f) => ({ ...f, area: "commit" as const })) ?? [];
  });

  const items = createMemo(() => {
    if (!isWorking()) return buildTree(files(), collapsed(), treeMode());
    // Working tree: group by area, each group a flat list (area headers are not focusable).
    return files().map((f) => ({ key: `${f.area}:${f.path}`, depth: 0, folder: null, file: f, label: f.path }));
  });

  createEffect(on(() => `${v().commit}|${v().compare}`, () => setActive(0)));

  const reviewedCount = createMemo(() => {
    reviews();
    return files().filter((f) => isReviewed(f.path)).length;
  });

  const focusItem = (i: number) => {
    const n = items().length;
    if (!n) return;
    const j = Math.max(0, Math.min(n - 1, i));
    setActive(j);
    listEl?.querySelector<HTMLElement>(`[data-index="${j}"]`)?.focus();
  };

  const fileCtx = (f: FileEntry): UiContext => ({ commit: null, ref: null, file: { path: f.path, area: f.area }, hunk: null, worktree: null });

  const openFile = (f: FileEntry) => {
    if (f.area === "conflicted") return app.openDiff(f.path);
    if (!isWorking()) setReviewed(f.path, true);
    app.openDiff(f.path);
  };

  const onKey = (e: KeyboardEvent) => {
    const it = items()[active()];
    const f = it?.file;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        focusItem(active() + 1);
        break;
      case "ArrowUp":
        if (active() === 0) app.focusGraph();
        else focusItem(active() - 1);
        break;
      case "Home":
        focusItem(0);
        break;
      case "End":
        focusItem(items().length - 1);
        break;
      case "ArrowLeft":
        if (it?.folder && !collapsed().has(it.folder)) setCollapsed(new Set([...collapsed(), it.folder]));
        else {
          // Move to the parent folder.
          for (let i = active() - 1; i >= 0; i--) if (items()[i]!.folder && items()[i]!.depth < (it?.depth ?? 0)) return focusItem(i);
        }
        break;
      case "ArrowRight":
        if (it?.folder && collapsed().has(it.folder)) {
          const s = new Set(collapsed());
          s.delete(it.folder);
          setCollapsed(s);
        } else focusItem(active() + 1);
        break;
      case "Enter":
        if (f) openFile(f);
        else if (it?.folder) {
          const s = new Set(collapsed());
          s.has(it.folder) ? s.delete(it.folder) : s.add(it.folder);
          setCollapsed(s);
        }
        break;
      case "v":
        if (f && !isWorking()) setReviewed(f.path, !isReviewed(f.path));
        else handled = false;
        break;
      case " ":
        if (f && isWorking()) void toggleStage(f);
        else handled = false;
        break;
      case "Tab":
        if (!e.shiftKey) return;
        app.focusGraph();
        break;
      case "F10":
        if (!e.shiftKey) return;
        if (f) openFileMenu(f);
        break;
      case "ContextMenu":
        if (f) openFileMenu(f);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const toggleStage = async (f: FileEntry) => {
    const id = f.area === "staged" ? "git.unstage" : "git.stage";
    await invokeMutation(id, fileCtx(f));
  };

  const openFileMenu = (f: FileEntry, at?: { x: number; y: number }) => {
    const ctx = fileCtx(f);
    const el = listEl?.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(f.path)}"]`);
    const r = el?.getBoundingClientRect();
    const pos = at ?? { x: (r?.left ?? 200) + 20, y: (r?.bottom ?? 200) + 2 };
    const restore = el ?? null;
    const extra = [
      { id: "file.open", label: f.area === "conflicted" ? "Resolve Conflict…" : "Open Diff", shortcut: "Enter", run: () => openFile(f) },
      ...(!isWorking()
        ? [{ id: "file.review", label: isReviewed(f.path) ? "Mark as Not Reviewed" : "Mark as Reviewed", shortcut: "v", run: () => setReviewed(f.path, !isReviewed(f.path)) }]
        : []),
      { id: "file.copy", label: "Copy Path", run: () => void navigator.clipboard.writeText(f.path).then(() => app.toast("success", "Copied path")) },
      ...(!isWorking() && f.status !== "D" ? [{ id: "file.view", label: "View File at This Revision", run: () => void viewFile(f.path, pair()?.head ?? v().commit!) }] : []),
      { id: "file.history", label: "File History", run: () => void fileHistory(f.path) },
    ];
    if (!isWorking()) {
      app.setMenu({ x: pos.x, y: pos.y, title: f.path, items: extra, restore });
      return;
    }
    // Working tree: add the registry's file actions (stage, unstage, discard…).
    openMenu("file", ctx, pos);
    const m = app.menu();
    if (m) app.setMenu({ ...m, items: [...extra, { id: "sep", label: "", separator: true }, ...m.items], restore });
  };

  return (
    <div class="flex h-full w-full" role="region" aria-label={isWorking() ? "Uncommitted changes" : v().compare ? "Commit comparison" : "Commit details"}>
      <div class="summary">
        <Show when={isWorking()}>
          <WorkingSummary status={app.repo.status} />
        </Show>
        <Show when={!isWorking() && v().compare}>
          <div class="mb-2 font-bold">Comparing commits</div>
          <div>
            <b>From:</b> <span class="mono">{pair()?.base.slice(0, 10)}</span> {app.rows.commits[app.rows.index.get(pair()?.base ?? "") ?? -1]?.subject}
          </div>
          <div>
            <b>To:</b> <span class="mono">{pair()?.head.slice(0, 10)}</span> {app.rows.commits[app.rows.index.get(pair()?.head ?? "") ?? -1]?.subject}
          </div>
          <div class="mt-2 text-muted">{comparison.loading ? "Loading…" : `${files().length} files changed`}</div>
          <Show when={comparison.error}>
            <div class="text-del mt-2">{AppError.from(comparison.error).message}</div>
          </Show>
        </Show>
        <Show when={!isWorking() && !v().compare}>
          <Show when={details()} fallback={<div class="text-muted">{details.error ? <span class="text-del">{AppError.from(details.error).message}</span> : "Loading…"}</div>}>
            {(d) => (
              <div>
                <div>
                  <b>Commit: </b>
                  <span class="mono select-all">{d().hash}</span>
                </div>
                <div>
                  <b>Parents: </b>
                  <For each={d().parents} fallback={<span class="text-muted">none (root commit)</span>}>
                    {(p, i) => (
                      <>
                        {i() > 0 && ", "}
                        <a
                          href="#"
                          tabIndex={-1}
                          class="mono text-link"
                          onClick={(e) => {
                            e.preventDefault();
                            app.navigate({ commit: p, view: "details", compare: null, file: null });
                          }}
                        >
                          {p.slice(0, 10)}
                        </a>
                      </>
                    )}
                  </For>
                </div>
                <div>
                  <b>Author: </b>
                  {d().author.name} &lt;<a class="text-link" tabIndex={-1} href={`mailto:${d().author.email}`}>{d().author.email}</a>&gt;
                </div>
                <div>
                  <b>Date: </b>
                  {new Date(d().author.date * 1000).toString()}
                </div>
                <Show when={d().committer.name !== d().author.name || d().committer.date !== d().author.date}>
                  <div>
                    <b>Committer: </b>
                    {d().committer.name} ({formatDate(d().committer.date)})
                  </div>
                </Show>
                <Show when={d().signature && d().signature!.status !== "none"}>
                  <div>
                    <b>Signature: </b>
                    {d().signature!.status} {d().signature!.signer ?? ""}
                  </div>
                </Show>
                <p class="mt-3 font-semibold whitespace-pre-wrap">{d().subject}</p>
                <Show when={d().body.trim()}>
                  <p class="mt-1 whitespace-pre-wrap">{linkify(d().body.trim())}</p>
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </div>
      <div class="files" ref={listEl} role="tree" aria-label="Changed files" onKeyDown={onKey}>
        <Show when={!isWorking() && files().length}>
          <div class="px-3 pb-1 text-xs text-muted" aria-live="polite">
            Reviewed {reviewedCount()} / {files().length}
            {details()?.filesTruncated ? " · file list truncated by the provider" : ""}
          </div>
        </Show>
        <For each={items()}>
          {(it, i) => {
            const f = it.file;
            const prevArea = () => (i() > 0 ? items()[i() - 1]!.file?.area : null);
            return (
              <>
                <Show when={isWorking() && f && f.area !== prevArea()}>
                  <div class="px-3 pt-2 pb-1 text-xs font-bold uppercase text-muted" role="presentation">
                    {AREA_TITLE[f!.area]}
                  </div>
                </Show>
                <div
                  class={`file-item status-${f?.status ?? ""}`}
                  classList={{ active: active() === i(), unreviewed: !!f && !isWorking() && !isReviewed(f.path) && reviewedCount() > 0 }}
                  style={{ "padding-left": `${10 + it.depth * 16}px` }}
                  role="treeitem"
                  aria-level={it.depth + 1}
                  aria-expanded={it.folder ? !collapsed().has(it.folder) : undefined}
                  aria-label={f ? `${f.path}, ${statusWord(f.status)}${f.oldPath ? ` from ${f.oldPath}` : ""}${f.binary ? ", binary" : ""}${!isWorking() ? (isReviewed(f.path) ? ", reviewed" : ", not reviewed") : `, ${f.area}`}` : `folder ${it.label}`}
                  tabIndex={active() === i() ? 0 : -1}
                  data-index={i()}
                  data-file-path={f?.path}
                  onFocus={() => setActive(i())}
                  onClick={() => {
                    setActive(i());
                    if (f) openFile(f);
                    else if (it.folder) {
                      const s = new Set(collapsed());
                      s.has(it.folder) ? s.delete(it.folder) : s.add(it.folder);
                      setCollapsed(s);
                    }
                  }}
                  onContextMenu={(e) => {
                    if (!f) return;
                    e.preventDefault();
                    setActive(i());
                    openFileMenu(f, { x: e.clientX, y: e.clientY });
                  }}
                >
                  {f ? <IconFile /> : <IconFolder />}
                  <span class={f ? "path" : ""}>{it.label}</span>
                  <Show when={f?.oldPath}>
                    <span class="text-muted text-xs">← {f!.oldPath}</span>
                  </Show>
                  <Show when={f && f.binary}>
                    <span class="text-muted text-xs">binary</span>
                  </Show>
                  <Show when={f && (f.additions !== undefined || f.deletions !== undefined) && !f.binary}>
                    <span class="text-xs">
                      (<span class="stat-add">+{f!.additions ?? 0}</span>|<span class="stat-del">-{f!.deletions ?? 0}</span>)
                    </span>
                  </Show>
                  <Show when={isWorking() && f}>
                    <span class="ml-auto flex gap-1">
                      <button
                        class="rounded px-1.5 text-xs hover:bg-[var(--hover)]"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleStage(f!);
                        }}
                        title={f!.area === "staged" ? "Unstage (Space)" : "Stage (Space)"}
                      >
                        {f!.area === "staged" ? "Unstage" : "Stage"}
                      </button>
                    </span>
                  </Show>
                </div>
              </>
            );
          }}
        </For>
        <Show when={files().length === 0 && (isWorking() || details() || comparison())}>
          <div class="px-3 text-muted">No file changes.</div>
        </Show>
      </div>
      <div class="side-actions">
        <button class="icon-btn" aria-label="Close details (Escape)" title="Close (Esc)" onClick={() => app.closeDetails()}>
          <IconClose />
        </button>
        <Show when={!isWorking()}>
          <button
            class="icon-btn"
            aria-label={treeMode() ? "Show files as a list" : "Show files as a tree"}
            title={treeMode() ? "List view" : "Tree view"}
            onClick={() => {
              const t = !treeMode();
              setTreeMode(t);
              localStorage.setItem("lanes.fileView", t ? "tree" : "list");
            }}
          >
            {treeMode() ? <IconList /> : <IconTree />}
          </button>
        </Show>
      </div>
    </div>
  );
}

function statusWord(s: string) {
  return { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "conflicted", "?": "untracked" }[s] ?? s;
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((p) =>
    /^https?:\/\//.test(p) ? (
      <a class="text-link" href={p} target="_blank" rel="noopener noreferrer">
        {p}
      </a>
    ) : (
      p
    ),
  );
}

function WorkingSummary(p: { status: WorkingTreeStatus | null }) {
  const run = (id: string) => void invokeMutation(id, { commit: app.rows.commits[0] ?? null, ref: null, file: null, hunk: null, worktree: null });
  const op = () => p.status?.operation;
  return (
    <div>
      <Show when={op()}>
        <div class="mb-3 rounded border border-[var(--warn)] p-2" role="alert">
          <div class="font-bold">
            {op()!.kind === "rebase" ? `Rebase in progress${(() => { const o = op() as { step?: number; total?: number }; return o.step ? ` (${o.step}/${o.total})` : ""; })()}` : `${op()!.kind[0]!.toUpperCase()}${op()!.kind.slice(1)} in progress`}
          </div>
          <div class="text-muted text-xs">{p.status!.conflicted.length ? `${p.status!.conflicted.length} conflicted file(s): resolve each, then Continue.` : "No conflicts remain. Continue when ready."}</div>
          <div class="mt-2 flex gap-2">
            <button class="rounded bg-[var(--focus)] px-2 py-0.5 text-white" onClick={() => run("git.operation.continue")}>
              Continue
            </button>
            <Show when={op()!.kind === "rebase" || op()!.kind === "cherry-pick" || op()!.kind === "revert"}>
              <button class="rounded border border-[var(--border)] px-2 py-0.5" onClick={() => run("git.operation.skip")}>
                Skip
              </button>
            </Show>
            <button class="rounded border border-[var(--del)] px-2 py-0.5 text-del" onClick={() => run("git.operation.abort")}>
              Abort
            </button>
          </div>
        </div>
      </Show>
      <div class="font-bold">Uncommitted Changes</div>
      <Show when={p.status?.branch}>
        <div class="text-muted">
          On <b>{p.status!.branch!.name}</b>
          {p.status!.branch!.upstream ? ` · ${p.status!.branch!.ahead} ahead, ${p.status!.branch!.behind} behind ${p.status!.branch!.upstream}` : " · no upstream"}
        </div>
      </Show>
      <div class="text-muted">
        {p.status?.staged.length ?? 0} staged · {p.status?.unstaged.length ?? 0} changed · {p.status?.untracked.length ?? 0} untracked
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button class="rounded bg-[var(--focus)] px-2 py-0.5 text-white" onClick={() => run("git.commit")}>
          Commit…
        </button>
        <button class="rounded border border-[var(--border)] px-2 py-0.5" onClick={() => run("git.stash.push")}>
          Stash…
        </button>
        <Show when={p.status?.untracked.length}>
          <button class="rounded border border-[var(--border)] px-2 py-0.5" onClick={() => run("git.clean")}>
            Clean…
          </button>
        </Show>
      </div>
      <div class="text-muted mt-3 text-xs">Space stages/unstages the focused file · Enter opens its diff (stage individual hunks there) · Shift+F10 for more.</div>
      <span class="hidden">{BINDERS ? "" : ""}</span>
    </div>
  );
}

async function viewFile(path: string, rev: string) {
  try {
    const f = await portCall<{ content: string; encoding: "utf8" | "base64"; size: number }>("file", [path, rev]);
    await app.ask({ title: `${path} @ ${rev.slice(0, 8)}`, output: { text: f.encoding === "utf8" ? f.content : `(binary, ${f.size} bytes)` }, confirmLabel: "Close" });
  } catch (e) {
    app.toast("error", "Could not load file", AppError.from(e).message);
  }
}

async function fileHistory(path: string) {
  try {
    const page = await portCall<{ commits: { hash: string; subject: string; author: { name: string; date: number } }[] }>("fileHistory", [path, null, 100]);
    const v = await app.ask({
      title: `History of ${path}`,
      fields: [{ name: "commit", label: "Go to commit", type: "select", options: page.commits.map((c) => ({ value: c.hash, label: `${c.hash.slice(0, 8)} ${formatDate(c.author.date)} ${c.author.name} — ${c.subject}` })) }],
      confirmLabel: "Go",
    });
    if (v?.commit) app.navigate({ commit: String(v.commit), view: "details", compare: null, file: null });
  } catch (e) {
    app.toast("error", "File history failed", AppError.from(e).message);
  }
}

export { executeRemote };
