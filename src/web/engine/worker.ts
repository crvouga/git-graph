/// <reference lib="webworker" />
// Graph engine worker: orders the synced commits and lays out the graph off the UI thread.
// Inputs arrive as deltas; a recompute is coalesced to one per frame.

import { AppError } from "../../core/types.ts";
import { Graph } from "./graph.ts";
import { appendOf, remember, type Sent } from "./delta.ts";
import type { CallMessage, EngineEvent, GraphState, LayoutChunk, ResultMessage } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

const graph = new Graph();
let session = 0;
let state: GraphState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function post(ev: EngineEvent | ResultMessage, transfer: Transferable[] = []) {
  self.postMessage(ev, transfer);
}

function transfer(l: LayoutChunk): Transferable[] {
  return [l.nodeLane.buffer, l.nodeColor.buffer, l.edgeStart.buffer, l.edges.buffer, l.tail.buffer] as Transferable[];
}

let sent: Sent | null = null;

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (!state || !state.refs) return;
    const t = performance.now();
    const out = graph.compute(state);
    post({ t: "metric", name: "layout.reset.ms", value: performance.now() - t, session });
    const l = out.layout;
    const delta = sent ? appendOf(sent, out.rows, l, state.refs) : null;
    // Keep copies: the layout's buffers are transferred to the UI thread below.
    const wasComplete = sent?.complete;
    sent = remember(out.rows, l, state.refs, out.complete);
    if (delta) {
      if (delta.rows.length || out.complete !== wasComplete) post({ t: "rows", session, kind: "append", commits: delta.rows, layout: delta.layout, complete: out.complete }, transfer(delta.layout));
      return;
    }
    post({ t: "rows", session, kind: "reset", commits: out.rows, layout: l, complete: out.complete, stale: false, refs: state.refs }, transfer(l));
  }, 16);
}

self.onmessage = (ev: MessageEvent<CallMessage>) => {
  const m = ev.data;
  if (m.t !== "call") return;
  try {
    let value: unknown = null;
    switch (m.method) {
      case "reset":
        session = m.args.session;
        graph.clear();
        state = null;
        sent = null;
        break;
      case "commits":
        if (m.args.session !== session) break;
        graph.remove(m.args.remove);
        graph.add(m.args.add);
        schedule();
        break;
      case "state":
        if (m.args.session !== session) break;
        state = m.args.state;
        schedule();
        break;
      case "search": {
        const refs = m.args.refs ?? {};
        value = graph.search(m.args.text, (h) => refs[h] ?? []);
        break;
      }
    }
    post({ t: "result", id: m.id, ok: true, value });
  } catch (e) {
    post({ t: "result", id: m.id, ok: false, error: AppError.from(e).toJSON() });
  }
};
