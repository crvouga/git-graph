// External-change detection for local repositories.
//
// One recursive fs.watch per common git dir (covers refs/, packed-refs, every worktree's git dir under
// worktrees/, HEAD/index/MERGE_HEAD/rebase-* of the main worktree) shared by every open worktree of
// that repository, plus one recursive watch per worktree's working tree (ignoring .git and heavy
// dependency dirs). Events are coalesced (debounce), then cheap digests are recomputed and events are
// published only when a digest actually changed. A safety-net poll recovers missed fs events.
//
// Lifecycle: acquire() when the first subscriber for a repo key appears; the release function stops
// watching when the last one leaves (optionally after a linger period).

import { watch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";
import type { EventHub } from "../core/sync/hub.ts";
import type { RepositoryEvent } from "../core/types.ts";
import { hash64 } from "../core/git/refs.ts";
import type { CliGitAdapter, LiteRefs } from "./git-adapter.ts";

export interface WatchOptions {
  debounceMs?: number;
  pollMs?: number;
  /** Keep watching this long after the last release (MCP long-poll gaps). 0 = stop immediately. */
  lingerMs?: number;
  /** Directory names ignored anywhere in a working tree. */
  ignoreDirs?: string[];
}

type Check = "refs" | "status" | "worktrees";

interface Member {
  key: string;
  adapter: CliGitAdapter;
  refcount: number;
  watcher: FSWatcher | null;
  refs: LiteRefs | null;
  statusDigest: string | null;
  worktreesDigest: string | null;
  pending: Set<Check>;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  ready: Promise<void>;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  gen: number;
  lastCheckAt: number | null;
  lastError: { at: number; message: string } | null;
}

interface Group {
  commonDir: string;
  watcher: FSWatcher | null;
  members: Map<string, Member>;
  poll: ReturnType<typeof setInterval> | null;
}

const DEFAULT_IGNORE = ["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".turbo", ".cache", "target", ".venv", "__pycache__"];

/** Git-dir files whose change affects refs/HEAD/operation state. */
const STATE_FILES = /^(HEAD|ORIG_HEAD|MERGE_HEAD|MERGE_MSG|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG|BISECT_START|AUTO_MERGE|REBASE_HEAD|rebase-merge|rebase-apply|sequencer)(\/|$)/;

export class WatchManager {
  private readonly hub: EventHub;
  private readonly groups = new Map<string, Group>();
  private readonly byKey = new Map<string, Member>();
  private readonly opts: Required<WatchOptions>;

  constructor(hub: EventHub, opts: WatchOptions = {}) {
    this.hub = hub;
    this.opts = { debounceMs: opts.debounceMs ?? 60, pollMs: opts.pollMs ?? 5000, lingerMs: opts.lingerMs ?? 0, ignoreDirs: opts.ignoreDirs ?? DEFAULT_IGNORE };
  }

  isWatching(key: string): boolean {
    return this.byKey.has(key);
  }

  /** Start (or join) watching a worktree. Returns a release function. */
  acquire(adapter: CliGitAdapter): () => void {
    let m = this.byKey.get(adapter.key);
    if (m) {
      m.refcount++;
      if (m.lingerTimer) {
        clearTimeout(m.lingerTimer);
        m.lingerTimer = null;
      }
    } else {
      m = this.start(adapter);
    }
    const member = m;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      member.refcount--;
      if (member.refcount > 0) return;
      if (this.opts.lingerMs > 0) member.lingerTimer = setTimeout(() => this.stop(member), this.opts.lingerMs);
      else this.stop(member);
    };
  }

  /** Resolves once the baseline digests of a watched key were computed. */
  async ready(key: string): Promise<void> {
    await this.byKey.get(key)?.ready;
  }

  /** Re-check now (after a mutation, or on explicit refresh). Resolves after events were published. */
  async poke(key: string, checks: Check[] = ["refs", "status", "worktrees"]): Promise<void> {
    const m = this.byKey.get(key);
    if (!m) return;
    await m.ready;
    for (const c of checks) m.pending.add(c);
    if (m.timer) {
      clearTimeout(m.timer);
      m.timer = null;
    }
    await this.flush(m);
  }

  info(key: string): { watching: boolean; refsVersion: string | null; lastCheckAt: number | null; lastError: { at: number; message: string } | null } {
    const m = this.byKey.get(key);
    return { watching: !!m, refsVersion: m?.refs?.version ?? null, lastCheckAt: m?.lastCheckAt ?? null, lastError: m?.lastError ?? null };
  }

  close() {
    for (const m of [...this.byKey.values()]) this.stop(m);
  }

  // -------------------------------------------------------------------------

  private start(adapter: CliGitAdapter): Member {
    let g = this.groups.get(adapter.commonDir);
    if (!g) {
      g = { commonDir: adapter.commonDir, watcher: null, members: new Map(), poll: null };
      this.groups.set(adapter.commonDir, g);
      const group = g;
      g.watcher = safeWatch(adapter.commonDir, (file) => this.onCommonEvent(group, file));
      g.poll = setInterval(() => {
        for (const mm of group.members.values()) this.schedule(mm, ["refs", "status", "worktrees"], 0);
      }, this.opts.pollMs);
      g.poll.unref?.();
    }
    const m: Member = {
      key: adapter.key,
      adapter,
      refcount: 1,
      watcher: null,
      refs: null,
      statusDigest: null,
      worktreesDigest: null,
      pending: new Set(),
      timer: null,
      running: null,
      ready: Promise.resolve(),
      lingerTimer: null,
      gen: 0,
      lastCheckAt: null,
      lastError: null,
    };
    m.ready = this.baseline(m);
    g.members.set(adapter.key, m);
    this.byKey.set(adapter.key, m);
    const ignore = new Set(this.opts.ignoreDirs);
    m.watcher = safeWatch(adapter.toplevel, (file) => {
      if (file === null) return this.schedule(m, ["status"]);
      const first = file.split(/[\\/]/)[0]!;
      if (first === ".git") return; // the git dir is covered by the common-dir watcher
      if (file.split(/[\\/]/).some((seg) => ignore.has(seg))) return;
      this.schedule(m, ["status"]);
    });
    return m;
  }

  private async baseline(m: Member) {
    try {
      const [refs, status, wts] = await Promise.all([m.adapter.refsLite(), m.adapter.statusDigest(), this.worktreesDigest(m)]);
      m.refs = refs;
      m.statusDigest = status;
      m.worktreesDigest = wts;
      m.lastCheckAt = Date.now();
    } catch (e) {
      m.lastError = { at: Date.now(), message: e instanceof Error ? e.message : String(e) };
    }
  }

  private stop(m: Member) {
    if (this.byKey.get(m.key) !== m) return;
    if (m.timer) clearTimeout(m.timer);
    if (m.lingerTimer) clearTimeout(m.lingerTimer);
    m.watcher?.close();
    this.byKey.delete(m.key);
    const g = this.groups.get(m.adapter.commonDir);
    if (!g) return;
    g.members.delete(m.key);
    if (!g.members.size) {
      g.watcher?.close();
      if (g.poll) clearInterval(g.poll);
      this.groups.delete(g.commonDir);
    }
  }

  private onCommonEvent(g: Group, file: string | null) {
    if (file === null) {
      for (const m of g.members.values()) this.schedule(m, ["refs", "status", "worktrees"]);
      return;
    }
    const rel = file.split(sep).join("/");
    if (/^(objects|logs|hooks|lfs|info|modules)(\/|$)/.test(rel) || rel === "FETCH_HEAD" || rel === "COMMIT_EDITMSG" || rel.endsWith(".tmp")) return;
    const all = [...g.members.values()];
    if (rel === "worktrees" || /^worktrees\/[^/]+$/.test(rel)) {
      for (const m of all) this.schedule(m, ["worktrees", "refs"]);
      return;
    }
    const wt = /^worktrees\/([^/]+)\/(.+)$/.exec(rel);
    if (wt) {
      const gitDir = join(g.commonDir, "worktrees", wt[1]!);
      const own = all.find((m) => m.adapter.gitDir === gitDir);
      if (wt[2] === "index" || wt[2] === "index.lock") {
        if (own) this.schedule(own, ["status"]);
        return;
      }
      if (/^(locked|gitdir|prunable)$/.test(wt[2]!)) for (const m of all) this.schedule(m, ["worktrees"]);
      if (STATE_FILES.test(wt[2]!) && own) this.schedule(own, ["status"]);
      for (const m of all) this.schedule(m, ["refs"]);
      return;
    }
    const main = all.find((m) => m.adapter.gitDir === g.commonDir);
    if (rel === "index" || rel === "index.lock") {
      if (main) this.schedule(main, ["status"]);
      return;
    }
    if (STATE_FILES.test(rel)) {
      if (main) this.schedule(main, ["status"]);
      for (const m of all) this.schedule(m, ["refs"]);
      return;
    }
    if (/^(refs|reftable)(\/|$)/.test(rel) || /^packed-refs/.test(rel) || rel === "config" || rel === "config.lock") {
      for (const m of all) this.schedule(m, ["refs"]);
    }
  }

  private schedule(m: Member, checks: Check[], delay = this.opts.debounceMs) {
    for (const c of checks) m.pending.add(c);
    if (m.timer) return;
    m.timer = setTimeout(() => {
      m.timer = null;
      void this.flush(m);
    }, delay);
  }

  private async flush(m: Member): Promise<void> {
    // One check at a time per worktree; changes arriving meanwhile run right after.
    while (m.running) await m.running;
    if (!m.pending.size || this.byKey.get(m.key) !== m) return;
    const checks = new Set(m.pending);
    m.pending.clear();
    m.running = this.runChecks(m, checks).finally(() => {
      m.running = null;
    });
    await m.running;
    if (m.pending.size && !m.timer) await this.flush(m);
  }

  private publish(e: RepositoryEvent, m: Member, tag: string) {
    this.hub.publish(e, `${e.type}:${tag}:${m.gen}`);
  }

  private async runChecks(m: Member, checks: Set<Check>) {
    await m.ready;
    try {
      if (checks.has("refs")) {
        const next = await m.adapter.refsLite();
        const prev = m.refs;
        if (!prev || prev.version !== next.version) {
          m.refs = next;
          m.gen++;
          this.publish({ type: "refs.changed", repositoryId: m.key, version: next.version }, m, next.version);
          if (prev) {
            const added = await m.adapter.newCommits(prev.refs, next.refs).catch(() => [] as string[]);
            if (added.length) this.publish({ type: "commits.added", repositoryId: m.key, commits: added }, m, next.version);
          }
          checks.add("status"); // HEAD may have moved under the index
        }
      }
      if (checks.has("worktrees")) {
        const d = await this.worktreesDigest(m);
        if (d !== m.worktreesDigest) {
          m.worktreesDigest = d;
          m.gen++;
          this.publish({ type: "worktree.changed", repositoryId: m.key, worktreeId: m.adapter.toplevel }, m, d);
        }
      }
      if (checks.has("status")) {
        const d = await m.adapter.statusDigest();
        if (d !== m.statusDigest) {
          m.statusDigest = d;
          m.gen++;
          this.publish({ type: "status.changed", repositoryId: m.key, worktreeId: m.adapter.toplevel }, m, d);
        }
      }
      m.lastCheckAt = Date.now();
      m.lastError = null;
    } catch (e) {
      m.lastError = { at: Date.now(), message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async worktreesDigest(m: Member): Promise<string> {
    const list = await m.adapter.worktrees();
    return hash64(JSON.stringify(list.map((w) => [w.path, w.head, w.branch, w.locked, w.lockReason, w.prunable, w.bare, w.detached])));
  }
}

function safeWatch(dir: string, cb: (file: string | null) => void): FSWatcher | null {
  try {
    const w = watch(dir, { recursive: true, persistent: false }, (_ev, file) => cb(file === null || file === undefined ? null : String(file)));
    w.on("error", () => {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    });
    return w;
  } catch {
    // Recursive watch unsupported or directory missing: the safety-net poll still runs.
    return null;
  }
}
