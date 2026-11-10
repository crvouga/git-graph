// Incremental parser for `git log -z --format=<LOG_FORMAT>` output.
// Every field is NUL-terminated (8 %x00 separators + the -z record terminator), so the stream is a
// flat sequence of NUL-terminated tokens, LOG_FIELDS per commit. Works on byte chunks so a 100k-commit
// stream can be parsed while it arrives without ever buffering the whole output.

import type { Commit } from "../types.ts";

export const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s";
export const LOG_FIELDS = 9;

/** Interns repeated strings (author names / emails) to keep large histories compact. */
class Interner {
  private readonly m = new Map<string, string>();
  get(s: string): string {
    const hit = this.m.get(s);
    if (hit !== undefined) return hit;
    if (this.m.size < 50_000) this.m.set(s, s);
    return s;
  }
}

export function commitFromFields(f: readonly string[], intern?: (s: string) => string): Commit {
  const i = intern ?? ((s: string) => s);
  return {
    hash: f[0]!,
    parents: f[1] ? f[1].split(" ") : [],
    author: { name: i(f[2]!), email: i(f[3]!), date: Number(f[4]) || 0 },
    committer: { name: i(f[5]!), email: i(f[6]!), date: Number(f[7]) || 0 },
    subject: f[8] ?? "",
  };
}

export class LogStreamParser {
  private pending: Uint8Array[] = [];
  private fields: string[] = [];
  private readonly decoder = new TextDecoder();
  private readonly interner = new Interner();
  private readonly fieldCount: number;

  constructor(fieldCount = LOG_FIELDS) {
    this.fieldCount = fieldCount;
  }

  /** Feed a chunk; returns the commits completed by it. */
  push(chunk: Uint8Array): Commit[] {
    const out: Commit[] = [];
    let start = 0;
    for (;;) {
      const nul = chunk.indexOf(0, start);
      if (nul < 0) break;
      let token: string;
      if (this.pending.length) {
        this.pending.push(chunk.subarray(start, nul));
        token = this.decoder.decode(concat(this.pending));
        this.pending = [];
      } else {
        token = this.decoder.decode(chunk.subarray(start, nul));
      }
      // git separates -z records without a newline, but tolerate a stray leading "\n".
      if (this.fields.length === 0 && token.charCodeAt(0) === 10) token = token.slice(1);
      this.fields.push(token);
      if (this.fields.length === this.fieldCount) {
        out.push(commitFromFields(this.fields, (s) => this.interner.get(s)));
        this.fields = [];
      }
      start = nul + 1;
    }
    if (start < chunk.length) this.pending.push(chunk.slice(start));
    return out;
  }

  /** True when no partial record is buffered. */
  get clean(): boolean {
    return this.fields.length === 0 && this.pending.every((p) => p.length === 0 || (p.length === 1 && p[0] === 10));
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Parse a complete `git log -z --format=LOG_FORMAT` string. */
export function parseLog(s: string): Commit[] {
  const p = new LogStreamParser();
  return p.push(new TextEncoder().encode(s));
}
