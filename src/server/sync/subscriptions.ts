// Who is listening to which repository, with which credentials.
//
// - `interest` entries come from the API's onSubscribe hook: they keep a repository "live"
//   (poller running) and carry a way to obtain a token that can read it.
// - The guarded hub wraps EventHub.subscribe so every SSE listener knows its principal
//   (from AsyncLocalStorage set per request). After an `access.revoked` event (for the repo, or for
//   the user/session) the listener is sealed: nothing else is delivered on that stream, and the
//   client must reconnect, which re-runs authorization.

import { AsyncLocalStorage } from "node:async_hooks";
import type { EventHub, HubListener } from "../../core/sync/hub.ts";
import type { EventEnvelope } from "../../core/types.ts";

export interface Principal {
  sessionKey: string | null;
  /** Signed-in Lanes account, if any. */
  accountId: string | null;
  /** GitHub user id of the account's connected GitHub, if any. */
  userId: number | null;
  /** Returns a token able to read repositories for this principal (null = anonymous). */
  token: () => Promise<string | null>;
}

interface Listener {
  repo: string;
  principal: Principal | null;
  sealed: boolean;
  fn: HubListener;
}

interface Interest {
  repo: string;
  principal: Principal | null;
}

export class SubscriptionRegistry {
  readonly als = new AsyncLocalStorage<Principal>();
  private readonly listeners = new Set<Listener>();
  private readonly interests = new Set<Interest>();
  private readonly changeHandlers = new Set<(repo: string, count: number) => void>();
  private readonly hub: EventHub;

  constructor(hub: EventHub) {
    this.hub = hub;
  }

  /** An EventHub facade for createApi whose subscriptions are principal-aware and sealable. */
  guardedHub(): EventHub {
    const hub = this.hub;
    const facade = {
      get epoch() {
        return hub.epoch;
      },
      cursor: () => hub.cursor(),
      listenerCount: (repo: string) => hub.listenerCount(repo),
      publish: hub.publish.bind(hub),
      subscribeAll: hub.subscribeAll.bind(hub),
      subscribe: (repo: string, fn: HubListener, cursor?: string | null) => {
        const l: Listener = { repo, principal: this.als.getStore() ?? null, sealed: false, fn };
        this.listeners.add(l);
        const unsub = hub.subscribe(
          repo,
          (env) => {
            if (l.sealed) return;
            l.fn(env);
            if (env.event.type === "access.revoked") l.sealed = true;
          },
          cursor,
        );
        return () => {
          this.listeners.delete(l);
          unsub();
        };
      },
    };
    return facade as unknown as EventHub;
  }

  /** Register interest (from onSubscribe). Returns the release function. */
  addInterest(repo: string, principal: Principal | null): () => void {
    const it: Interest = { repo, principal };
    this.interests.add(it);
    this.emit(repo);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.interests.delete(it);
      this.emit(repo);
    };
  }

  onChange(fn: (repo: string, count: number) => void): () => void {
    this.changeHandlers.add(fn);
    return () => this.changeHandlers.delete(fn);
  }

  private emit(repo: string) {
    const n = this.interestCount(repo);
    for (const fn of this.changeHandlers) fn(repo, n);
  }

  interestCount(repo: string): number {
    let n = 0;
    for (const i of this.interests) if (i.repo === repo) n++;
    return n;
  }

  /** Distinct principals interested in a repository (signed-in first). */
  principals(repo: string): (Principal | null)[] {
    const out: (Principal | null)[] = [];
    const seen = new Set<string>();
    for (const i of this.interests) {
      if (i.repo !== repo) continue;
      const k = i.principal?.sessionKey ?? "anon";
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(i.principal);
    }
    return out.sort((a, b) => (a?.userId ? 0 : 1) - (b?.userId ? 0 : 1));
  }

  liveRepos(): string[] {
    return [...new Set([...this.interests].map((i) => i.repo))];
  }

  /** Deliver `access.revoked` to (and seal) every stream matching `pred`. */
  revoke(pred: (p: Principal | null, repo: string) => boolean): number {
    let n = 0;
    for (const l of this.listeners) {
      if (l.sealed || !pred(l.principal, l.repo)) continue;
      const env: EventEnvelope = { epoch: this.hub.epoch, seq: Number(this.hub.cursor().split(":").pop()), at: Date.now(), event: { type: "access.revoked", repositoryId: l.repo } };
      try {
        l.fn(env);
      } catch {
        /* ignore */
      }
      l.sealed = true;
      n++;
    }
    for (const i of [...this.interests]) {
      if (pred(i.principal, i.repo)) {
        this.interests.delete(i);
        this.emit(i.repo);
      }
    }
    return n;
  }
}
