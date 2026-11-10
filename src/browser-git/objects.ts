// Git object database reader: loose objects + packfiles (idx v1/v2, OFS/REF deltas).
// SHA-1 only. Objects returned from read() are shared with the cache: callers must not mutate them.

import { inflateSync, unzlibSync } from "fflate";
import { AppError } from "../core/types.ts";
import { hexInto, toHex, isHashPrefix } from "./hex.ts";
import { Lru } from "./lru.ts";
import { joinPath, type DirSource } from "./source.ts";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

const TYPE_BY_CODE: (ObjectType | null)[] = [null, "commit", "tree", "blob", "tag", null, null, null];
const OFS_DELTA = 6;
const REF_DELTA = 7;

export interface ObjectDatabaseOptions {
  /** Memory budget for inflated objects / delta bases. Default 64 MiB. */
  cacheBytes?: number;
  /** Packs larger than this are read by range (File.slice) through a window cache instead of fully. Default 64 MiB. */
  wholePackLimit?: number;
  /** Window size for ranged pack reads. Default 512 KiB. */
  windowBytes?: number;
  /** Memory budget for cached windows of one ranged pack. Default 64 MiB. */
  windowCacheBytes?: number;
}

function corrupt(what: string): AppError {
  return new AppError("INTERNAL", `Corrupt Git object data: ${what}`);
}

// ---------------------------------------------------------------------------
// Pack index
// ---------------------------------------------------------------------------

export class PackIndex {
  readonly count: number;
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private readonly fanout: Uint32Array;
  private readonly version: 1 | 2;
  private readonly shaBase: number;
  private readonly shaStride: number;
  private readonly off32Base: number;
  private readonly off64Base: number;
  private sorted: Float64Array | null = null;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const v2 = buf.length >= 8 && buf[0] === 0xff && buf[1] === 0x74 && buf[2] === 0x4f && buf[3] === 0x63;
    if (v2 && this.view.getUint32(4) !== 2) throw new AppError("UNSUPPORTED", `Unsupported pack index version ${this.view.getUint32(4)}`);
    this.version = v2 ? 2 : 1;
    const fanBase = v2 ? 8 : 0;
    if (buf.length < fanBase + 1024) throw corrupt("pack index too short");
    this.fanout = new Uint32Array(256);
    for (let i = 0; i < 256; i++) this.fanout[i] = this.view.getUint32(fanBase + i * 4);
    this.count = this.fanout[255]!;
    if (v2) {
      this.shaBase = 8 + 1024;
      this.shaStride = 20;
      this.off32Base = this.shaBase + this.count * 24; // sha table + crc table
      this.off64Base = this.off32Base + this.count * 4;
    } else {
      this.shaBase = 1024 + 4;
      this.shaStride = 24;
      this.off32Base = 1024;
      this.off64Base = 0;
    }
  }

  /** Position of the object in the index, or -1. */
  find(sha: Uint8Array): number {
    const first = sha[0]!;
    let lo = first === 0 ? 0 : this.fanout[first - 1]!;
    let hi = this.fanout[first]!;
    const b = this.buf;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const p = this.shaBase + mid * this.shaStride;
      let c = 0;
      for (let i = 1; i < 20; i++) {
        c = b[p + i]! - sha[i]!;
        if (c !== 0) break;
      }
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    return -1;
  }

  hashAt(i: number): string {
    return toHex(this.buf, this.shaBase + i * this.shaStride, 20);
  }

  offsetAt(i: number): number {
    if (this.version === 1) return this.view.getUint32(this.off32Base + i * 24);
    const o = this.view.getUint32(this.off32Base + i * 4);
    if (!(o & 0x80000000)) return o;
    const j = o & 0x7fffffff;
    return this.view.getUint32(this.off64Base + j * 8) * 0x100000000 + this.view.getUint32(this.off64Base + j * 8 + 4);
  }

  /** Hashes starting with a hex prefix (≥ 4 chars). */
  findPrefix(prefix: string, max = 2): string[] {
    const first = parseInt(prefix.slice(0, 2).padEnd(2, "0"), 16);
    const lo = first === 0 ? 0 : this.fanout[first - 1]!;
    const hi = this.fanout[first]!;
    // Binary search for the first hash >= prefix.
    let a = lo;
    let b = hi;
    const padded = prefix.padEnd(40, "0");
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (this.hashAt(mid) < padded) a = mid + 1;
      else b = mid;
    }
    const out: string[] = [];
    for (let i = a; i < hi && out.length < max; i++) {
      const h = this.hashAt(i);
      if (!h.startsWith(prefix)) break;
      out.push(h);
    }
    return out;
  }

  /** End of the entry starting at `offset` (start of the next entry or the pack trailer). */
  entryEnd(offset: number, packSize: number): number {
    if (!this.sorted) {
      const s = new Float64Array(this.count);
      for (let i = 0; i < this.count; i++) s[i] = this.offsetAt(i);
      s.sort();
      this.sorted = s;
    }
    const s = this.sorted;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (s[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo < s.length ? s[lo]! : packSize - 20;
  }
}

// ---------------------------------------------------------------------------
// Pack file
// ---------------------------------------------------------------------------

interface EntryHeader {
  code: number;
  size: number;
  /** Absolute offset of the compressed data. */
  dataStart: number;
  dataEnd: number;
  baseOffset?: number;
  baseHash?: string;
}

class PackFile {
  readonly id: number;
  readonly name: string;
  readonly key: string;
  readonly idx: PackIndex;
  private readonly src: DirSource;
  private readonly path: string;
  private readonly opts: Required<ObjectDatabaseOptions>;
  private whole: Uint8Array | null = null;
  private size = -1;
  private loading: Promise<void> | null = null;
  private readonly windows: Lru<number, Uint8Array>;

  constructor(id: number, name: string, key: string, path: string, idx: PackIndex, src: DirSource, opts: Required<ObjectDatabaseOptions>) {
    this.id = id;
    this.name = name;
    this.key = key;
    this.path = path;
    this.idx = idx;
    this.src = src;
    this.opts = opts;
    this.windows = new Lru(Math.max(opts.windowCacheBytes, 4 * opts.windowBytes), (w) => w.length);
  }

  private ensure(): Promise<void> {
    if (this.size >= 0) return Promise.resolve();
    if (!this.loading) {
      this.loading = (async () => {
        const st = this.src.readRange && this.src.stat ? await this.src.stat(this.path) : null;
        if (st && st.size > this.opts.wholePackLimit) {
          this.size = st.size;
          return;
        }
        const data = await this.src.readFile(this.path);
        if (!data) throw new AppError("NOT_FOUND", `Pack file ${this.name} disappeared`);
        if (data.length < 32 || data[0] !== 0x50 || data[1] !== 0x41 || data[2] !== 0x43 || data[3] !== 0x4b) throw corrupt(`bad pack signature in ${this.name}`);
        this.whole = data;
        this.size = data.length;
      })();
      this.loading.catch(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  /** Bytes [start, end). In ranged mode, small reads are served from cached windows. */
  private async bytes(start: number, end: number): Promise<Uint8Array> {
    await this.ensure();
    if (this.whole) return this.whole.subarray(start, end);
    const w = this.opts.windowBytes;
    const ws = Math.floor(start / w) * w;
    if (end <= ws + w) {
      let win = this.windows.get(ws);
      if (!win) {
        const r = await this.src.readRange!(this.path, ws, Math.min(ws + w, this.size));
        if (!r) throw new AppError("NOT_FOUND", `Pack file ${this.name} disappeared`);
        win = r;
        this.windows.set(ws, win);
      }
      return win.subarray(start - ws, end - ws);
    }
    const r = await this.src.readRange!(this.path, start, end);
    if (!r) throw new AppError("NOT_FOUND", `Pack file ${this.name} disappeared`);
    return r;
  }

  async header(offset: number): Promise<EntryHeader> {
    await this.ensure();
    const end = this.idx.entryEnd(offset, this.size);
    const b = await this.bytes(offset, Math.min(end, offset + 32));
    let i = 0;
    let c = b[i++]!;
    const code = (c >> 4) & 7;
    let size = c & 15;
    let mul = 16;
    while (c & 0x80) {
      c = b[i++]!;
      size += (c & 0x7f) * mul;
      mul *= 128;
    }
    const h: EntryHeader = { code, size, dataStart: 0, dataEnd: end };
    if (code === OFS_DELTA) {
      c = b[i++]!;
      let off = c & 0x7f;
      while (c & 0x80) {
        c = b[i++]!;
        off = (off + 1) * 128 + (c & 0x7f);
      }
      h.baseOffset = offset - off;
    } else if (code === REF_DELTA) {
      h.baseHash = toHex(b, i, 20);
      i += 20;
    }
    h.dataStart = offset + i;
    return h;
  }

  async inflate(h: EntryHeader): Promise<Uint8Array> {
    if (h.size === 0) return new Uint8Array(0);
    const comp = await this.bytes(h.dataStart, h.dataEnd);
    if (comp.length < 2) throw corrupt(`truncated entry in ${this.name}`);
    // Pack entries are zlib streams; skip the 2-byte header and inflate raw DEFLATE into an
    // exactly-sized buffer (the stream is followed by the adler32 and the next entry).
    const out = inflateSync(comp.subarray(2), { out: new Uint8Array(h.size) });
    if (out.length !== h.size) throw corrupt(`size mismatch in ${this.name}`);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let i = 0;
  const varint = () => {
    let v = 0;
    let mul = 1;
    let c: number;
    do {
      c = delta[i++]!;
      v += (c & 0x7f) * mul;
      mul *= 128;
    } while (c & 0x80);
    return v;
  };
  const srcSize = varint();
  if (srcSize !== base.length) throw corrupt("delta base size mismatch");
  const dstSize = varint();
  const out = new Uint8Array(dstSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++]!;
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 0x01) off = delta[i++]!;
      if (op & 0x02) off |= delta[i++]! << 8;
      if (op & 0x04) off |= delta[i++]! << 16;
      if (op & 0x08) off = (off | (delta[i++]! << 24)) >>> 0;
      if (op & 0x10) len = delta[i++]!;
      if (op & 0x20) len |= delta[i++]! << 8;
      if (op & 0x40) len |= delta[i++]! << 16;
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > dstSize) throw corrupt("delta copy out of range");
      out.set(base.subarray(off, off + len), o);
      o += len;
    } else if (op) {
      if (o + op > dstSize || i + op > delta.length) throw corrupt("delta insert out of range");
      out.set(delta.subarray(i, i + op), o);
      i += op;
      o += op;
    } else throw corrupt("delta opcode 0");
  }
  if (o !== dstSize) throw corrupt("delta result size mismatch");
  return out;
}

// ---------------------------------------------------------------------------
// Object database
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

export class ObjectDatabase {
  private readonly src: DirSource;
  private readonly objectDirs: string[];
  private readonly opts: Required<ObjectDatabaseOptions>;
  private packs: PackFile[] = [];
  private packNames = new Set<string>();
  private nextPackId = 0;
  private readonly cache: Lru<string, GitObject>;
  private lastRescan = 0;
  private initialized: Promise<void> | null = null;
  private readonly scratch = new Uint8Array(20);

  constructor(src: DirSource, objectsDir: string, opts: ObjectDatabaseOptions = {}) {
    this.src = src;
    this.objectDirs = [objectsDir];
    this.opts = {
      cacheBytes: opts.cacheBytes ?? 64 * 1024 * 1024,
      wholePackLimit: opts.wholePackLimit ?? 64 * 1024 * 1024,
      windowBytes: opts.windowBytes ?? 512 * 1024,
      windowCacheBytes: opts.windowCacheBytes ?? 64 * 1024 * 1024,
    };
    this.cache = new Lru(this.opts.cacheBytes, (o) => o.data.length + 64);
  }

  init(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.loadAlternates();
        await this.scanPacks();
      })();
      this.initialized.catch(() => {
        this.initialized = null;
      });
    }
    return this.initialized;
  }

  private async loadAlternates(): Promise<void> {
    const text = await this.src.readText(joinPath(this.objectDirs[0]!, "info/alternates")!);
    if (!text) return;
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l || l.startsWith("#")) continue;
      const p = l.startsWith("/") ? null : joinPath(this.objectDirs[0]!, l);
      if (p === null) {
        throw new AppError(
          "UNSUPPORTED",
          "This repository borrows objects from another repository outside the picked folder (objects/info/alternates). Run `git-graph open .` to use the local companion.",
          { alternate: l },
        );
      }
      this.objectDirs.push(p);
    }
  }

  /**
   * Re-lists pack directories: loads indexes of new packs and forgets packs that were deleted
   * (e.g. by `git gc`). Returns true when the pack set changed.
   */
  private async scanPacks(): Promise<boolean> {
    this.lastRescan = Date.now();
    let changed = false;
    const present = new Set<string>();
    for (const dir of this.objectDirs) {
      const packDir = joinPath(dir, "pack")!;
      const entries = (await this.src.list(packDir)) ?? [];
      const names = new Set(entries.map((e) => e.name));
      for (const e of entries) {
        if (e.kind !== "file" || !e.name.endsWith(".idx")) continue;
        const base = e.name.slice(0, -4);
        const key = `${packDir}/${base}`;
        if (!names.has(`${base}.pack`)) continue;
        present.add(key);
        if (this.packNames.has(key)) continue;
        const idxBytes = await this.src.readFile(`${packDir}/${e.name}`);
        if (!idxBytes) continue;
        const idx = new PackIndex(idxBytes);
        this.packs.push(new PackFile(this.nextPackId++, base, key, `${packDir}/${base}.pack`, idx, this.src, this.opts));
        this.packNames.add(key);
        changed = true;
      }
    }
    const before = this.packs.length;
    this.packs = this.packs.filter((p) => present.has(p.key));
    if (this.packs.length !== before) {
      changed = true;
      this.packNames = new Set(this.packs.map((p) => p.key));
    }
    // Larger packs first: they usually hold most objects.
    if (changed) this.packs.sort((a, b) => b.idx.count - a.idx.count);
    return changed;
  }

  /** Call when the repository may have changed on disk (new refs): picks up new / removed packs. */
  async refresh(): Promise<void> {
    await this.init();
    await this.scanPacks();
  }

  get packCount(): number {
    return this.packs.length;
  }

  get cacheBytes(): number {
    return this.cache.bytes;
  }

  /** Reads an object; null when absent. */
  /**
   * `cache: false` skips caching the final object (delta bases along the way are still cached).
   * Used by the history walk, which keeps parsed commits itself.
   */
  async read(hash: string, opts?: { cache?: boolean }): Promise<GitObject | null> {
    await this.init();
    const cache = opts?.cache ?? true;
    let obj: GitObject | null;
    try {
      obj = await this.readUncached(hash, cache);
    } catch (e) {
      // A pack disappeared under us (repack/gc): rescan and retry once.
      if (!(e instanceof AppError && e.code === "NOT_FOUND" && /Pack file/.test(e.message))) throw e;
      await this.scanPacks();
      return this.readUncached(hash, cache);
    }
    if (!obj && Date.now() - this.lastRescan > 1000 && (await this.scanPacks())) obj = await this.readUncached(hash, cache);
    return obj;
  }

  async readType(hash: string, type: ObjectType): Promise<Uint8Array> {
    const o = await this.read(hash);
    if (!o) throw new AppError(type === "commit" ? "COMMIT_NOT_FOUND" : "NOT_FOUND", `Object ${hash} not found`);
    if (o.type !== type) throw new AppError("BAD_REQUEST", `Object ${hash} is a ${o.type}, expected ${type}`);
    return o.data;
  }

  private async readUncached(hash: string, cache: boolean): Promise<GitObject | null> {
    if (!hexInto(hash, this.scratch)) return null;
    for (const p of this.packs) {
      const i = p.idx.find(this.scratch);
      if (i >= 0) return this.readPacked(p, p.idx.offsetAt(i), cache);
    }
    const hit = this.cache.get(hash);
    if (hit) return hit;
    const obj = await this.readLoose(hash);
    if (obj && cache) this.cache.set(hash, obj);
    return obj;
  }

  private async readLoose(hash: string): Promise<GitObject | null> {
    for (const dir of this.objectDirs) {
      const raw = await this.src.readFile(`${dir ? dir + "/" : ""}${hash.slice(0, 2)}/${hash.slice(2)}`);
      if (!raw) continue;
      let data: Uint8Array;
      try {
        data = unzlibSync(raw);
      } catch {
        throw corrupt(`loose object ${hash}`);
      }
      const nul = data.indexOf(0);
      if (nul < 0) throw corrupt(`loose object ${hash} header`);
      const header = decoder.decode(data.subarray(0, nul));
      const sp = header.indexOf(" ");
      const type = header.slice(0, sp) as ObjectType;
      if (!["commit", "tree", "blob", "tag"].includes(type)) throw corrupt(`loose object ${hash} type ${type}`);
      return { type, data: data.subarray(nul + 1) };
    }
    return null;
  }

  private async readPacked(pack: PackFile, offset: number, cacheResult = true): Promise<GitObject> {
    // Walk the delta chain down to a cached object or a full object, then apply deltas back up.
    const chain: EntryHeader[] = [];
    const chainOffsets: number[] = [];
    let cur = offset;
    let base: GitObject | null = null;
    for (let guard = 0; guard < 10000; guard++) {
      const key = `${pack.id}@${cur}`;
      const hit = this.cache.get(key);
      if (hit) {
        base = hit;
        break;
      }
      const h = await pack.header(cur);
      if (h.code === OFS_DELTA) {
        chain.push(h);
        chainOffsets.push(cur);
        cur = h.baseOffset!;
        continue;
      }
      if (h.code === REF_DELTA) {
        chain.push(h);
        chainOffsets.push(cur);
        hexInto(h.baseHash!, this.scratch);
        const i = pack.idx.find(this.scratch);
        if (i >= 0) {
          cur = pack.idx.offsetAt(i);
          continue;
        }
        base = await this.read(h.baseHash!);
        if (!base) throw new AppError("NOT_FOUND", `Delta base ${h.baseHash} not found`);
        break;
      }
      const type = TYPE_BY_CODE[h.code];
      if (!type) throw corrupt(`unknown pack entry type ${h.code} in ${pack.name}`);
      base = { type, data: await pack.inflate(h) };
      if (chain.length || cacheResult) this.cache.set(key, base);
      break;
    }
    if (!base) throw corrupt(`delta chain too long in ${pack.name}`);
    for (let k = chain.length - 1; k >= 0; k--) {
      const delta = await pack.inflate(chain[k]!);
      base = { type: base.type, data: applyDelta(base.data, delta) };
      // Cache every level: intermediate results are the bases of sibling deltas.
      if (k > 0 || cacheResult) this.cache.set(`${pack.id}@${chainOffsets[k]}`, base);
    }
    return base;
  }

  /** Full hashes matching an abbreviated hash (up to `max`). */
  async resolvePrefix(prefix: string, max = 2): Promise<string[]> {
    await this.init();
    prefix = prefix.toLowerCase();
    if (!isHashPrefix(prefix)) return [];
    const out = new Set<string>();
    for (const p of this.packs) for (const h of p.idx.findPrefix(prefix, max)) out.add(h);
    for (const dir of this.objectDirs) {
      const entries = await this.src.list(`${dir ? dir + "/" : ""}${prefix.slice(0, 2)}`);
      for (const e of entries ?? []) {
        const h = prefix.slice(0, 2) + e.name;
        if (h.length === 40 && h.startsWith(prefix)) out.add(h);
      }
    }
    return [...out].sort().slice(0, max);
  }
}
