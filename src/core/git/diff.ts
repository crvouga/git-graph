// Parsers for `git diff --raw --numstat -z` (file lists with renames) and unified patch text.

import type { DiffLine, FileChange, FileDiff, FileStatus, Hunk } from "../types.ts";
import { unquoteCPath } from "./text.ts";

function statusLetter(s: string): FileStatus {
  const c = s[0];
  return c === "A" || c === "M" || c === "D" || c === "R" || c === "C" || c === "T" || c === "U" ? c : "M";
}

/**
 * Parse `--raw --numstat -z` output (either section may be absent). Raw records carry the status and
 * rename source; numstat records carry line counts ("-" for binary). Records pair up in order.
 */
export function parseRawNumstat(out: string): FileChange[] {
  const tok = out.split("\0");
  const files: FileChange[] = [];
  const stats: { add: string; del: string; path: string; oldPath?: string }[] = [];
  let i = 0;
  while (i < tok.length) {
    let t = tok[i]!;
    if (t.startsWith("\n")) t = t.slice(1);
    if (!t) {
      i++;
      continue;
    }
    if (t[0] === ":") {
      const parts = t.slice(1).split(" ");
      const st = parts[4] ?? "M";
      const letter = statusLetter(st);
      if (letter === "R" || letter === "C") {
        files.push({ path: tok[i + 2]!, oldPath: tok[i + 1]!, status: letter });
        i += 3;
      } else {
        files.push({ path: tok[i + 1]!, status: letter });
        i += 2;
      }
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (m) {
      if (m[3] === "") {
        stats.push({ add: m[1]!, del: m[2]!, oldPath: tok[i + 1]!, path: tok[i + 2]! });
        i += 3;
      } else {
        stats.push({ add: m[1]!, del: m[2]!, path: m[3]! });
        i += 1;
      }
      continue;
    }
    i++;
  }
  if (!files.length) {
    // numstat only: infer statuses as best we can.
    return stats.map((s) => applyStat({ path: s.path, status: s.oldPath ? "R" : "M", ...(s.oldPath ? { oldPath: s.oldPath } : {}) }, s));
  }
  const byPath = new Map<string, (typeof stats)[number]>();
  for (const s of stats) byPath.set(s.path, s);
  files.forEach((f, idx) => {
    const s = stats[idx] && stats[idx]!.path === f.path ? stats[idx] : byPath.get(f.path);
    if (s) applyStat(f, s);
  });
  return files;
}

function applyStat(f: FileChange, s: { add: string; del: string }): FileChange {
  if (s.add === "-" || s.del === "-") {
    f.binary = true;
  } else {
    f.additions = Number(s.add);
    f.deletions = Number(s.del);
  }
  return f;
}

// ---------------------------------------------------------------------------
// Unified patch text
// ---------------------------------------------------------------------------

export interface PatchSection {
  oldPath?: string;
  newPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  /** Raw header lines (diff --git, index, mode, rename...). */
  header: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string, prefix: string): string | undefined {
  if (p === "/dev/null") return undefined;
  let v = p.endsWith("\t") ? p.slice(0, -1) : p; // git appends TAB when the name contains a space
  v = unquoteCPath(v);
  return v.startsWith(prefix) ? v.slice(prefix.length) : v;
}

/** Path from "diff --git a/X b/X" when both sides are equal (the only unambiguous case). */
function pathFromDiffGit(line: string): string | undefined {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|.*)$/.exec(rest);
    if (m) return stripPrefix(m[2]!, "b/");
    return undefined;
  }
  const n = rest.length;
  if ((n - 1) % 2 !== 0) return undefined;
  const half = (n - 1) / 2;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  if (a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)) return a.slice(2);
  return undefined;
}

/** Parse unified diff text (as produced by git diff/diff-tree -p) into per-file sections. */
export function parsePatch(text: string): PatchSection[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const sections: PatchSection[] = [];
  let cur: PatchSection | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      cur = { status: "M", binary: false, hunks: [], header: [line] };
      const p = pathFromDiffGit(line);
      if (p !== undefined) {
        cur.oldPath = p;
        cur.newPath = p;
      }
      sections.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (hunk && (oldLeft > 0 || newLeft > 0 || line.startsWith("\\"))) {
      const c = line[0];
      let dl: DiffLine;
      if (c === "+") {
        dl = { kind: "add", text: line.slice(1), newNo: newNo++ };
        newLeft--;
      } else if (c === "-") {
        dl = { kind: "del", text: line.slice(1), oldNo: oldNo++ };
        oldLeft--;
      } else if (c === "\\") {
        dl = { kind: "meta", text: line };
      } else {
        dl = { kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ };
        oldLeft--;
        newLeft--;
      }
      hunk.lines.push(dl);
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      const oldStart = Number(hm[1]);
      const oldLines = hm[2] === undefined ? 1 : Number(hm[2]);
      const newStart = Number(hm[3]);
      const newLines = hm[4] === undefined ? 1 : Number(hm[4]);
      hunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
      cur.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }
    if (hunk) continue; // trailing junk after a complete hunk
    cur.header.push(line);
    if (line.startsWith("new file mode")) cur.status = "A";
    else if (line.startsWith("deleted file mode")) cur.status = "D";
    else if (line.startsWith("rename from ")) {
      cur.status = "R";
      cur.oldPath = unquoteCPath(line.slice(12));
    } else if (line.startsWith("rename to ")) cur.newPath = unquoteCPath(line.slice(10));
    else if (line.startsWith("copy from ")) {
      cur.status = "C";
      cur.oldPath = unquoteCPath(line.slice(10));
    } else if (line.startsWith("copy to ")) cur.newPath = unquoteCPath(line.slice(8));
    else if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4), "a/");
      if (p !== undefined) cur.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4), "b/");
      if (p !== undefined) cur.newPath = p;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
    else if (line.startsWith("old mode") && cur.status === "M") cur.status = "M";
  }
  return sections;
}

/** Turn patch sections into FileDiffs (paths from the patch headers only). */
export function parseUnifiedDiff(text: string): FileDiff[] {
  return parsePatch(text).map((s) => sectionToFileDiff(s));
}

function sectionToFileDiff(s: PatchSection, f?: FileChange): FileDiff {
  const status = f?.status ?? s.status;
  const path = f?.path ?? (status === "D" ? s.oldPath : s.newPath) ?? s.oldPath ?? "";
  const oldPath = f ? f.oldPath : s.oldPath !== s.newPath && s.oldPath && s.newPath ? s.oldPath : undefined;
  const fd: FileDiff = { path, status, binary: s.binary || !!f?.binary, hunks: s.binary ? [] : s.hunks };
  if (oldPath) fd.oldPath = oldPath;
  return fd;
}

/**
 * Pair a raw file list (unambiguous paths) with patch sections (same order when produced by the same
 * diff invocation). Files without a matching section get empty hunks.
 */
export function combineDiff(files: readonly FileChange[], sections: readonly PatchSection[]): FileDiff[] {
  const sameOrder =
    files.length === sections.length &&
    files.every((f, i) => {
      const s = sections[i]!;
      const sp = f.status === "D" ? s.oldPath : s.newPath;
      return sp === undefined || sp === f.path;
    });
  if (sameOrder) return files.map((f, i) => sectionToFileDiff(sections[i]!, f));
  const byPath = new Map<string, PatchSection>();
  for (const s of sections) {
    if (s.newPath) byPath.set(s.newPath, s);
    if (s.oldPath && !byPath.has(s.oldPath)) byPath.set(s.oldPath, s);
  }
  return files.map((f) => {
    const s = byPath.get(f.path);
    return s ? sectionToFileDiff(s, f) : { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, binary: !!f.binary, hunks: [] };
  });
}

/** Rebuild a single-hunk patch (for stage/unstage/discard hunk) from a FileDiff. */
export function hunkPatch(file: Pick<FileDiff, "path" | "oldPath" | "status">, hunk: Hunk): string {
  const oldP = file.oldPath ?? file.path;
  const a = file.status === "A" ? "/dev/null" : `a/${oldP}`;
  const b = file.status === "D" ? "/dev/null" : `b/${file.path}`;
  const body = hunk.lines.map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : l.kind === "meta" ? "" : " ") + l.text).join("\n");
  return `diff --git a/${oldP} b/${file.path}\n--- ${a}\n+++ ${b}\n${hunk.header}\n${body}\n`;
}
