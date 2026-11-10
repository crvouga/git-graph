// UI-thread side of the engine: typed RPC to the worker plus the graph row store.

import { AppError } from "../../core/types.ts";
import type { CallMessage, EngineCall, EngineEvent, LayoutChunk, ResultMessage, RowCommit, RowsMessage } from "./protocol.ts";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class Engine {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: EngineEvent) => void>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "lanes-engine" });
    this.worker.onmessage = (ev: MessageEvent<ResultMessage | EngineEvent>) => {
      const m = ev.data;
      if (m.t === "result") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new AppError(m.error.code as AppError["code"], m.error.message, m.error.details));
        return;
      }
      for (const l of this.listeners) l(m);
    };
  }

  on(l: (e: EngineEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  call<T = unknown>(c: EngineCall, signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          return reject(new AppError("CANCELLED", "Cancelled"));
        }
        signal.addEventListener("abort", () => {
          this.worker.postMessage({ t: "cancel", id });
          this.pending.delete(id);
          reject(new AppError("CANCELLED", "Cancelled"));
        });
      }
      const msg: CallMessage = { t: "call", id, ...c } as CallMessage;
      this.worker.postMessage(msg, transfer);
    });
  }
}

// ---------------------------------------------------------------------------
// Row store: plain typed arrays, never wrapped in reactive proxies.
// ---------------------------------------------------------------------------

function grow<T extends Int16Array | Uint32Array>(a: T, need: number, Ctor: new (n: number) => T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (a.length >= need) return a;
  const b = new Ctor(Math.max(need, a.length * 2, 1024));
  b.set(a);
  return b;
}

export class GraphRows {
  commits: RowCommit[] = [];
  index = new Map<string, number>();
  nodeLane: Int16Array = new Int16Array(0);
  nodeColor: Int16Array = new Int16Array(0);
  edgeStart: Uint32Array = new Uint32Array(1);
  edges: Int16Array = new Int16Array(0);
  edgeCount = 0;
  tail: Int16Array = new Int16Array(0);
  width = 0;
  complete = false;

  get length() {
    return this.commits.length;
  }

  private setLayout(l: LayoutChunk) {
    this.nodeLane = l.nodeLane;
    this.nodeColor = l.nodeColor;
    this.edgeStart = l.edgeStart;
    this.edges = l.edges;
    this.edgeCount = l.edges.length;
    this.tail = l.tail;
    this.width = l.width;
  }

  private reindex(from = 0) {
    if (from === 0) this.index.clear();
    for (let i = from; i < this.commits.length; i++) this.index.set(this.commits[i]!.hash, i);
  }

  apply(m: RowsMessage) {
    if (m.kind === "reset") {
      this.commits = m.commits;
      this.setLayout(m.layout);
      this.reindex();
    } else if (m.kind === "append") {
      const from = this.commits.length;
      const n = m.commits.length;
      for (const c of m.commits) this.commits.push(c);
      if (n) {
        const l = m.layout;
        this.nodeLane = grow(this.nodeLane, from + n, Int16Array);
        this.nodeColor = grow(this.nodeColor, from + n, Int16Array);
        this.nodeLane.set(l.nodeLane, from);
        this.nodeColor.set(l.nodeColor, from);
        const baseEdge = this.edgeStart[from]!;
        this.edgeStart = grow(this.edgeStart, from + n + 1, Uint32Array);
        for (let i = 1; i <= n; i++) this.edgeStart[from + i] = baseEdge + l.edgeStart[i]!;
        this.edges = grow(this.edges, this.edgeCount + l.edges.length, Int16Array);
        this.edges.set(l.edges, this.edgeCount);
        this.edgeCount += l.edges.length;
        this.width = Math.max(this.width, l.width);
        this.reindex(from);
      }
      this.tail = m.layout.tail;
    } else {
      this.commits = [...m.insert, ...this.commits.slice(m.removeTop)];
      this.setLayout(m.layout);
      this.reindex();
    }
    this.complete = m.complete;
  }

  rowEdges(r: number): Int16Array {
    return this.edges.subarray(this.edgeStart[r]! * 3, this.edgeStart[r + 1]! * 3);
  }
}
