// Diff of one file (commit, comparison or uncommitted), with hunk staging/unstaging/discarding,
// and a conflict resolver for conflicted files. Escape returns focus to the file it came from.

import { createEffect, createMemo, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { AppError, type CommitDetails, type ConflictFile, type Diff, type FileDiff, type Hunk } from "../../core/types.ts";
import { WORKING } from "../../core/url/state.ts";
import { app } from "../app/store.ts";
import { invokeMutation } from "../app/commands.ts";
import { requestRead, useRead } from "../app/sync.ts";
import { isReviewed, setReviewed } from "./Details.tsx";
import { IconClose, IconDown, IconUp } from "./icons.tsx";

export function hunkPatch(f: FileDiff, h: Hunk): string {
  const a = f.status === "A" ? "/dev/null" : `a/${f.oldPath ?? f.path}`;
  const b = f.status === "D" ? "/dev/null" : `b/${f.path}`;
  const lines = h.lines.map((l) => (l.kind === "add" ? `+${l.text}` : l.kind === "del" ? `-${l.text}` : l.kind === "meta" ? l.text : ` ${l.text}`));
  return `diff --git a/${f.oldPath ?? f.path} b/${f.path}\n--- ${a}\n+++ ${b}\n${h.header}\n${lines.join("\n")}\n`;
}

interface Section {
  title: string | null;
  staged: boolean | null;
  file: FileDiff | null;
}

export function DiffView() {
  const v = app.view;
  let root!: HTMLDivElement;
  const [focusHunk, setFocusHunk] = createSignal(0);
  const isWorking = () => v().commit === WORKING;
  const path = () => v().file!;

  const conflicted = createMemo(() => isWorking() && !!app.repo.status?.conflicted.some((f) => f.path === path()));

  const pair = createMemo(() => {
    const a = v().commit;
    const b = v().compare;
    if (!a || !b) return null;
    const ra = app.rows.index.get(a) ?? 0;
    const rb = app.rows.index.get(b) ?? 0;
    return ra > rb ? { base: a, head: b } : { base: b, head: a };
  });

  // Diffs are reads through Zero. A commit's (or comparison's) whole diff is one shared read, so
  // every file of it opens at once; the working tree is read per file and re-read on change.
  const full = () => app.rows.commits[app.rows.index.get(v().commit!) ?? -1]?.hash ?? v().commit!;
  const spec = (method: "diff" | "commit", params: unknown[], live = false) => {
    const id = app.repoId();
    return id ? { repoId: id, method, params, live } : null;
  };
  const stagedRead = useRead<Diff>(() => (isWorking() && !conflicted() ? spec("diff", [{ kind: "working", staged: true }, { path: path() }], true) : null));
  const unstagedRead = useRead<Diff>(() => (isWorking() && !conflicted() ? spec("diff", [{ kind: "working", staged: false }, { path: path() }], true) : null));
  const wholeRead = useRead<Diff>(() => {
    if (isWorking() || conflicted() || !v().commit) return null;
    const pr = pair();
    return spec("diff", [pr ? { kind: "compare", base: pr.base, head: pr.head } : { kind: "commit", hash: full() }]);
  });
  const detailsRead = useRead<CommitDetails>(() => (!isWorking() && !pair() && v().commit ? spec("commit", [full()]) : null));

  const sectionsValue = createMemo<Section[] | undefined>(() => {
    const p = path();
    if (isWorking()) {
      const staged = stagedRead.value();
      const unstaged = unstagedRead.value();
      if (!staged && !unstaged) return undefined;
      const out: Section[] = [];
      if (staged?.files[0]) out.push({ title: "Staged changes", staged: true, file: staged.files[0] });
      if (unstaged?.files[0]) out.push({ title: "Unstaged changes", staged: false, file: unstaged.files[0] });
      return out.length ? out : [{ title: null, staged: null, file: null }];
    }
    const d = wholeRead.value();
    if (!d) return undefined;
    return [{ title: null, staged: null, file: d.files.find((f) => f.path === p || f.oldPath === p) ?? null }];
  });
  const sections = Object.assign(sectionsValue, {
    get error() {
      return (isWorking() ? (stagedRead.error() ?? unstagedRead.error()) : wholeRead.error()) ?? undefined;
    },
  });

  // Sibling files for ]/[ navigation.
  const siblings = createMemo<string[]>(() => {
    if (isWorking()) {
      const s = app.repo.status;
      return s ? [...s.conflicted, ...s.staged, ...s.unstaged].map((f) => f.path).concat(s.untracked).filter((x, i, a) => a.indexOf(x) === i) : [];
    }
    return (wholeRead.value()?.files ?? detailsRead.value()?.files ?? []).map((f) => f.path);
  });

  const hunks = createMemo(() => {
    const out: { si: number; hi: number; sec: Section; h: Hunk }[] = [];
    (sections() ?? []).forEach((sec, si) => sec.file?.hunks.forEach((h, hi) => out.push({ si, hi, sec, h })));
    return out;
  });

  // Flattened, fixed-height items so diffs of any size render only the visible window.
  const items = createMemo<DiffItem[]>(() => {
    const out: DiffItem[] = [];
    let gi = 0;
    for (const sec of sections() ?? []) {
      if (sec.title) out.push({ k: "title", text: sec.title });
      const f = sec.file;
      if (!f) {
        out.push({ k: "note", text: "No changes in this file." });
        continue;
      }
      if (f.oldPath && f.oldPath !== f.path) out.push({ k: "note", text: `renamed from ${f.oldPath}` });
      if (f.binary) out.push({ k: "note", text: `Binary file ${f.status === "A" ? "added" : f.status === "D" ? "deleted" : "changed"}${f.oldSize !== undefined || f.newSize !== undefined ? ` (${f.oldSize ?? 0} → ${f.newSize ?? 0} bytes)` : ""}.` });
      else if (f.hunks.length === 0) out.push({ k: "note", text: f.oldPath && f.oldPath !== f.path ? "Renamed without content changes." : "No content changes (mode or metadata only)." });
      if (f.truncated) out.push({ k: "note", text: "This diff is large and was truncated." });
      for (const h of f.hunks) {
        out.push({ k: "hunk", gi: gi++, header: h.header, staged: sec.staged });
        for (const l of h.lines) out.push({ k: "line", kind: l.kind, oldNo: l.oldNo, newNo: l.newNo, text: l.text });
      }
    }
    return out;
  });
  let scroller: HTMLDivElement | undefined;

  onMount(() => root.focus({ preventScroll: true }));
  createEffect(() => {
    sections();
    setFocusHunk(0);
  });

  const scrollHunk = (i: number) => {
    const idx = items().findIndex((x) => x.k === "hunk" && x.gi === i);
    if (scroller && idx >= 0) {
      const top = idx * DIFF_LINE_H;
      if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 3 * DIFF_LINE_H) scroller.scrollTop = Math.max(0, top - DIFF_LINE_H);
    }
  };

  const gotoFile = (dir: 1 | -1) => {
    const list = siblings() ?? [];
    const i = list.indexOf(path());
    const next = list[i + dir];
    if (!next) return app.toast("info", dir > 0 ? "Last file" : "First file");
    if (!isWorking()) setReviewed(next, true);
    app.focusMemory.diffFrom = next;
    app.navigate({ file: next }, { replace: true });
  };

  const hunkAction = (i: number, kind: "toggle" | "discard") => {
    const x = hunks()[i];
    if (!x || x.sec.staged === null || !x.sec.file) return;
    const patch = hunkPatch(x.sec.file, x.h);
    const ctx = { commit: null, ref: null, file: { path: path(), area: x.sec.staged ? ("staged" as const) : ("unstaged" as const) }, hunk: { patch, staged: x.sec.staged, path: path() }, worktree: null };
    if (kind === "toggle") void invokeMutation("git.stage.patch", ctx);
    else if (!x.sec.staged) void invokeMutation("git.discard.patch", ctx);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    const n = hunks().length;
    let handled = true;
    switch (e.key) {
      case "n":
      case "j":
        if (n) {
          const i = Math.min(n - 1, focusHunk() + 1);
          setFocusHunk(i);
          scrollHunk(i);
        }
        break;
      case "p":
      case "k":
        if (n) {
          const i = Math.max(0, focusHunk() - 1);
          setFocusHunk(i);
          scrollHunk(i);
        }
        break;
      case "]":
        gotoFile(1);
        break;
      case "[":
        gotoFile(-1);
        break;
      case "s":
      case "u":
        hunkAction(focusHunk(), "toggle");
        break;
      case "x":
        hunkAction(focusHunk(), "discard");
        break;
      case "v":
        if (!isWorking()) setReviewed(path(), !isReviewed(path()));
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div
      ref={root}
      class="absolute inset-0 z-20 flex flex-col bg-[var(--bg)] outline-none"
      role="region"
      aria-label={`Diff of ${path()}`}
      tabIndex={0}
      onKeyDown={onKey}
      data-testid="diff-view"
    >
      <div class="flex h-9 flex-none items-center gap-2 border-b border-[var(--border)] px-3">
        <button class="icon-btn" aria-label="Previous file ([)" title="Previous file ([)" onClick={() => gotoFile(-1)}>
          <IconUp />
        </button>
        <button class="icon-btn" aria-label="Next file (])" title="Next file (])" onClick={() => gotoFile(1)}>
          <IconDown />
        </button>
        <span class="mono truncate font-semibold">{path()}</span>
        <span class="text-muted truncate">
          {isWorking() ? "Uncommitted" : pair() ? `${pair()!.base.slice(0, 8)} ↔ ${pair()!.head.slice(0, 8)}` : `${v().commit!.slice(0, 8)}`}
        </span>
        <span class="ml-auto flex items-center gap-3">
          <Show when={!isWorking()}>
            <label class="flex items-center gap-1 text-xs">
              <input type="checkbox" class="checkbox" checked={isReviewed(path())} onChange={(e) => setReviewed(path(), e.currentTarget.checked)} />
              Reviewed (v)
            </label>
          </Show>
          <span class="text-muted text-xs">n/p hunk · ]/[ file{isWorking() ? " · s stage/unstage · x discard" : ""} · Esc back</span>
          <button class="icon-btn" aria-label="Close diff (Escape)" onClick={() => app.closeDiff()}>
            <IconClose />
          </button>
        </span>
      </div>
      <Show when={conflicted()}>
        <div class="min-h-0 flex-1 overflow-auto">
          <ConflictView path={path()} />
        </div>
      </Show>
      <Show when={!conflicted()}>
        <Show when={!sections.error} fallback={<div class="text-del p-4">{AppError.from(sections.error).message}</div>}>
          <VirtualDiff items={items()} focusHunk={focusHunk()} onHunk={(gi, kind) => (setFocusHunk(gi), hunkAction(gi, kind))} ref={(el) => (scroller = el)} />
        </Show>
      </Show>
    </div>
  );
}

function ConflictView(p: { path: string }) {
  const conflict = useRead<ConflictFile>(() => (app.repoId() ? { repoId: app.repoId()!, method: "conflict", params: [p.path], live: true } : null));
  const data = Object.assign(() => conflict.value(), {
    get error() {
      return conflict.error();
    },
  });
  const refetch = () => app.repoId() && requestRead({ repoId: app.repoId()!, method: "conflict", params: [p.path], live: true });
  const [text, setText] = createSignal("");
  createEffect(() => {
    const d = data();
    if (d) setText(d.working ?? "");
  });
  const resolve = (resolution: "ours" | "theirs" | { content: string }) =>
    void invokeMutation("git.conflict.resolve", { commit: null, ref: null, file: { path: p.path, area: "conflicted" }, hunk: null, worktree: null }, { path: p.path, resolution }).then(() => refetch());
  return (
    <div class="flex h-full flex-col gap-2 p-3">
      <Show when={data()} fallback={<Show when={data.error}>{(e) => <div class="text-del">{AppError.from(e()).message}</div>}</Show>}>
        {(d) => (
          <>
            <div class="flex flex-wrap items-center gap-2">
              <b>Conflict in {p.path}</b>
              <span class="text-muted text-xs">Edit the result below (conflict markers included), or pick a side. Saving stages the file.</span>
              <span class="ml-auto flex gap-2">
                <button class="rounded border border-[var(--border)] px-2 py-0.5" onClick={() => resolve("ours")} disabled={d().ours === undefined}>
                  Use ours
                </button>
                <button class="rounded border border-[var(--border)] px-2 py-0.5" onClick={() => resolve("theirs")} disabled={d().theirs === undefined}>
                  Use theirs
                </button>
                <button class="rounded bg-[var(--focus)] px-2 py-0.5 text-white" onClick={() => resolve({ content: text() })}>
                  Save result &amp; stage
                </button>
              </span>
            </div>
            <Show when={!d().binary} fallback={<div>Binary file: choose ours or theirs.</div>}>
              <div class="grid min-h-0 flex-1 grid-cols-3 gap-2">
                <Pane title="Base" text={d().base} />
                <Pane title="Ours (current)" text={d().ours} />
                <Pane title="Theirs (incoming)" text={d().theirs} />
              </div>
              <label class="text-xs font-bold" for="conflict-editor">
                Result (Mod+Enter to save and stage)
              </label>
              <textarea
                id="conflict-editor"
                class="mono min-h-[180px] flex-1 rounded border border-[var(--border)] bg-[var(--input-bg)] p-2 text-xs"
                value={text()}
                onInput={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    resolve({ content: text() });
                  }
                }}
              />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function Pane(p: { title: string; text?: string }) {
  return (
    <div class="flex min-h-0 flex-col rounded border border-[var(--border)]">
      <div class="border-b border-[var(--border)] px-2 py-0.5 text-xs font-bold">{p.title}</div>
      <pre class="mono m-0 min-h-0 flex-1 overflow-auto p-2 text-xs" tabIndex={0}>
        {p.text ?? "(absent)"}
      </pre>
    </div>
  );
}


const DIFF_LINE_H = 18;

type DiffItem =
  | { k: "title"; text: string }
  | { k: "note"; text: string }
  | { k: "hunk"; gi: number; header: string; staged: boolean | null }
  | { k: "line"; kind: "context" | "add" | "del" | "meta"; oldNo?: number; newNo?: number; text: string };

function VirtualDiff(p: { items: DiffItem[]; focusHunk: number; onHunk: (gi: number, kind: "toggle" | "discard") => void; ref: (el: HTMLDivElement) => void }) {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  onMount(() => {
    p.ref(el);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    onCleanup(() => ro.disconnect());
  });
  const width = createMemo(() => {
    let max = 0;
    for (const it of p.items) if (it.k === "line" && it.text.length > max) max = it.text.length;
    return Math.max(600, 120 + max * 7.3);
  });
  const visible = createMemo(() => {
    const a = Math.max(0, Math.floor(top() / DIFF_LINE_H) - 20);
    const b = Math.min(p.items.length, Math.ceil((top() + height()) / DIFF_LINE_H) + 20);
    const out: number[] = [];
    for (let i = a; i < b; i++) out.push(i);
    return out;
  });
  return (
    <div ref={el} class="relative min-h-0 flex-1 overflow-auto" onScroll={() => setTop(el.scrollTop)} aria-label="Diff lines">
      <div style={{ height: `${p.items.length * DIFF_LINE_H}px`, width: `${width()}px`, position: "relative" }}>
        <Index each={visible()}>
          {(i) => {
            const it = () => p.items[i()]!;
            const style = () => ({ position: "absolute" as const, top: `${i() * DIFF_LINE_H}px`, left: "0", right: "0", height: `${DIFF_LINE_H}px` });
            return (
              <Switch>
                <Match when={it().k === "title"}>
                  <div style={style()} class="bg-[var(--panel)] px-3 text-xs leading-[18px] font-bold uppercase">
                    {(it() as { text: string }).text}
                  </div>
                </Match>
                <Match when={it().k === "note"}>
                  <div style={style()} class="diff-line meta">
                    <span class="ln" />
                    <span class="ln" />
                    {(it() as { text: string }).text}
                  </div>
                </Match>
                <Match when={it().k === "hunk"}>
                  {(() => {
                    const h = () => it() as { gi: number; header: string; staged: boolean | null };
                    return (
                      <div style={style()} class="hunk-head !py-0" classList={{ focused: p.focusHunk === h().gi }} data-hunk={h().gi} role="group" aria-label={`Hunk ${h().header}`}>
                        <span class="truncate">{h().header}</span>
                        <Show when={h().staged !== null}>
                          <span class="ml-auto flex gap-2">
                            <button class="rounded border border-[var(--border)] px-1.5 leading-[14px] text-[var(--fg)]" onClick={() => p.onHunk(h().gi, "toggle")}>
                              {h().staged ? "Unstage hunk" : "Stage hunk"}
                            </button>
                            <Show when={!h().staged}>
                              <button class="rounded border border-[var(--del)] px-1.5 leading-[14px] text-del" onClick={() => p.onHunk(h().gi, "discard")}>
                                Discard
                              </button>
                            </Show>
                          </span>
                        </Show>
                      </div>
                    );
                  })()}
                </Match>
                <Match when={it().k === "line"}>
                  {(() => {
                    const l = () => it() as { kind: string; oldNo?: number; newNo?: number; text: string };
                    return (
                      <div style={style()} class={`diff-line ${l().kind === "add" ? "add" : l().kind === "del" ? "del" : l().kind === "meta" ? "meta" : ""}`}>
                        <span class="ln">{l().oldNo ?? ""}</span>
                        <span class="ln">{l().newNo ?? ""}</span>
                        <span>
                          {l().kind === "add" ? "+" : l().kind === "del" ? "-" : " "}
                          {l().text}
                        </span>
                      </div>
                    );
                  })()}
                </Match>
              </Switch>
            );
          }}
        </Index>
      </div>
    </div>
  );
}
