// Node implementation of DirSource for tests (the browser uses FsAccessSource).

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DirEntry, DirSource } from "../../src/browser-git/source.ts";

export interface NodeSourceStats {
  readFile: number;
  readRange: number;
  bytes: number;
}

export class NodeDirSource implements DirSource {
  readonly root: string;
  readonly stats: NodeSourceStats = { readFile: 0, readRange: 0, bytes: 0 };
  private readonly ranged: boolean;

  constructor(root: string, opts: { ranged?: boolean } = { ranged: true }) {
    this.root = root;
    this.ranged = opts.ranged ?? true;
    if (!this.ranged) {
      // Simulate a source without range reads.
      (this as { readRange?: unknown }).readRange = undefined;
    }
  }

  private abs(p: string) {
    return p ? join(this.root, p) : this.root;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    try {
      const b = await readFile(this.abs(path));
      this.stats.readFile++;
      this.stats.bytes += b.length;
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
      throw e;
    }
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readFile(path);
    return b ? new TextDecoder().decode(b) : null;
  }

  async list(dir: string): Promise<DirEntry[] | null> {
    try {
      const entries = await readdir(this.abs(dir), { withFileTypes: true });
      return entries.filter((e) => e.isFile() || e.isDirectory()).map((e) => ({ name: e.name, kind: e.isDirectory() ? "directory" : "file" }));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw e;
    }
  }

  async stat(path: string): Promise<{ size: number; mtime?: number } | null> {
    try {
      const s = await stat(this.abs(path));
      return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  async readRange(path: string, start: number, end: number): Promise<Uint8Array | null> {
    let fh;
    try {
      fh = await open(this.abs(path), "r");
    } catch {
      return null;
    }
    try {
      const buf = new Uint8Array(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      this.stats.readRange++;
      this.stats.bytes += bytesRead;
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }
}
