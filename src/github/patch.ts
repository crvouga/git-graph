// Parse GitHub's per-file `patch` strings (unified diff hunks without file headers) into hunks.

import type { DiffLine, FileChange, FileDiff, FileStatus, Hunk } from "../core/types.ts";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.split("\n");
  // A trailing newline produces an empty last element that is not a diff line.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const m = HUNK_RE.exec(line);
    if (m) {
      cur = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const ch = line[0];
    const text = line.slice(1);
    let dl: DiffLine;
    if (ch === "+") dl = { kind: "add", text, newNo: newNo++ };
    else if (ch === "-") dl = { kind: "del", text, oldNo: oldNo++ };
    else if (ch === "\\") dl = { kind: "meta", text: line };
    else dl = { kind: "context", text: ch === " " ? text : line, oldNo: oldNo++, newNo: newNo++ };
    cur.lines.push(dl);
  }
  return hunks;
}

export interface GhFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  sha?: string;
}

export function mapStatus(s: GhFile["status"]): FileStatus {
  switch (s) {
    case "added":
      return "A";
    case "removed":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "changed":
      return "T";
    default:
      return "M";
  }
}

/** GitHub omits `patch` for binary files (no line changes) and for diffs over its size limit. */
function classify(f: GhFile): { binary: boolean; truncated: boolean } {
  if (f.patch !== undefined) return { binary: false, truncated: false };
  const changes = f.changes ?? (f.additions ?? 0) + (f.deletions ?? 0);
  if (changes > 0) return { binary: false, truncated: true };
  // No patch and no line changes: binary — except a rename/copy without content change, which
  // GitHub reports identically (we cannot tell those apart without fetching the blobs).
  return { binary: f.status !== "renamed" && f.status !== "copied", truncated: false };
}

export function toFileChange(f: GhFile): FileChange {
  const { binary } = classify(f);
  return {
    path: f.filename,
    ...(f.previous_filename ? { oldPath: f.previous_filename } : {}),
    status: mapStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    ...(binary ? { binary: true } : {}),
  };
}

export function toFileDiff(f: GhFile): FileDiff {
  const { binary, truncated } = classify(f);
  return {
    path: f.filename,
    ...(f.previous_filename ? { oldPath: f.previous_filename } : {}),
    status: mapStatus(f.status),
    binary,
    hunks: f.patch ? parsePatch(f.patch) : [],
    ...(truncated ? { truncated: true } : {}),
  };
}
