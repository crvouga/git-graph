// Recursive tree diff + git-style rename detection (exact by blob id, inexact by span similarity).

import type { FileStatus } from "../core/types.ts";
import { AppError } from "../core/types.ts";
import type { ObjectDatabase } from "./objects.ts";
import { isTreeMode, parseTree, type TreeEntry } from "./parse.ts";
import { isBinary } from "./myers.ts";

export interface RawChange {
  status: FileStatus;
  path: string;
  oldPath?: string;
  oldHash?: string;
  newHash?: string;
  oldMode?: string;
  newMode?: string;
  /** Rename similarity 0-100. */
  score?: number;
}

export async function readTreeEntries(odb: ObjectDatabase, hash: string): Promise<TreeEntry[]> {
  const o = await odb.read(hash);
  if (!o) throw new AppError("NOT_FOUND", `Tree ${hash} not found`);
  if (o.type !== "tree") throw new AppError("BAD_REQUEST", `Object ${hash} is not a tree`);
  return parseTree(o.data);
}

const kindOf = (mode: string) => mode.slice(0, 3); // "100" file, "120" symlink, "160" gitlink, "040" tree

export async function diffTrees(odb: ObjectDatabase, oldTree: string | null, newTree: string | null): Promise<RawChange[]> {
  const out: RawChange[] = [];
  await walk(odb, oldTree, newTree, "", out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function walk(odb: ObjectDatabase, oldTree: string | null, newTree: string | null, prefix: string, out: RawChange[]): Promise<void> {
  if (oldTree === newTree) return;
  const [oldEntries, newEntries] = await Promise.all([oldTree ? readTreeEntries(odb, oldTree) : [], newTree ? readTreeEntries(odb, newTree) : []]);
  const oldMap = new Map(oldEntries.map((e) => [e.name, e]));
  const subs: Promise<void>[] = [];
  for (const n of newEntries) {
    const o = oldMap.get(n.name);
    oldMap.delete(n.name);
    const path = prefix + n.name;
    const nTree = isTreeMode(n.mode);
    if (!o) {
      if (nTree) subs.push(walk(odb, null, n.hash, path + "/", out));
      else out.push({ status: "A", path, newHash: n.hash, newMode: n.mode });
      continue;
    }
    if (o.hash === n.hash && o.mode === n.mode) continue;
    const oTree = isTreeMode(o.mode);
    if (oTree && nTree) subs.push(walk(odb, o.hash, n.hash, path + "/", out));
    else if (oTree) {
      subs.push(walk(odb, o.hash, null, path + "/", out));
      out.push({ status: "A", path, newHash: n.hash, newMode: n.mode });
    } else if (nTree) {
      out.push({ status: "D", path, oldHash: o.hash, oldMode: o.mode });
      subs.push(walk(odb, null, n.hash, path + "/", out));
    } else {
      out.push({ status: kindOf(o.mode) === kindOf(n.mode) ? "M" : "T", path, oldHash: o.hash, newHash: n.hash, oldMode: o.mode, newMode: n.mode });
    }
  }
  for (const o of oldMap.values()) {
    const path = prefix + o.name;
    if (isTreeMode(o.mode)) subs.push(walk(odb, o.hash, null, path + "/", out));
    else out.push({ status: "D", path, oldHash: o.hash, oldMode: o.mode });
  }
  await Promise.all(subs);
}

// ---------------------------------------------------------------------------
// Rename detection
// ---------------------------------------------------------------------------

const MAX_SCORE = 60000;
const MIN_SCORE = 30000; // 50%
const HASHBASE = 107927;

/** Port of git's diffcore-delta span hashing: chunk → byte count. */
function spanHash(buf: Uint8Array, text: boolean): Map<number, number> {
  const out = new Map<number, number>();
  let n = 0;
  let a1 = 0;
  let a2 = 0;
  const add = () => {
    const h = ((a1 >>> 0) + Math.imul(a2 >>> 0, 9)) >>> 0;
    const key = h % HASHBASE;
    out.set(key, (out.get(key) ?? 0) + n);
  };
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (text && c === 13 && i + 1 < buf.length && buf[i + 1] === 10) continue;
    const old1 = a1;
    a1 = ((a1 << 7) ^ (a2 >>> 25)) >>> 0;
    a2 = ((a2 << 7) ^ (old1 >>> 25)) >>> 0;
    a1 = (a1 + c) >>> 0;
    if (++n < 64 && c !== 10) continue;
    add();
    n = 0;
    a1 = 0;
    a2 = 0;
  }
  if (n > 0) add();
  return out;
}

function similarity(src: { size: number; spans: Map<number, number> }, dst: { size: number; spans: Map<number, number> }): number {
  const maxSize = Math.max(src.size, dst.size);
  const delta = maxSize - Math.min(src.size, dst.size);
  if (maxSize * (MAX_SCORE - MIN_SCORE) < delta * MAX_SCORE) return 0;
  if (!dst.size) return 0;
  let copied = 0;
  for (const [h, dc] of dst.spans) {
    const sc = src.spans.get(h);
    if (sc) copied += Math.min(sc, dc);
  }
  return Math.floor((copied * MAX_SCORE) / maxSize);
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export interface RenameOptions {
  /** Max deletes × adds pairs examined for inexact renames. Default 100×100. */
  maxPairs?: number;
  /** Larger blobs are skipped for inexact renames. Default 1 MiB. */
  maxBlobSize?: number;
}

export async function detectRenames(odb: ObjectDatabase, changes: RawChange[], opts: RenameOptions = {}): Promise<RawChange[]> {
  const isFile = (m?: string) => !!m && (kindOf(m) === "100" || kindOf(m) === "120");
  const dels = changes.filter((c) => c.status === "D" && isFile(c.oldMode));
  const adds = changes.filter((c) => c.status === "A" && isFile(c.newMode));
  if (!dels.length || !adds.length) return changes;
  const used = new Set<RawChange>();
  const pairs = new Map<RawChange, { src: RawChange; score: number }>(); // add → del

  // Exact renames: identical blob id; prefer a source with the same basename.
  const byHash = new Map<string, RawChange[]>();
  for (const d of dels) {
    const arr = byHash.get(d.oldHash!) ?? [];
    arr.push(d);
    byHash.set(d.oldHash!, arr);
  }
  for (const a of adds) {
    const cands = (byHash.get(a.newHash!) ?? []).filter((d) => !used.has(d) && kindOf(d.oldMode!) === kindOf(a.newMode!));
    if (!cands.length) continue;
    const src = cands.find((d) => basename(d.path) === basename(a.path)) ?? cands[0]!;
    used.add(src);
    pairs.set(a, { src, score: 100 });
  }

  // Inexact renames for regular files.
  const restDels = dels.filter((d) => !used.has(d) && kindOf(d.oldMode!) === "100");
  const restAdds = adds.filter((a) => !pairs.has(a) && kindOf(a.newMode!) === "100");
  const maxPairs = opts.maxPairs ?? 100 * 100;
  const maxBlob = opts.maxBlobSize ?? 1024 * 1024;
  if (restDels.length && restAdds.length && restDels.length * restAdds.length <= maxPairs) {
    const load = async (hash: string) => {
      const o = await odb.read(hash);
      if (!o || o.data.length > maxBlob) return null;
      return { size: o.data.length, spans: spanHash(o.data, !isBinary(o.data)) };
    };
    const srcs = await Promise.all(restDels.map((d) => load(d.oldHash!)));
    const dsts = await Promise.all(restAdds.map((a) => load(a.newHash!)));
    const cands: { di: number; ai: number; score: number; nameScore: number }[] = [];
    for (let ai = 0; ai < restAdds.length; ai++) {
      const dst = dsts[ai];
      if (!dst) continue;
      for (let di = 0; di < restDels.length; di++) {
        const src = srcs[di];
        if (!src) continue;
        const score = similarity(src, dst);
        if (score >= MIN_SCORE) cands.push({ di, ai, score, nameScore: basename(restDels[di]!.path) === basename(restAdds[ai]!.path) ? 1 : 0 });
      }
    }
    cands.sort((x, y) => y.score - x.score || y.nameScore - x.nameScore);
    for (const c of cands) {
      const a = restAdds[c.ai]!;
      const d = restDels[c.di]!;
      if (pairs.has(a) || used.has(d)) continue;
      used.add(d);
      pairs.set(a, { src: d, score: Math.floor((c.score * 100) / MAX_SCORE) });
    }
  }

  if (!pairs.size) return changes;
  const out: RawChange[] = [];
  for (const c of changes) {
    if (used.has(c)) continue;
    const p = pairs.get(c);
    if (p) out.push({ status: "R", path: c.path, oldPath: p.src.path, oldHash: p.src.oldHash, newHash: c.newHash, oldMode: p.src.oldMode, newMode: c.newMode, score: p.score });
    else out.push(c);
  }
  return out;
}
