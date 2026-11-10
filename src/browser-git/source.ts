// Read-only access to a directory tree. Paths are "/"-separated and relative to the picked
// directory ("" is the root). Implementations must never throw for a missing path: they return null.
// Runs in a Web Worker: no Node APIs here.

import { AppError } from "../core/types.ts";

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

export interface DirSource {
  readFile(path: string): Promise<Uint8Array | null>;
  readText(path: string): Promise<string | null>;
  list(dir: string): Promise<DirEntry[] | null>;
  stat?(path: string): Promise<{ size: number; mtime?: number } | null>;
  /** Bytes [start, end) of a file. Lets the pack reader avoid loading huge packs into memory. */
  readRange?(path: string, start: number, end: number): Promise<Uint8Array | null>;
}

/** Joins a base path and a relative path. Returns null when the result escapes the root. */
export function joinPath(base: string, rel: string): string | null {
  if (rel.startsWith("/")) return null;
  const out: string[] = base ? base.split("/").filter(Boolean) : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

const decoder = new TextDecoder();

// Minimal structural types so we do not depend on DOM lib versions shipping async iterators.
interface DirHandleLike {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string): Promise<DirHandleLike>;
  getFileHandle(name: string): Promise<FileHandleLike>;
  values(): AsyncIterable<{ kind: "file" | "directory"; name: string }>;
}
interface FileHandleLike {
  readonly kind: "file";
  getFile(): Promise<File>;
}

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "NotFoundError" || name === "TypeMismatchError" || name === "TypeError";
}

/** DirSource over a File System Access API directory handle. */
export class FsAccessSource implements DirSource {
  private readonly root: DirHandleLike;
  private readonly dirs = new Map<string, Promise<DirHandleLike | null>>();
  private readonly files = new Map<string, File>();

  constructor(handle: FileSystemDirectoryHandle) {
    this.root = handle as unknown as DirHandleLike;
  }

  private dir(path: string): Promise<DirHandleLike | null> {
    if (!path) return Promise.resolve(this.root);
    let p = this.dirs.get(path);
    if (!p) {
      const i = path.lastIndexOf("/");
      const parent = i < 0 ? "" : path.slice(0, i);
      const name = path.slice(i + 1);
      p = this.dir(parent).then(async (d) => {
        if (!d) return null;
        try {
          return await d.getDirectoryHandle(name);
        } catch (e) {
          if (isNotFound(e)) return null;
          throw permissionError(e);
        }
      });
      this.dirs.set(path, p);
      // Negative results are not cached: directories appear (e.g. refs/heads/feature/).
      p.then(
        (r) => {
          if (!r) this.dirs.delete(path);
        },
        () => this.dirs.delete(path),
      );
    }
    return p;
  }

  private async file(path: string, fresh: boolean): Promise<File | null> {
    if (!fresh) {
      const f = this.files.get(path);
      if (f) return f;
    }
    const i = path.lastIndexOf("/");
    const d = await this.dir(i < 0 ? "" : path.slice(0, i));
    if (!d) return null;
    try {
      const fh = await d.getFileHandle(path.slice(i + 1));
      return await fh.getFile();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw permissionError(e);
    }
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const f = await this.file(path, true);
    if (!f) return null;
    try {
      return new Uint8Array(await f.arrayBuffer());
    } catch (e) {
      if (isNotFound(e) || (e as { name?: string }).name === "NotReadableError") return null;
      throw e;
    }
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readFile(path);
    return b ? decoder.decode(b) : null;
  }

  async list(dir: string): Promise<DirEntry[] | null> {
    const d = await this.dir(dir);
    if (!d) return null;
    const out: DirEntry[] = [];
    try {
      for await (const h of d.values()) out.push({ name: h.name, kind: h.kind });
    } catch (e) {
      if (isNotFound(e)) {
        this.dirs.delete(dir);
        return null;
      }
      throw permissionError(e);
    }
    return out;
  }

  async stat(path: string): Promise<{ size: number; mtime?: number } | null> {
    const f = await this.file(path, true);
    if (!f) return null;
    this.files.set(path, f);
    return { size: f.size, mtime: f.lastModified };
  }

  /** Uses File.slice so huge pack files are never fully loaded. Pack files are immutable, so the File is cached. */
  async readRange(path: string, start: number, end: number): Promise<Uint8Array | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const f = await this.file(path, attempt > 0);
      if (!f) return null;
      this.files.set(path, f);
      try {
        return new Uint8Array(await f.slice(start, end).arrayBuffer());
      } catch (e) {
        this.files.delete(path);
        if (attempt > 0) {
          if (isNotFound(e) || (e as { name?: string }).name === "NotReadableError") return null;
          throw e;
        }
      }
    }
    return null;
  }
}

function permissionError(e: unknown): unknown {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new AppError("FORBIDDEN", "Browser file access permission was revoked. Re-open the folder to grant access again.");
  }
  return e;
}
