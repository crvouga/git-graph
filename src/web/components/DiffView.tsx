// Diff of one file (commit, comparison or uncommitted), with hunk staging/unstaging/discarding,
// and a conflict resolver for conflicted files. Escape returns focus to the file it came from.

import { createEffect, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { AppError, type CommitDetails, type ConflictFile, type Diff, type FileDiff, type Hunk } from "../../core/types.ts";
import { WORKING } from "../../core/url/state.ts";
import { app } from "../app/store.ts";
import { invokeMutation, portCall } from "../app/commands.ts";
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

  const [sections] = createResource(
    () => (conflicted() ? null : `${app.sessionId()}|${v().commit}|${v().compare}|${v().file}|${isWorking() ? JSON.stringify(app.repo.status) : ""}`),
    async (): Promise<Section[]> => {
      const p = path();
      if (isWorking()) {
        const [staged, unstaged] = await Promise.all([
          portCall<Diff>("diff", [{ kind: "working", staged: true }, { path: p }]),
          portCall<Diff>("diff", [{ kind: "working", staged: false }, { path: p }]),
        ]);
        const out: Section[] = [];
        if (staged.files[0]) out.push({ title: "Staged changes", staged: true, file: staged.files[0] });
        if (unstaged.files[0]) out.push({ title: "Unstaged changes", staged: false, file: unstaged.files[0] });
        return out.length ? out : [{ title: null, staged: null, file: null }];
      }
      const pr = pair();
      const full = app.rows.commits[app.rows.index.get(v().commit!) ?? -1]?.hash ?? v().commit!;
      const d = pr ? await portCall<Diff>("diff", [{ kind: "compare", base: pr.base, head: pr.head }, { path: p }]) : await portCall<Diff>("diff", [{ kind: "commit", hash: full }, { path: p }]);
      return [{ title: null, staged: null, file: d.files.find((f) => f.path === p || f.oldPath === p) ?? d.files[0] ?? null }];
    },
  );

  // Sibling files for ]/[ navigation.
  const [siblings] = createResource(
    () => `${app.sessionId()}|${v().commit}|${v().compare}|${isWorking() ? JSON.stringify(app.repo.status) : ""}`,
    async (): Promise<string[]> => {
      if (isWorking()) {
        const s = app.repo.status;
        return s ? [...s.conflicted, ...s.staged, ...s.unstaged].map((f) => f.path).concat(s.untracked).filter((x, i, a) => a.indexOf(x) === i) : [];
      }
      const pr = pair();
      if (pr) return (await portCall<Diff>("diff", [{ kind: "compare", base: pr.base, head: pr.head }])).files.map((f) => f.path);
      const full = app.rows.commits[app.rows.index.get(v().commit!) ?? -1]?.hash ?? v().commit!;
      return (await portCall<CommitDetails>("commit", [full])).files.map((f) => f.path);
    },
  );

  const hunks = createMemo(() => {
    const out: { si: number; hi: number; sec: Section; h: Hunk }[] = [];
    (sections() ?? []).forEach((sec, si) => sec.file?.hunks.forEach((h, hi) => out.push({ si, hi, sec, h })));
    return out;
  });

  onMount(() => root.focus({ preventScroll: true }));
  createEffect(() => {
    sections();
    setFocusHunk(0);
  });

  const scrollHunk = (i: number) => {
    const el = root.querySelector<HTMLElement>(`[data-hunk="${i}"]`);
    el?.scrollIntoView({ block: "nearest" });
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
      <div class="min-h-0 flex-1 overflow-auto">
        <Show when={conflicted()}>
          <ConflictView path={path()} />
        </Show>
        <Show when={!conflicted()}>
          <Show when={!sections.loading} fallback={<div class="p-4 text-muted">Loading diff…</div>}>
            <Show when={!sections.error} fallback={<div class="text-del p-4">{AppError.from(sections.error).message}</div>}>
              <For each={sections()}>
                {(sec, si) => (
                  <div>
                    <Show when={sec.title}>
                      <div class="sticky top-0 z-10 bg-[var(--panel)] px-3 py-1 text-xs font-bold uppercase">{sec.title}</div>
                    </Show>
                    <Show when={sec.file} fallback={<div class="p-4 text-muted">No changes in this file.</div>}>
                      {(f) => (
                        <>
                          <Show when={f().oldPath && f().oldPath !== f().path}>
                            <div class="diff-line meta">
                              <span class="ln" />
                              <span class="ln" />
                              renamed from {f().oldPath}
                            </div>
                          </Show>
                          <Show when={f().binary}>
                            <div class="p-4">
                              Binary file {f().status === "A" ? "added" : f().status === "D" ? "deleted" : "changed"}
                              {f().oldSize !== undefined || f().newSize !== undefined ? ` (${f().oldSize ?? 0} → ${f().newSize ?? 0} bytes)` : ""}.
                            </div>
                          </Show>
                          <Show when={!f().binary && f().hunks.length === 0}>
                            <div class="p-4 text-muted">{f().oldPath && f().oldPath !== f().path ? "Renamed without content changes." : "No content changes (mode or metadata only)."}</div>
                          </Show>
                          <Show when={f().truncated}>
                            <div class="p-2 text-warn">This diff is large and was truncated.</div>
                          </Show>
                          <For each={f().hunks}>
                            {(h, hi) => {
                              const gi = () => hunks().findIndex((x) => x.si === si() && x.hi === hi());
                              return (
                                <div class="hunk" classList={{ focused: focusHunk() === gi() }} data-hunk={gi()} role="group" aria-label={`Hunk ${h.header}`}>
                                  <div class="hunk-head">
                                    <span class="truncate">{h.header}</span>
                                    <Show when={sec.staged !== null}>
                                      <span class="ml-auto flex gap-2">
                                        <button class="rounded border border-[var(--border)] px-1.5 text-[var(--fg)]" onClick={() => (setFocusHunk(gi()), hunkAction(gi(), "toggle"))}>
                                          {sec.staged ? "Unstage hunk" : "Stage hunk"}
                                        </button>
                                        <Show when={!sec.staged}>
                                          <button class="rounded border border-[var(--del)] px-1.5 text-del" onClick={() => (setFocusHunk(gi()), hunkAction(gi(), "discard"))}>
                                            Discard
                                          </button>
                                        </Show>
                                      </span>
                                    </Show>
                                  </div>
                                  <For each={h.lines}>
                                    {(l) => (
                                      <div class={`diff-line ${l.kind === "add" ? "add" : l.kind === "del" ? "del" : l.kind === "meta" ? "meta" : ""}`}>
                                        <span class="ln">{l.oldNo ?? ""}</span>
                                        <span class="ln">{l.newNo ?? ""}</span>
                                        <span>
                                          {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
                                          {l.text}
                                        </span>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              );
                            }}
                          </For>
                        </>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function ConflictView(p: { path: string }) {
  const [data, { refetch }] = createResource(
    () => `${app.sessionId()}|${p.path}`,
    () => portCall<ConflictFile>("conflict", [p.path]),
  );
  const [text, setText] = createSignal("");
  createEffect(() => {
    const d = data();
    if (d) setText(d.working ?? "");
  });
  const resolve = (resolution: "ours" | "theirs" | { content: string }) =>
    void invokeMutation("git.conflict.resolve", { commit: null, ref: null, file: { path: p.path, area: "conflicted" }, hunk: null, worktree: null }, { path: p.path, resolution }).then(() => refetch());
  return (
    <div class="flex h-full flex-col gap-2 p-3">
      <Show when={data()} fallback={<div class="text-muted">{data.error ? AppError.from(data.error).message : "Loading conflict…"}</div>}>
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
