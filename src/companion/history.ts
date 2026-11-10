// Streaming history snapshots. One `git log` process per (query, refsVersion); commits are parsed
// incrementally and pages are served by offset as soon as enough rows exist. Snapshots live in a
// small LRU so paging a 100k-commit history never re-runs git.
//
// Cursor = "<snapshotId>:<offset>". snapshotId is a deterministic hash of (worktree, query,
// refsVersion), so:
//   - cursor for a cached snapshot           -> served from it (consistent even if refs moved since)
//   - cursor for an evicted snapshot, refs unchanged -> the stream is restarted and skipped to offset
//   - cursor for an evicted snapshot, refs changed   -> STALE_STATE (mixing two graph snapshots
//     would produce an inconsistent graph; the client reloads from the first page)

import type { ChildProcess } from "node:child_process";
import { AppError, type Commit, type HistoryQuery } from "../core/types.ts";
import { LogStreamParser } from "../core/git/log.ts";
import { hash64 } from "../core/git/refs.ts";
import { stableStringify } from "../core/commands/registry.ts";
import { spawnGitStream } from "./exec.ts";

export function snapshotId(worktree: string, q: HistoryQuery, refsVersion: string): string {
  return hash64(`${worktree}\n${stableStringify(q)}\n${refsVersion}`);
}

export function formatHistoryCursor(id: string, offset: number): string {
  return `${id}:${offset}`;
}

export function parseHistoryCursor(c: string): { id: string; offset: number } | null {
  const m = /^([0-9a-f]{16}):(\d{1,9})$/.exec(c);
  return m ? { id: m[1]!, offset: Number(m[2]) } : null;
}

export class HistorySnapshot {
  readonly id: string;
  readonly refsVersion: string;
  readonly commits: Commit[] = [];
  done = false;
  error: AppError | null = null;
  readonly startedAt = performance.now();
  firstRowsAt: number | null = null;
  endedAt: number | null = null;
  private proc: ChildProcess | null;
  private waiters = new Set<() => void>();

  constructor(id: string, refsVersion: string, args: string[], cwd: string, stashes: ReadonlySet<string>) {
    this.id = id;
    this.refsVersion = refsVersion;
    const parser = new LogStreamParser();
    // Stash commits are shown as single rows hanging off their base commit: their index/untracked
    // helper commits (2nd/3rd parents) are hidden. Date order prints children before parents, so the
    // helpers are always seen after the stash itself.
    const hidden = new Set<string>();
    const proc = spawnGitStream(args, cwd);
    this.proc = proc;
    let stderr = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      const rows = parser.push(chunk);
      if (!rows.length) return;
      for (const c of rows) {
        if (hidden.size && hidden.has(c.hash)) continue;
        if (stashes.size && stashes.has(c.hash) && c.parents.length > 1) {
          for (const p of c.parents.slice(1)) hidden.add(p);
          c.parents = [c.parents[0]!];
        }
        this.commits.push(c);
      }
      this.firstRowsAt ??= performance.now();
      this.wake();
    });
    proc.stderr!.on("data", (b: Buffer) => {
      if (stderr.length < 8192) stderr += b.toString("utf8");
    });
    proc.on("error", (e) => {
      this.finish(new AppError("GIT_MISSING", `Cannot run git: ${e.message}`));
    });
    proc.on("close", (code, signal) => {
      if (this.done) return;
      if (code === 0) this.finish(null);
      else if (signal) this.finish(new AppError("CANCELLED", "History stream was stopped"));
      else {
        const msg = stderr.trim() || `git log exited with ${code}`;
        const notFound = /unknown revision|bad revision|ambiguous argument/i.test(msg);
        this.finish(new AppError(notFound ? "REF_NOT_FOUND" : "GIT_FAILED", msg));
      }
    });
  }

  private finish(err: AppError | null) {
    this.done = true;
    this.error = err;
    this.endedAt = performance.now();
    this.proc = null;
    this.wake();
  }

  private wake() {
    for (const w of [...this.waiters]) w();
  }

  /** Resolve once at least `n` rows exist or the stream ended. */
  waitFor(n: number, signal?: AbortSignal): Promise<void> {
    if (this.commits.length >= n || this.done) return this.error ? Promise.reject(this.error) : Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.error) {
          cleanup();
          reject(this.error);
        } else if (this.commits.length >= n || this.done) {
          cleanup();
          resolve();
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new AppError("CANCELLED", "Request was cancelled"));
      };
      const cleanup = () => {
        this.waiters.delete(check);
        signal?.removeEventListener("abort", onAbort);
      };
      this.waiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Wait for the whole stream. */
  async complete(signal?: AbortSignal): Promise<void> {
    await this.waitFor(Number.MAX_SAFE_INTEGER, signal);
  }

  stop() {
    if (this.proc && !this.done) this.proc.kill("SIGTERM");
  }
}

export class HistoryCache {
  private readonly map = new Map<string, HistorySnapshot>();
  private readonly max: number;
  constructor(max = 4) {
    this.max = max;
  }
  get(id: string): HistorySnapshot | undefined {
    const s = this.map.get(id);
    if (s) {
      // LRU touch; failed snapshots are not reused.
      this.map.delete(id);
      if (s.error && s.error.code !== "REF_NOT_FOUND") return undefined;
      this.map.set(id, s);
    }
    return s;
  }
  add(s: HistorySnapshot) {
    this.map.set(s.id, s);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value!;
      this.map.get(oldest)?.stop();
      this.map.delete(oldest);
    }
  }
  clear() {
    for (const s of this.map.values()) s.stop();
    this.map.clear();
  }
}
