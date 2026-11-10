// Parser for `git status --porcelain=v2 -z --branch`.

import type { FileChange, FileStatus, WorkingTreeStatus } from "../types.ts";

export interface ParsedStatus extends Omit<WorkingTreeStatus, "operation"> {
  /** "# branch.oid": commit hash, or null for "(initial)". */
  oid: string | null;
  /** "# branch.head": branch short name, or null when detached. */
  head: string | null;
  ignored: string[];
}

function letter(c: string): FileStatus | null {
  switch (c) {
    case "M":
    case "T":
    case "A":
    case "D":
    case "R":
    case "C":
    case "U":
      return c;
    default:
      return null;
  }
}

/** Split `s` at the first `n` spaces; the remainder (which may contain spaces) is the last element. */
function splitN(s: string, n: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const sp = s.indexOf(" ", start);
    if (sp < 0) break;
    out.push(s.slice(start, sp));
    start = sp + 1;
  }
  out.push(s.slice(start));
  return out;
}

export function parseStatusV2(out: string): ParsedStatus {
  const tok = out.split("\0");
  const res: ParsedStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], ignored: [], oid: null, head: null };
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]!;
    if (!t) continue;
    const type = t[0];
    if (type === "#") {
      const [, key, ...rest] = t.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") res.oid = val === "(initial)" ? null : val;
      else if (key === "branch.head") res.head = val === "(detached)" ? null : val;
      else if (key === "branch.upstream") upstream = val;
      else if (key === "branch.ab") {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
    } else if (type === "1") {
      const f = splitN(t, 8);
      push(res, f[1]!, f[8]!);
    } else if (type === "2") {
      const f = splitN(t, 9);
      const orig = tok[++i] ?? "";
      push(res, f[1]!, f[9]!, orig);
    } else if (type === "u") {
      const f = splitN(t, 10);
      res.conflicted.push({ path: f[10]!, status: "U" });
    } else if (type === "?") {
      res.untracked.push(t.slice(2));
    } else if (type === "!") {
      res.ignored.push(t.slice(2));
    }
  }
  if (res.head) res.branch = { name: res.head, ...(upstream ? { upstream } : {}), ahead, behind };
  return res;
}

function push(res: ParsedStatus, xy: string, path: string, orig?: string) {
  const x = letter(xy[0]!);
  const y = letter(xy[1]!);
  if (x) {
    const fc: FileChange = { path, status: x };
    if (orig && (x === "R" || x === "C")) fc.oldPath = orig;
    res.staged.push(fc);
  }
  if (y) {
    const fc: FileChange = { path, status: y };
    if (orig && (y === "R" || y === "C")) fc.oldPath = orig;
    res.unstaged.push(fc);
  }
}
