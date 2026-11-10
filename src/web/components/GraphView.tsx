// The graph table: compact header with resizable columns, virtualized commit rows (only the
// visible window is in the DOM), one SVG overlay for lanes/edges of the visible window, and the
// commit details panel expanded in place below the selected row.

import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show, type JSX } from "solid-js";
import { EDGE_COLOR_MASK, EDGE_DASHED, NODE_STASH, NODE_WORKING } from "../../core/graph/layout.ts";
import { WORKING } from "../../core/url/state.ts";
import type { Ref } from "../../core/types.ts";
import { app, DETAILS_H, GRAPH_PAD, LANE_W, ROW_H } from "../app/store.ts";
import { invokeMutation, openContextMenuForFocus, currentContext } from "../app/commands.ts";
import { IconBranch, IconStash, IconTag } from "./icons.tsx";
import { Details } from "./Details.tsx";

export const PALETTE = ["#0085d9", "#d9008f", "#00d90a", "#d98500", "#a300d9", "#ff0000", "#00d9cc", "#e138e8", "#85d900", "#dc5b23", "#6f24d6", "#ffcc00"];
const NEUTRAL = "#808080";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function laneColor(c: number): string {
  return c < 0 ? NEUTRAL : PALETTE[c % PALETTE.length]!;
}

const laneX = (lane: number) => GRAPH_PAD + lane * LANE_W;

export function RefBadge(p: { r: Ref; color: string; focused: boolean; index: number; remotes: string[]; head: boolean }) {
  const icon = () => (p.r.kind === "tag" ? <IconTag size={12} /> : p.r.kind === "stash" ? <IconStash size={12} /> : <IconBranch size={12} />);
  const label = () =>
    `${p.r.kind === "head" ? "Branch" : p.r.kind === "remote" ? "Remote branch" : p.r.kind === "tag" ? "Tag" : "Stash"} ${p.r.short}${p.remotes.length ? `, also on ${p.remotes.join(", ")}` : ""}${p.head ? ", checked out" : ""}${
      p.r.checkedOutAt && !p.head ? `, checked out in worktree ${p.r.checkedOutAt}` : ""
    }`;
  return (
    <>
      <Show when={p.head}>
        <span class="head-dot" title="Checked out (HEAD)" />
      </Show>
      <span
        class="ref"
        classList={{ head: p.head, focused: p.focused }}
        data-ref-index={p.index}
        data-ref={p.r.short}
        aria-label={label()}
        title={p.r.message ? `${p.r.short}\n${p.r.message}` : p.r.checkedOutAt ? `${p.r.short} — checked out at ${p.r.checkedOutAt}` : p.r.short}
        role="note"
      >
        <span class="ic" style={{ background: p.color }}>
          {icon()}
        </span>
        <span class="nm">{p.r.short}</span>
        <For each={p.remotes}>{(rm) => <span class="rm">{rm}</span>}</For>
      </span>
    </>
  );
}

export function GraphView() {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(800);
  const cols = app.columns;

  const graphW = createMemo(() => {
    app.rowsVersion();
    const c = cols().graph;
    if (c) return c;
    return Math.min(Math.max(GRAPH_PAD * 2 + Math.max(app.rows.width - 1, 0) * LANE_W, 48), 520);
  });

  const total = createMemo(() => {
    app.rowsVersion();
    return app.rows.length * ROW_H + (app.expandedRow() >= 0 ? DETAILS_H : 0) + (app.rows.complete ? 0 : ROW_H);
  });

  const range = createMemo(() => {
    app.rowsVersion();
    const n = app.rows.length;
    if (!n) return [0, -1] as const;
    const first = Math.max(0, app.rowAt(scrollTop()) - 6);
    const last = Math.min(n - 1, app.rowAt(scrollTop() + viewH()) + 6);
    return [first, last] as const;
  });

  const indices = createMemo(() => {
    const [a, b] = range();
    const out: number[] = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  });

  // ---- SVG for the visible window: group path data by color, nodes drawn on top.
  const svg = createMemo(() => {
    app.rowsVersion();
    const [a, b] = range();
    const rows = app.rows;
    const exp = app.expandedRow();
    const yc = (r: number) => app.rowTop(r) + ROW_H / 2;
    const byColor = new Map<string, string[]>();
    const add = (key: string, d: string) => {
      let l = byColor.get(key);
      if (!l) byColor.set(key, (l = []));
      l.push(d);
    };
    const seg = (x1: number, y1: number, x2: number, y2: number) => {
      if (x1 === x2) return `M${x1} ${y1}V${y2}`;
      // Lane changes happen in the last row-height of the gap, as a smooth S-curve.
      const ys = Math.max(y1, y2 - ROW_H);
      const m = (ys + y2) / 2;
      return `${ys > y1 ? `M${x1} ${y1}V${ys}` : `M${x1} ${y1}`}C${x1} ${m} ${x2} ${m} ${x2} ${y2}`;
    };
    const from = Math.max(1, a);
    for (let r = from; r <= b + 1 && r < rows.length; r++) {
      const e = rows.rowEdges(r);
      const y1 = yc(r - 1);
      const y2 = yc(r);
      for (let i = 0; i < e.length; i += 3) {
        const f = e[i + 2]!;
        const dashed = (f & EDGE_DASHED) !== 0;
        const key = dashed ? "dashed" : String(f & EDGE_COLOR_MASK);
        add(key, seg(laneX(e[i]!), y1, laneX(e[i + 1]!), y2));
      }
    }
    // Open lanes continue below the last loaded row.
    if (rows.length && b >= rows.length - 1) {
      const last = rows.length - 1;
      const y1 = yc(last);
      const y2 = y1 + ROW_H * (rows.complete ? 0.5 : 1.5);
      const t = rows.tail;
      for (let i = 0; i < t.length; i += 3) {
        const f = t[i + 2]!;
        add((f & EDGE_DASHED) !== 0 ? "dashed" : String(f & EDGE_COLOR_MASK), seg(laneX(t[i]!), y1, laneX(t[i + 1]!), y2));
      }
    }
    void exp;
    const nodes: { x: number; y: number; color: string; kind: number; head: boolean; r: number }[] = [];
    const head = app.headCommit();
    for (let r = a; r <= b; r++) {
      const c = rows.commits[r]!;
      nodes.push({ x: laneX(rows.nodeLane[r]!), y: yc(r), color: laneColor(rows.nodeColor[r]!), kind: c.kind, head: c.hash === head, r });
    }
    return { paths: [...byColor.entries()].map(([k, d]) => ({ k, d: d.join("") })), nodes };
  });

  const onScroll = () => {
    const t = scroller.scrollTop;
    requestAnimationFrame(() => setScrollTop(t));
    app.onScrolled(t);
  };

  onMount(() => {
    app.setScrollEl(scroller);
    const ro = new ResizeObserver(() => setViewH(scroller.clientHeight));
    ro.observe(scroller);
    setViewH(scroller.clientHeight);
    onCleanup(() => {
      ro.disconnect();
      app.setScrollEl(null);
    });
    scroller.focus({ preventScroll: true });
  });

  // Keep the keyboard row visible.
  createEffect(() => {
    const r = app.kbRow();
    if (document.activeElement === scroller) app.scrollToRow(r);
  });

  const selected = createMemo(() => new Set([app.view().commit, app.view().compare, ...app.view().selected].filter(Boolean) as string[]));
  const matchSet = createMemo(() => new Set(app.find.matches));
  const currentMatch = createMemo(() => (app.find.current >= 0 ? app.find.matches[app.find.current] : -1));

  const onRowClick = (r: number, e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".details")) return;
    app.setKbRow(r);
    app.setRefCursor(-1);
    scroller.focus({ preventScroll: true });
    const c = app.rows.commits[r];
    if (!c) return;
    if (e.metaKey || e.ctrlKey) return app.compareWith(r);
    if (e.shiftKey) return app.toggleSelect(r);
    const v = app.view();
    if (v.commit === c.hash && v.view !== "graph" && !v.compare) app.closeDetails();
    else app.openDetails(r);
  };

  const onContext = (r: number, e: MouseEvent) => {
    e.preventDefault();
    app.setKbRow(r);
    const badge = (e.target as HTMLElement).closest<HTMLElement>("[data-ref-index]");
    app.setRefCursor(badge ? Number(badge.dataset.refIndex) : -1);
    openContextMenuForFocus({ x: e.clientX, y: e.clientY });
  };

  const onDblClick = (e: MouseEvent) => {
    const badge = (e.target as HTMLElement).closest<HTMLElement>("[data-ref-index]");
    if (!badge) return;
    app.setRefCursor(Number(badge.dataset.refIndex));
    void invokeMutation("git.checkout", currentContext());
  };

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const onGraphHover = (r: number, e: MouseEvent) => {
    if (hoverTimer) clearTimeout(hoverTimer);
    const x = e.clientX;
    const y = e.clientY;
    hoverTimer = setTimeout(() => app.setTooltip({ x: x + 12, y: y + 12, row: r }), 450);
  };
  const onGraphLeave = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    app.setTooltip(null);
  };

  const rowLabel = (r: number) => {
    const c = app.rows.commits[r];
    if (!c) return "";
    if (c.kind === NODE_WORKING) return `${c.subject}`;
    const refs = (app.refsByCommit().get(c.hash) ?? []).map((x) => x.short).join(", ");
    return `${c.subject}${refs ? `, refs ${refs}` : ""}, ${c.author.name}, ${formatDate(c.author.date)}, commit ${c.hash.slice(0, 8)}${c.hash === app.headCommit() ? ", HEAD" : ""}`;
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <Header graphW={graphW()} />
      <div
        ref={scroller}
        class="graph-scroll"
        role="grid"
        tabIndex={0}
        aria-label={`Commit graph${app.repo.info ? ` of ${app.repo.info.name}` : ""}`}
        aria-rowcount={app.rows.complete ? app.rows.length : -1}
        aria-activedescendant={app.rows.length ? `row-${app.kbRow()}` : undefined}
        aria-multiselectable="true"
        onScroll={onScroll}
        onDblClick={onDblClick}
        onKeyDown={(e) => {
          // Tab from the graph goes straight to the changed-files list of the open details.
          if (e.key === "Tab" && !e.shiftKey && app.expandedRow() >= 0 && e.target === scroller) {
            const f = scroller.querySelector<HTMLElement>('.details .files [tabindex="0"]') ?? scroller.querySelector<HTMLElement>(".details .files");
            if (f) {
              e.preventDefault();
              f.focus();
            }
          }
        }}
      >
        <div class="graph-canvas" style={{ height: `${total()}px` }}>
          <svg class="graph-svg" width={graphW()} height={total()} aria-hidden="true">
            <For each={svg().paths}>
              {(p) => (
                <path
                  d={p.d}
                  fill="none"
                  stroke={p.k === "dashed" ? NEUTRAL : laneColor(Number(p.k))}
                  stroke-width="2"
                />
              )}
            </For>
            <For each={svg().nodes}>
              {(n) =>
                n.kind === NODE_WORKING ? (
                  <circle cx={n.x} cy={n.y} r="4" fill="var(--bg)" stroke={NEUTRAL} stroke-width="1.5" />
                ) : n.kind === NODE_STASH ? (
                  <g>
                    <circle cx={n.x} cy={n.y} r="4.5" fill="var(--bg)" stroke={n.color} stroke-width="1.5" />
                    <circle cx={n.x} cy={n.y} r="2" fill={n.color} />
                  </g>
                ) : (
                  <circle cx={n.x} cy={n.y} r="4" fill={n.color} stroke={n.head ? "var(--bg)" : "none"} stroke-width={n.head ? 1 : 0} />
                )
              }
            </For>
          </svg>
          <Index each={indices()}>
            {(ri) => {
              const r = ri;
              const c = () => {
                app.rowsVersion();
                return app.rows.commits[r()];
              };
              const refs = () => (c() ? (app.refsByCommit().get(c()!.hash) ?? []) : []);
              const color = () => laneColor(app.rows.nodeColor[r()] ?? 0);
              const isSel = () => !!c() && selected().has(c()!.hash);
              return (
                <Show when={c()}>
                  <div
                    id={`row-${r()}`}
                    data-row={r()}
                    data-hash={c()!.hash}
                    class="row"
                    classList={{
                      sel: isSel(),
                      primary: !!c() && app.view().commit === c()!.hash,
                      kb: app.kbRow() === r(),
                      muted: c()!.parents.length > 1,
                      working: c()!.kind === NODE_WORKING,
                      match: matchSet().has(r()),
                      "current-match": currentMatch() === r(),
                    }}
                    style={{ top: `${app.rowTop(r())}px` }}
                    role="row"
                    aria-rowindex={r() + 1}
                    aria-selected={isSel()}
                    aria-label={rowLabel(r())}
                    aria-expanded={app.expandedRow() === r() ? true : undefined}
                    onClick={(e) => onRowClick(r(), e)}
                    onContextMenu={(e) => onContext(r(), e)}
                  >
                    <div role="gridcell" class="td" style={{ width: `${graphW()}px`, padding: 0 }} onMouseMove={(e) => onGraphHover(r(), e)} onMouseLeave={onGraphLeave} />
                    <div role="gridcell" class="td desc">
                      <For each={refs()}>
                        {(ref, i) => (
                          <RefBadge
                            r={ref}
                            index={i()}
                            color={color()}
                            focused={app.kbRow() === r() && app.refCursor() === i()}
                            remotes={app.combinedRemotes(ref)}
                            head={ref.kind === "head" && ref.short === app.headBranch()}
                          />
                        )}
                      </For>
                      <span class="subject">{c()!.subject}</span>
                    </div>
                    <Show when={cols().showDate}>
                      <div role="gridcell" class="td date" style={{ width: `${cols().date}px` }}>
                        {formatDate(c()!.kind === NODE_WORKING ? Math.floor(Date.now() / 1000) : c()!.author.date)}
                      </div>
                    </Show>
                    <Show when={cols().showAuthor}>
                      <div role="gridcell" class="td author" style={{ width: `${cols().author}px` }} title={c()!.author.email}>
                        {c()!.author.name}
                      </div>
                    </Show>
                    <Show when={cols().showHash}>
                      <div role="gridcell" class="td hash" style={{ width: `${cols().hash}px` }}>
                        {c()!.hash === WORKING ? "*" : c()!.hash.slice(0, 8)}
                      </div>
                    </Show>
                  </div>
                </Show>
              );
            }}
          </Index>
          <Show when={!app.rows.complete && app.rows.length > 0}>
            <div class="row" style={{ top: `${app.rowTop(app.rows.length)}px`, "padding-left": `${graphW() + 8}px`, color: "var(--fg-muted)" }} aria-live="polite">
              Loading more commits…
            </div>
          </Show>
          <Show when={app.expandedRow() >= 0}>
            <div class="details" style={{ top: `${app.rowTop(app.expandedRow()) + ROW_H}px`, height: `${DETAILS_H}px`, left: `${graphW()}px` }}>
              <Details />
            </div>
          </Show>
        </div>
        <Show when={app.rows.length === 0 && !app.repo.loading && !app.repo.error && app.repo.refs}>
          <div class="p-6 text-muted">No commits to show{app.view().branches.length ? " for the selected branches" : ""}.</div>
        </Show>
      </div>
    </div>
  );
}

function Header(p: { graphW: number }) {
  const cols = app.columns;
  const resizer = (key: "graph" | "date" | "author" | "hash", label: string, current: () => number, sign = 1): JSX.Element => {
    const set = (w: number) => {
      const v = Math.max(key === "graph" ? 40 : 40, Math.min(800, Math.round(w)));
      app.setColumns({ ...cols(), [key]: v });
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = current();
      const move = (ev: PointerEvent) => set(w0 + sign * (ev.clientX - x0));
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    return (
      <div
        class="col-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        aria-valuenow={current()}
        aria-valuemin={40}
        aria-valuemax={800}
        tabIndex={0}
        onPointerDown={onDown}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 32 : 8;
          if (e.key === "ArrowLeft") set(current() - sign * step);
          else if (e.key === "ArrowRight") set(current() + sign * step);
          else if (e.key === "Home") app.setColumns({ ...cols(), [key]: key === "graph" ? null : { date: 124, author: 110, hash: 76 }[key] });
          else if (e.key === "Escape" || e.key === "Enter") app.focusGraph();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
    );
  };
  return (
    <div class="table-header" role="row" aria-label="Columns">
      <div class="th" role="columnheader" style={{ width: `${p.graphW}px` }}>
        Graph
        {resizer("graph", "Graph", () => p.graphW)}
      </div>
      <div class="th grow" role="columnheader">
        Description
      </div>
      <Show when={cols().showDate}>
        <div class="th" role="columnheader" style={{ width: `${cols().date}px` }}>
          Date
          {/* Divider on the left edge of Date resizes Date (dragging left widens it). */}
          <div style={{ position: "absolute", left: "0", top: "0", height: "100%" }}>{resizer("date", "Date", () => cols().date, -1)}</div>
        </div>
      </Show>
      <Show when={cols().showAuthor}>
        <div class="th" role="columnheader" style={{ width: `${cols().author}px` }}>
          Author
          <div style={{ position: "absolute", left: "0", top: "0", height: "100%" }}>{resizer("author", "Author", () => cols().author, -1)}</div>
        </div>
      </Show>
      <Show when={cols().showHash}>
        <div class="th" role="columnheader" style={{ width: `${cols().hash}px` }}>
          Commit
          <div style={{ position: "absolute", left: "0", top: "0", height: "100%" }}>{resizer("hash", "Commit", () => cols().hash, -1)}</div>
        </div>
      </Show>
    </div>
  );
}
