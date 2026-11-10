// Reconciliation poller. Webhooks are the fast path; polling is what recovers from missed
// deliveries, repos without webhook coverage (no App installation) and backend restarts.
//
// Only repositories with at least one live subscriber are polled. Intervals adapt:
//  - fast (POLL_FAST_SECONDS) when the repo has no recent webhook coverage or just changed,
//  - slower when webhooks are known to arrive for it,
//  - exponential back-off with jitter while idle, up to POLL_MAX_SECONDS,
//  - stretched as the GitHub rate-limit budget shrinks; paused until reset when exhausted.
// Polls are conditional requests, so an idle repository costs 304s (free against the rate limit).

import { AppError } from "../../core/types.ts";
import type { RateBudget } from "../../github/client.ts";
import type { PollerConfig } from "../config.ts";
import type { Reconciler } from "./reconciler.ts";
import type { SubscriptionRegistry } from "./subscriptions.ts";

interface PollState {
  repo: string;
  timer: ReturnType<typeof setTimeout> | null;
  intervalMs: number;
  nextAt: number;
  polls: number;
  running: boolean;
}

export interface PollerOptions {
  reconciler: Reconciler;
  registry: SubscriptionRegistry;
  config: PollerConfig;
  /** Rate-limit budget most relevant for this repository (the token polls will use). */
  budget: (repo: string) => RateBudget | null;
  now?: () => number;
  random?: () => number;
}

export class Poller {
  private readonly o: PollerOptions;
  private readonly polls = new Map<string, PollState>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly off: () => void;
  private closed = false;

  constructor(o: PollerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.off = o.registry.onChange((repo, count) => (count > 0 ? this.start(repo) : this.stop(repo)));
  }

  /** Base interval given webhook coverage. */
  private baseInterval(repo: string): number {
    const s = this.o.reconciler.state(repo);
    const covered = s.lastWebhookAt !== null && this.now() - s.lastWebhookAt < this.o.config.coverageWindowMs;
    return covered ? Math.max(this.o.config.coveredMs, this.o.config.fastMs) : this.o.config.fastMs;
  }

  private withBudget(ms: number, repo: string): number {
    const b = this.o.budget(repo);
    if (!b || !b.limit) return ms;
    if (b.remaining <= 0 || (b.blockedUntil && b.blockedUntil > this.now())) {
      return Math.max(ms, (b.blockedUntil ?? b.resetAt) - this.now() + 1000);
    }
    const frac = b.remaining / b.limit;
    if (frac < 0.05) return ms * 8;
    if (frac < 0.15) return ms * 4;
    if (frac < 0.3) return ms * 2;
    return ms;
  }

  private jitter(ms: number): number {
    const j = this.o.config.jitter;
    return Math.max(10, Math.round(ms * (1 - j + 2 * j * this.random())));
  }

  start(repo: string) {
    if (this.closed || this.polls.has(repo)) return;
    const st: PollState = { repo, timer: null, intervalMs: this.baseInterval(repo), nextAt: 0, polls: 0, running: false };
    this.polls.set(repo, st);
    // First reconciliation right away: establishes the version and catches anything missed while
    // nobody was subscribed (or while the server was down).
    this.schedule(st, 0);
  }

  stop(repo: string) {
    const st = this.polls.get(repo);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    this.polls.delete(repo);
  }

  /** Activity seen elsewhere (webhook or mutation): restart the back-off from the base interval. */
  bump(repo: string) {
    const st = this.polls.get(repo);
    if (!st || st.running) return;
    st.intervalMs = this.baseInterval(repo);
    this.schedule(st, this.withBudget(this.jitter(st.intervalMs), repo));
  }

  private schedule(st: PollState, delay: number) {
    if (st.timer) clearTimeout(st.timer);
    st.nextAt = this.now() + delay;
    st.timer = setTimeout(() => void this.tick(st), delay);
    st.timer.unref?.();
  }

  private async tick(st: PollState) {
    st.timer = null;
    if (this.closed || this.polls.get(st.repo) !== st) return;
    st.running = true;
    st.polls++;
    let changed = false;
    try {
      const r = await this.o.reconciler.request(st.repo);
      changed = r.changed && st.polls > 1;
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === "CANCELLED") return;
    } finally {
      st.running = false;
    }
    if (this.polls.get(st.repo) !== st) return;
    const base = this.baseInterval(st.repo);
    st.intervalMs = changed || st.polls === 1 ? base : Math.min(this.o.config.maxMs, Math.max(base, st.intervalMs * 2));
    this.schedule(st, this.withBudget(this.jitter(st.intervalMs), st.repo));
  }

  info(repo: string): { polling: boolean; intervalMs: number | null; nextPollAt: number | null; polls: number } {
    const st = this.polls.get(repo);
    return st ? { polling: true, intervalMs: st.intervalMs, nextPollAt: st.nextAt, polls: st.polls } : { polling: false, intervalMs: null, nextPollAt: null, polls: 0 };
  }

  close() {
    this.closed = true;
    this.off();
    for (const st of this.polls.values()) if (st.timer) clearTimeout(st.timer);
    this.polls.clear();
  }
}
