// Reads, operations and the browser-tab agent, all through Zero.
//
//  - useRead(): a repository read (commit details, a diff, a file, blame…) is a row in `reads`.
//    Asking for it is a mutation; the agent serving the repository fills it in; every viewer of
//    the repository shares the result. Components render whatever is there.
//  - runOperation(): a git command is a row in `operations`, executed by the repository's agent,
//    with the destructive-confirmation round trip (state "confirm" → ask → confirm token).
//  - The browser agent: folders opened with "Open Folder…" are read in this tab and published to
//    the account through the same mutators a companion uses.

import { createComputed, createSignal, on, type Accessor } from "solid-js";
import { startZeroAgent } from "../../agent/zero-agent.ts";
import { createRepoRegistry } from "../../core/commands/repo-commands.ts";
import { AppError, type MutationResult } from "../../core/types.ts";
import { mutators, type ReadMethod } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import { readId } from "../../zero/rows.ts";
import type { ErrorJson } from "../../zero/schema.ts";
import { loadHandle } from "./handles.ts";
import { boot, live, mutate, zero } from "./zero.ts";

export interface ReadRow {
  id: string;
  state: string;
  result?: unknown;
  error?: ErrorJson | null;
}

export interface ReadState<T> {
  /** The result, once any agent has produced it (kept across re-runs of live reads). */
  value: Accessor<T | undefined>;
  error: Accessor<ErrorJson | null>;
  /** "none" before asking; "pending" while the agent works; then "ok" / "error". */
  state: Accessor<"none" | "pending" | "ok" | "error">;
}

export interface ReadSpec {
  repoId: string;
  method: ReadMethod;
  params: unknown[];
  /** Re-run when the repository changes (working tree, worktrees, remotes). */
  live?: boolean;
  /** Per-account result (e.g. "repositories"). */
  personal?: boolean;
}

function idOf(s: ReadSpec): string {
  return readId(s.repoId, s.method, s.params, s.personal ? (boot.accountId ?? "anon") : null);
}

/** Ask for a read (idempotent). */
export function requestRead(s: ReadSpec): void {
  mutate(mutators.read.request({ repoId: s.repoId, method: s.method, params: s.params as never, live: !!s.live, ...(s.personal ? { personal: true } : {}), now: Date.now() }));
}

/** A read as Solid accessors. `spec` returning null means "nothing to read yet". */
export function useRead<T>(spec: () => ReadSpec | null): ReadState<T> {
  const id = () => {
    const s = spec();
    return s ? idOf(s) : "";
  };
  const row = live<ReadRow>(() => (id() ? queries.reads.byId({ id: id() }) : null));
  createComputed(
    on(id, (k) => {
      const s = spec();
      if (k && s) requestRead(s);
    }),
  );
  const [last, setLast] = createSignal<T | undefined>(undefined);
  createComputed(on(id, () => setLast(undefined)));
  createComputed(() => {
    const r = row.data();
    if (r?.state === "ok" || (r && r.result != null)) setLast(() => r.result as T);
  });
  return {
    value: last,
    error: () => (row.data()?.state === "error" ? (row.data()?.error ?? null) : null),
    state: () => {
      if (!id()) return "none";
      const s = row.data()?.state;
      return s === "ok" || s === "error" ? s : "pending";
    },
  };
}

/** Wait for a read (for commands that need a value before they can ask anything). */
export function readOnce<T>(s: ReadSpec, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = idOf(s);
    const view = (zero.materialize as unknown as (q: unknown) => { addListener(l: (d: unknown) => void): () => void; destroy(): void })(queries.reads.byId({ id }));
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => view.destroy());
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new AppError("TIMEOUT", "The repository did not answer in time. Is its agent running?"))), timeoutMs);
    view.addListener((d) => {
      const r = d as ReadRow | undefined;
      if (r?.state === "ok") finish(() => resolve(r.result as T));
      else if (r?.state === "error") finish(() => reject(AppError.from(r.error ?? { code: "INTERNAL", message: "Read failed" })));
    });
    requestRead(s);
  });
}

interface OperationRow {
  id: string;
  state: string;
  result?: unknown;
  error?: ErrorJson | null;
  consequence?: string | null;
  confirm_token?: string | null;
}

/**
 * Queue a command for the repository's agent and follow it to the end. `ask` shows the exact
 * consequence of destructive commands; declining cancels. Resolves null when cancelled.
 */
export function runOperation(
  o: { repoId: string | null; agentId?: string | null; command: string; args: Record<string, unknown>; title: string },
  ask: (consequence: string) => Promise<boolean>,
): Promise<MutationResult | null> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const view = (zero.materialize as unknown as (q: unknown) => { addListener(l: (d: unknown) => void): () => void; destroy(): void })(queries.operations.byId({ id }));
    let asked = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      queueMicrotask(() => view.destroy());
      fn();
    };
    view.addListener((d) => {
      const op = d as OperationRow | undefined;
      if (!op) return;
      if (op.state === "ok") finish(() => resolve((op.result ?? { output: "" }) as MutationResult));
      else if (op.state === "error") finish(() => reject(AppError.from(op.error ?? { code: "INTERNAL", message: "Failed" })));
      else if (op.state === "cancelled") finish(() => resolve(null));
      else if (op.state === "confirm" && op.confirm_token && asked !== op.confirm_token) {
        asked = op.confirm_token;
        const token = op.confirm_token;
        void ask(op.consequence ?? "This cannot be undone.").then((yes) => {
          if (yes) mutate(mutators.op.confirm({ id, token, now: Date.now() }));
          else {
            mutate(mutators.op.dismiss({ id, now: Date.now() }));
            finish(() => resolve(null));
          }
        });
      }
    });
    // Args travel as JSON: drop undefined fields (e.g. git.push's unset forceWithLease), which the
    // mutator's JSON validation rejects.
    const args = JSON.parse(JSON.stringify(o.args)) as never;
    const m = mutate(mutators.op.enqueue({ id, repoId: o.repoId, agentId: o.agentId ?? null, command: o.command, args, title: o.title, now: Date.now() }));
    void m.server.then((r) => {
      if (r.type === "error") finish(() => reject(new AppError("FORBIDDEN", r.error?.message ?? "The server refused this action")));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Browser agent: this tab serves the folders it opened.
// ---------------------------------------------------------------------------------------------

const AGENT_KEY = "lanes.browserAgent";

/** This browser's agent id ("browser-…"), stable across reloads. */
export function browserAgentId(): string {
  try {
    const cur = localStorage.getItem(AGENT_KEY);
    if (cur && /^browser-[A-Za-z0-9_-]{8,64}$/.test(cur)) return cur;
    const id = `browser-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    localStorage.setItem(AGENT_KEY, id);
    return id;
  } catch {
    return `browser-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  }
}

let agent: ReturnType<typeof startZeroAgent> | null = null;
const opened = new Map<string, Promise<import("../../core/port.ts").RepositoryPort>>();

async function portFor(repoId: string) {
  let p = opened.get(repoId);
  if (!p) {
    p = (async () => {
      const id = repoId.slice("browser:".length);
      const handle = await loadHandle(id);
      if (!handle) throw new AppError("NOT_FOUND", "This browser no longer has access to that folder. Use “Open folder…” to pick it again.");
      const { openBrowserRepository } = await import("../../browser-git/client.ts");
      const repo = openBrowserRepository(handle, id);
      await (repo as { ready?: () => Promise<void> }).ready?.();
      return repo;
    })();
    opened.set(repoId, p);
    p.catch(() => opened.delete(repoId));
  }
  return p;
}

function ensureAgent() {
  agent ??= startZeroAgent({
    zero: zero as never,
    agentId: browserAgentId(),
    provider: "browser",
    // Offline (Storybook) there is no server to wait for: local writes are the source of truth.
    awaitServer: false,
    registry: createRepoRegistry(),
    appOrigin: location.origin,
    portFor: (repoId) => portFor(repoId),
    pollMs: 60_000,
    heartbeatMs: boot.server ? 60_000 : 0,
  });
  return agent;
}

/**
 * Publish a folder this tab can read (before opening it), so the demand that follows finds it.
 * Throws AppError FORBIDDEN { reauthorize } when the browser needs the user's permission again.
 */
export async function serveBrowserRepo(repoId: string): Promise<boolean> {
  if (!boot.accountId) throw new AppError("UNAUTHENTICATED", "Sign in to open local folders: they are synced to your account.");
  const id = repoId.slice("browser:".length);
  const handle = await loadHandle(id);
  if (!handle) return false; // another browser's folder: only what was synced can be shown
  const perm = await (handle as FileSystemDirectoryHandle & { queryPermission?: (o: object) => Promise<string> }).queryPermission?.({ mode: "read" });
  if (perm && perm !== "granted") throw new AppError("FORBIDDEN", "The browser needs your permission to read this folder again.", { reauthorize: id });
  const a = ensureAgent();
  const port = await portFor(repoId);
  const [info, caps] = await Promise.all([port.info(), port.capabilities()]);
  await a.writer.repo(repoId, info, caps);
  return true;
}
