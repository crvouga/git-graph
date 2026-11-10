// Small typed RPC between the main thread and the repository worker.
//   main → worker: { t: "open", handle, repoId, name } once, then { t: "call", id, method, args } / { t: "cancel", id }
//   worker → main: { t: "ok", id, value } | { t: "err", id, error: AppErrorShape }
// AbortSignals never cross the boundary: the client strips them and sends "cancel" messages instead.

import type { RepositoryPort } from "../core/port.ts";
import { AppError, type AppErrorShape, type RepoRef, repoKey } from "../core/types.ts";

export interface Endpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener?(type: "message", listener: (e: MessageEvent) => void): void;
  start?(): void;
}

/** Methods proxied to the worker, with the index of their ReadOptions argument (-1 = none). */
export const RPC_METHODS = {
  capabilities: 0,
  info: 0,
  refs: 0,
  history: 3,
  commit: 1,
  diff: 1,
  fileHistory: 3,
  blame: 2,
  search: 1,
  file: 2,
  status: 0,
  worktrees: 0,
  remotes: 0,
  conflict: 1,
  mutate: -1,
} as const satisfies Partial<Record<keyof RepositoryPort, number>>;

export type RpcMethod = keyof typeof RPC_METHODS;

export interface OpenMessage {
  t: "open";
  handle: unknown;
  repoId: string;
  name?: string;
}
type Request = OpenMessage | { t: "call"; id: number; method: RpcMethod; args: unknown[] } | { t: "cancel"; id: number };
type Response = { t: "ok"; id: number; value: unknown } | { t: "err"; id: number; error: AppErrorShape };

function toShape(e: unknown): AppErrorShape {
  return AppError.from(e).toJSON();
}

/** Worker side: opens the repository on the first "open" message and serves calls. */
export function serveRepository(ep: Endpoint, open: (msg: OpenMessage) => Promise<RepositoryPort>): void {
  let repo: Promise<RepositoryPort> | null = null;
  const controllers = new Map<number, AbortController>();
  ep.addEventListener("message", async (e: MessageEvent) => {
    const msg = e.data as Request;
    if (msg.t === "open") {
      repo = open(msg);
      repo.catch(() => {});
      return;
    }
    if (msg.t === "cancel") {
      controllers.get(msg.id)?.abort();
      return;
    }
    if (msg.t !== "call") return;
    const ctrl = new AbortController();
    controllers.set(msg.id, ctrl);
    try {
      if (!repo) throw new AppError("INTERNAL", "Repository worker was not opened");
      const r = await repo;
      const idx = RPC_METHODS[msg.method];
      if (idx === undefined) throw new AppError("BAD_REQUEST", `Unknown method ${String(msg.method)}`);
      const args = msg.args.slice();
      if (idx >= 0) args[idx] = { ...((args[idx] as object | undefined) ?? {}), signal: ctrl.signal };
      const fn = (r as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[msg.method]!;
      const value = await fn.apply(r, args);
      ep.postMessage({ t: "ok", id: msg.id, value } satisfies Response);
    } catch (err) {
      ep.postMessage({ t: "err", id: msg.id, error: toShape(err) } satisfies Response);
    } finally {
      controllers.delete(msg.id);
    }
  });
  ep.start?.();
}

export interface BrowserRepositoryClient extends RepositoryPort {
  /** Resolves once the worker opened the repository; rejects with the open error (e.g. UNSUPPORTED layout). */
  ready(): Promise<void>;
  /** Terminates the worker. */
  dispose(): void;
}

/** Main-thread side: a RepositoryPort whose methods run in the worker. */
export function connectRepository(ep: Endpoint, ref: RepoRef & { provider: "browser" }, open: Omit<OpenMessage, "t" | "repoId">, onDispose?: () => void): BrowserRepositoryClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  ep.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as Response;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.t === "ok") p.resolve(msg.value);
    else p.reject(AppError.from(msg.error));
  });
  ep.start?.();
  ep.postMessage({ t: "open", handle: open.handle, repoId: ref.id, ...(open.name ? { name: open.name } : {}) } satisfies OpenMessage);

  const call = (method: RpcMethod, args: unknown[]): Promise<unknown> => {
    const idx = RPC_METHODS[method];
    let signal: AbortSignal | undefined;
    if (idx >= 0 && args[idx] && typeof args[idx] === "object") {
      const { signal: s, ...rest } = args[idx] as { signal?: AbortSignal };
      signal = s;
      args = args.slice();
      args[idx] = rest;
    }
    if (signal?.aborted) return Promise.reject(new AppError("CANCELLED", "Request was cancelled"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        ep.postMessage({ t: "cancel", id } satisfies Request);
        reject(new AppError("CANCELLED", "Request was cancelled"));
      };
      pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      ep.postMessage({ t: "call", id, method, args } satisfies Request);
    });
  };

  const port = {
    ref,
    key: repoKey(ref),
    subscribe: () => () => {},
    ready: async () => {
      await call("capabilities", []);
    },
    dispose: () => {
      for (const p of pending.values()) p.reject(new AppError("CANCELLED", "Repository was closed"));
      pending.clear();
      onDispose?.();
    },
  } as Record<string, unknown>;
  for (const m of Object.keys(RPC_METHODS) as RpcMethod[]) port[m] = (...args: unknown[]) => call(m, args);
  return port as unknown as BrowserRepositoryClient;
}
