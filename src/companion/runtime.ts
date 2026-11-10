// Wires local repositories, the event hub and the watcher together. Shared by the companion HTTP
// server and the in-process MCP server.

import { EventHub } from "../core/sync/hub.ts";
import type { RepositoryResolver } from "../core/port.ts";
import type { CommandRegistry } from "../core/commands/registry.ts";
import { LocalRepos } from "./local-repos.ts";
import { WatchManager, type WatchOptions } from "./watch.ts";
import { createCompanionRegistry } from "./commands.ts";

export interface LocalRuntime {
  hub: EventHub;
  watch: WatchManager;
  local: LocalRepos;
  registry: CommandRegistry;
  /** Start watching a key (async resolve); returns a release function usable immediately. */
  acquire(key: string): { release: () => void; ready: Promise<void> };
  close(): void;
}

export function createLocalRuntime(opts: { configDir?: string; fallback?: RepositoryResolver; watch?: WatchOptions; hub?: EventHub } = {}): LocalRuntime {
  const hub = opts.hub ?? new EventHub();
  const watch = new WatchManager(hub, opts.watch);
  const local: LocalRepos = new LocalRepos({
    configDir: opts.configDir,
    fallback: opts.fallback,
    hooks: () => ({
      subscribe: (key, listener) => {
        const sub = acquire(key);
        const unsub = hub.subscribe(key, (env) => listener(env.event));
        return () => {
          unsub();
          sub.release();
        };
      },
      onMutated: (key) => void watch.poke(key),
      publish: (e) => hub.publish(e),
    }),
  });

  function acquire(key: string): { release: () => void; ready: Promise<void> } {
    if (!key.startsWith("local:")) return { release: () => {}, ready: Promise.resolve() };
    let release: (() => void) | null = null;
    let cancelled = false;
    const ready = local.local(key).then(
      async (adapter) => {
        if (cancelled) return;
        release = watch.acquire(adapter);
        await watch.ready(key);
      },
      () => {},
    );
    return {
      release: () => {
        cancelled = true;
        release?.();
        release = null;
      },
      ready,
    };
  }

  return {
    hub,
    watch,
    local,
    registry: createCompanionRegistry(local),
    acquire,
    close() {
      watch.close();
      local.dispose();
    },
  };
}
