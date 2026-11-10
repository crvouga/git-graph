// Parser for `git worktree list --porcelain [-z]`.

import type { Worktree } from "../types.ts";

/**
 * `sep` is "\0" for `-z` output (git >= 2.36) or "\n" otherwise. Records are separated by an empty
 * line/token. `currentPath` marks the worktree the caller is bound to.
 */
export function parseWorktreeList(out: string, sep: "\0" | "\n" = "\0", currentPath?: string): Worktree[] {
  const lines = out.split(sep);
  const result: Worktree[] = [];
  let cur: Worktree | null = null;
  const flush = () => {
    if (cur) result.push(cur);
    cur = null;
  };
  for (const raw of lines) {
    const line = sep === "\n" ? raw.replace(/\r$/, "") : raw;
    if (!line) {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur = { path: val, head: null, bare: false, detached: false, locked: false, prunable: false, isMain: result.length === 0, isCurrent: false };
      continue;
    }
    if (!cur) continue;
    const w: Worktree = cur;
    switch (key) {
      case "HEAD":
        w.head = /^0+$/.test(val) ? null : val;
        break;
      case "branch":
        w.branch = val;
        break;
      case "detached":
        w.detached = true;
        break;
      case "bare":
        w.bare = true;
        break;
      case "locked":
        w.locked = true;
        if (val) w.lockReason = val;
        break;
      case "prunable":
        w.prunable = true;
        if (val) w.prunableReason = val;
        break;
    }
  }
  flush();
  if (currentPath !== undefined) for (const w of result) w.isCurrent = w.path === currentPath;
  return result;
}
