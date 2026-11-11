// The web client's single data path: one Zero instance, synced with the server through /zero.
//
// Nothing here waits. Zero answers every query from its local store at once (persisted in
// IndexedDB, so a reload shows the last state immediately) and fills in what the server sends.
// The UI renders what it has; there is no loading state to show.

import { Zero } from "@rocicorp/zero";
import { createComputed, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { mutators } from "../../zero/mutators.ts";
import { schema, type ZeroContext } from "../../zero/schema.ts";
import { IN_STORYBOOK } from "./env.ts";

export interface Boot {
  /** Signed-in account id (null when signed out). */
  accountId: string | null;
  loginEnabled: boolean;
  githubEnabled: boolean;
  /** The page came from a Lanes server (not a static preview / Storybook). */
  server: boolean;
}

/** The readable boot cookie the server sets with every page: "<account id>.<login><github>". */
export function readBoot(cookie = typeof document === "undefined" ? "" : document.cookie): Boot {
  const secure = typeof location !== "undefined" && location.protocol === "https:";
  const name = secure ? "__Host-lanes_boot" : `lanes_boot_${(typeof location !== "undefined" && location.port) || "80"}`;
  const raw = cookie
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!raw) return { accountId: null, loginEnabled: false, githubEnabled: false, server: false };
  const v = decodeURIComponent(raw);
  const dot = v.lastIndexOf(".");
  const uid = v.slice(0, dot);
  const flags = v.slice(dot + 1);
  return { accountId: uid || null, loginEnabled: flags[0] === "1", githubEnabled: flags[1] === "1", server: true };
}

/** Storybook runs Zero offline with a pretend account, so local writes (the browser agent) stick. */
export const STORYBOOK_ACCOUNT = "00000000-0000-4000-8000-00000000057b";

export const boot: Boot = IN_STORYBOOK ? { accountId: STORYBOOK_ACCOUNT, loginEnabled: true, githubEnabled: true, server: false } : readBoot();

const context: ZeroContext = { accountId: boot.accountId, agentId: null };

export const zero = new Zero({
  // Offline in Storybook: every query is answered by the in-memory store, nothing is pushed.
  cacheURL: IN_STORYBOOK ? null : `${location.origin}/zero`,
  ...(boot.accountId ? { userID: boot.accountId } : {}),
  schema,
  mutators,
  context,
  kvStore: IN_STORYBOOK ? "mem" : "idb",
  storageKey: "lanes",
  onUpdateNeeded: () => location.reload(),
});

export type AppZero = typeof zero;

/** Run a mutator; failures surface through the rows it was meant to change (never awaited by UI). */
export function mutate(m: unknown): { client: Promise<unknown>; server: Promise<{ type: string; error?: { message: string } }> } {
  return (zero.mutate as unknown as (m: unknown) => { client: Promise<unknown>; server: Promise<{ type: string; error?: { message: string } }> })(m);
}

export type ResultType = "unknown" | "cached" | "complete" | "error";

interface QueryLike {
  args?: unknown;
  query?: { queryName?: string };
}

function keyOf(q: unknown): string {
  const r = q as QueryLike;
  return `${r.query?.queryName ?? "?"}:${JSON.stringify(r.args ?? null)}`;
}

/**
 * A synced query as Solid accessors. `query` may return a falsy value while its inputs are
 * missing. Must run under a reactive owner (component or createRoot); the view is destroyed with it.
 */
export function live<T>(query: () => unknown, opts: { ttl?: "none" | `${number}s` | `${number}m` } = {}): { data: Accessor<T | undefined>; type: Accessor<ResultType> } {
  const [data, setData] = createSignal<T | undefined>(undefined, { equals: false });
  const [type, setType] = createSignal<ResultType>("unknown");
  // A memo: re-materialize only when the query itself changes, not on every signal it reads.
  const key = createMemo(() => {
    const q = query();
    return q ? keyOf(q) : "";
  });
  createComputed(
    on(key, (k) => {
      setData(undefined);
      setType("unknown");
      if (!k) return;
      const q = query();
      const view = (zero.materialize as unknown as (q: unknown, o?: object) => { addListener(l: (d: unknown, t: ResultType) => void): () => void; destroy(): void })(q, opts.ttl ? { ttl: opts.ttl } : undefined);
      view.addListener((d, t) => {
        setData(() => d as T);
        setType(t);
      });
      onCleanup(() => view.destroy());
    }),
  );
  return { data, type };
}

/** A performance mark for the first time something happens on this page (read by the perf test). */
export function markOnce(name: string): void {
  if (performance.getEntriesByName(name, "mark").length === 0) performance.mark(name);
}

/** Zero's connection state, as a signal (for the sync indicator). */
export const [connection, setConnection] = createSignal<{ name: string; reason?: string }>({ name: IN_STORYBOOK ? "connected" : "connecting" });
if (!IN_STORYBOOK) {
  zero.connection.state.subscribe((s) => {
    setConnection(s as { name: string; reason?: string });
    if ((s as { name: string }).name === "connected") markOnce("lanes:zero-connected");
    // A session that ended (sign-out elsewhere, expiry): reload to start over as who we are now.
    if ((s as { name: string }).name === "needs-auth") location.reload();
  });
}
