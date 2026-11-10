// Line diff (Myers' O(ND) algorithm, linear-space bisection) and unified hunk construction.

import type { DiffLine, Hunk } from "../core/types.ts";

/**
 * Computes change flags: `ra[i]` is true when old line i is deleted, `rb[j]` when new line j is added.
 * `budget` bounds the work (inner-loop steps); regions left when it runs out are marked fully changed.
 */
export function diffChanges(a: Int32Array, b: Int32Array, budget = 50_000_000): { ra: Uint8Array; rb: Uint8Array } {
  const ra = new Uint8Array(a.length);
  const rb = new Uint8Array(b.length);
  const state = { budget };
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length) {
    let [aLo, aHi, bLo, bHi] = stack.pop()!;
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      aLo++;
      bLo++;
    }
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      aHi--;
      bHi--;
    }
    if (aLo === aHi || bLo === bHi) {
      ra.fill(1, aLo, aHi);
      rb.fill(1, bLo, bHi);
      continue;
    }
    const split = state.budget > 0 ? bisect(a, aLo, aHi, b, bLo, bHi, state) : null;
    if (!split) {
      ra.fill(1, aLo, aHi);
      rb.fill(1, bLo, bHi);
      continue;
    }
    const [x, y] = split;
    // Push the second half first so the first half is processed first (order does not matter for flags).
    stack.push([aLo + x, aHi, bLo + y, bHi]);
    stack.push([aLo, aLo + x, bLo, bLo + y]);
  }
  return { ra, rb };
}

/** Finds the middle snake; returns the split point relative to (aLo, bLo), or null when nothing is common. */
function bisect(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number, state: { budget: number }): [number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const len = 2 * maxD + 2;
  const v1 = new Int32Array(len).fill(-1);
  const v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = (delta & 1) !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    if (state.budget <= 0) return null;
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = off + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1o - 1]! < v1[k1o + 1]!) ? v1[k1o + 1]! : v1[k1o - 1]! + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      state.budget -= 1 + d;
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < len && v2[k2o] !== -1) {
          const x2 = n - v2[k2o]!;
          if (x1 >= x2) return [x1, y1];
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = off + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2o - 1]! < v2[k2o + 1]!) ? v2[k2o + 1]! : v2[k2o - 1]! + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
          const x1 = v1[k1o]!;
          const y1 = off + x1 - k1o;
          if (x1 >= n - x2) return [x1, y1];
        }
      }
    }
  }
  return null;
}

/**
 * Port of xdiff's xdl_change_compact (without the indent heuristic): slides each change group up
 * and down to merge with neighbours, then places it as low as possible unless it can be aligned with
 * a change group in the other file.
 */
export function compactChanges(a: Int32Array, ra: Uint8Array, b: Int32Array, rb: Uint8Array): void {
  compactSide(a, ra, rb);
  compactSide(b, rb, ra);
}

interface Group {
  start: number;
  end: number;
}

function compactSide(recs: Int32Array, rchg: Uint8Array, ochg: Uint8Array): void {
  const n = rchg.length;
  const on = ochg.length;
  const g: Group = { start: 0, end: 0 };
  const go: Group = { start: 0, end: 0 };
  while (rchg[g.end]) g.end++;
  while (ochg[go.end]) go.end++;
  const next = (chg: Uint8Array, len: number, grp: Group): boolean => {
    if (grp.end === len) return false;
    grp.start = grp.end + 1;
    grp.end = grp.start;
    while (chg[grp.end]) grp.end++;
    return true;
  };
  const previous = (chg: Uint8Array, grp: Group): boolean => {
    if (grp.start === 0) return false;
    grp.end = grp.start - 1;
    grp.start = grp.end;
    while (grp.start > 0 && chg[grp.start - 1]) grp.start--;
    return true;
  };
  const slideDown = (): boolean => {
    if (g.end < n && recs[g.start] === recs[g.end]) {
      rchg[g.start++] = 0;
      rchg[g.end++] = 1;
      while (rchg[g.end]) g.end++;
      return true;
    }
    return false;
  };
  const slideUp = (): boolean => {
    if (g.start > 0 && recs[g.start - 1] === recs[g.end - 1]) {
      rchg[--g.start] = 1;
      rchg[--g.end] = 0;
      while (g.start > 0 && rchg[g.start - 1]) g.start--;
      return true;
    }
    return false;
  };
  for (;;) {
    if (g.end !== g.start) {
      let groupSize: number;
      let earliestEnd: number;
      let endMatchingOther: number;
      do {
        groupSize = g.end - g.start;
        endMatchingOther = -1;
        while (slideUp()) previous(ochg, go);
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        while (slideDown()) {
          next(ochg, on, go);
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupSize !== g.end - g.start);
      if (g.end !== earliestEnd && endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!slideUp()) break;
          previous(ochg, go);
        }
      }
    }
    if (!next(rchg, n, g)) break;
    if (!next(ochg, on, go)) break;
  }
}

export interface LineFile {
  lines: string[];
  /** The final line has no trailing newline. */
  noEol: boolean;
}

const utf8 = new TextDecoder();
const enc = new TextEncoder();

export function splitLines(data: Uint8Array): LineFile {
  if (!data.length) return { lines: [], noEol: false };
  const text = utf8.decode(data);
  const lines = text.split("\n");
  const noEol = lines[lines.length - 1] !== "";
  if (!noEol) lines.pop();
  return { lines, noEol };
}

export function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

/** Interns lines of both files into integer ids (last line without newline differs from one with). */
export function intern(oldF: LineFile, newF: LineFile): { a: Int32Array; b: Int32Array } {
  const ids = new Map<string, number>();
  const map = (f: LineFile) => {
    const out = new Int32Array(f.lines.length);
    for (let i = 0; i < f.lines.length; i++) {
      const key = f.noEol && i === f.lines.length - 1 ? f.lines[i]! + "\u0000\u0001" : f.lines[i]!;
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  };
  return { a: map(oldF), b: map(newF) };
}

/** Git's default hunk-header function line: starts with a letter, '_' or '$'; at most 80 bytes. */
function funcLine(lines: string[], from: number): string {
  for (let i = from; i >= 0; i--) {
    const l = lines[i]!;
    const c = l.charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
      let s = l;
      if (enc.encode(s).length > 80) {
        const bytes = enc.encode(s).subarray(0, 80);
        s = utf8.decode(bytes).replace(/�$/, "");
      }
      return s.replace(/\s+$/, "");
    }
  }
  return "";
}

export interface LineDiffResult {
  hunks: Hunk[];
  additions: number;
  deletions: number;
  /** Hunk output was cut at `maxLines`. */
  truncated: boolean;
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

/** Full text diff of two files producing unified hunks. */
export function lineDiff(oldF: LineFile, newF: LineFile, context = 3, maxLines = Infinity): LineDiffResult {
  const { a, b } = intern(oldF, newF);
  const { ra, rb } = diffChanges(a, b);
  compactChanges(a, ra, b, rb);
  return buildHunks(oldF, newF, ra, rb, context, maxLines);
}

export function countChanges(oldF: LineFile, newF: LineFile): { additions: number; deletions: number } {
  const { a, b } = intern(oldF, newF);
  const { ra, rb } = diffChanges(a, b, 5_000_000);
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < ra.length; i++) deletions += ra[i]!;
  for (let i = 0; i < rb.length; i++) additions += rb[i]!;
  return { additions, deletions };
}

export function buildHunks(oldF: LineFile, newF: LineFile, ra: Uint8Array, rb: Uint8Array, context: number, maxLines: number): LineDiffResult {
  const N = ra.length;
  const M = rb.length;
  // Edit script: kind 0 = context, 1 = del, 2 = add; with old/new indices.
  const kinds: number[] = [];
  const oi: number[] = [];
  const ni: number[] = [];
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < N || j < M) {
    if (i < N && ra[i]) {
      kinds.push(1);
      oi.push(i++);
      ni.push(j);
      deletions++;
    } else if (j < M && rb[j]) {
      kinds.push(2);
      oi.push(i);
      ni.push(j++);
      additions++;
    } else {
      kinds.push(0);
      oi.push(i++);
      ni.push(j++);
    }
  }
  const hunks: Hunk[] = [];
  let truncated = false;
  let emitted = 0;
  let e = 0;
  const L = kinds.length;
  while (e < L) {
    while (e < L && kinds[e] === 0) e++;
    if (e >= L) break;
    const start = Math.max(0, e - context);
    // Extend through changes whose gap of context lines is <= 2 * context.
    let last = e;
    let k = e;
    while (k < L) {
      if (kinds[k] !== 0) {
        last = k;
        k++;
        continue;
      }
      let g = k;
      while (g < L && kinds[g] === 0) g++;
      if (g >= L || g - k > 2 * context) break;
      k = g;
    }
    const end = Math.min(L, last + 1 + context);
    const lines: DiffLine[] = [];
    let oldLines = 0;
    let newLines = 0;
    for (let x = start; x < end; x++) {
      const kind = kinds[x]!;
      if (kind === 0) {
        lines.push({ kind: "context", text: oldF.lines[oi[x]!]!, oldNo: oi[x]! + 1, newNo: ni[x]! + 1 });
        oldLines++;
        newLines++;
        if (oi[x] === N - 1 && oldF.noEol && ni[x] === M - 1 && newF.noEol) lines.push({ kind: "meta", text: "\\ No newline at end of file" });
      } else if (kind === 1) {
        lines.push({ kind: "del", text: oldF.lines[oi[x]!]!, oldNo: oi[x]! + 1 });
        oldLines++;
        if (oi[x] === N - 1 && oldF.noEol) lines.push({ kind: "meta", text: "\\ No newline at end of file" });
      } else {
        lines.push({ kind: "add", text: newF.lines[ni[x]!]!, newNo: ni[x]! + 1 });
        newLines++;
        if (ni[x] === M - 1 && newF.noEol) lines.push({ kind: "meta", text: "\\ No newline at end of file" });
      }
    }
    const oldStartIdx = oi[start]!;
    const newStartIdx = ni[start]!;
    const oldStart = oldLines ? oldStartIdx + 1 : oldStartIdx;
    const newStart = newLines ? newStartIdx + 1 : newStartIdx;
    const func = funcLine(oldF.lines, oldStartIdx - 1);
    hunks.push({
      header: `@@ -${range(oldStart, oldLines)} +${range(newStart, newLines)} @@${func ? " " + func : ""}`,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    });
    emitted += lines.length;
    e = end;
    if (emitted > maxLines) {
      truncated = e < L && kinds.slice(e).some((x) => x !== 0);
      break;
    }
  }
  return { hunks, additions, deletions, truncated };
}

/** Applies hunks to old lines (used by tests to verify diff correctness). */
export function applyHunks(oldLines: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let pos = 0; // next old index to copy
  for (const h of hunks) {
    const startIdx = h.oldLines ? h.oldStart - 1 : h.oldStart;
    while (pos < startIdx) out.push(oldLines[pos++]!);
    for (const l of h.lines) {
      if (l.kind === "context") {
        out.push(oldLines[pos++]!);
      } else if (l.kind === "del") pos++;
      else if (l.kind === "add") out.push(l.text);
    }
  }
  while (pos < oldLines.length) out.push(oldLines[pos++]!);
  return out;
}
