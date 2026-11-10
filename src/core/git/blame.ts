// Parser for `git blame --porcelain`.

import type { BlameLine } from "../types.ts";

const HEADER_RE = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;

export function parseBlamePorcelain(out: string): BlameLine[] {
  const lines = out.split("\n");
  const meta = new Map<string, { author: string; date: number }>();
  const result: BlameLine[] = [];
  let curHash = "";
  let curFinal = 0;
  let pendingAuthor: string | null = null;
  let pendingTime: number | null = null;
  for (const line of lines) {
    if (line.startsWith("\t")) {
      if (!meta.has(curHash)) meta.set(curHash, { author: pendingAuthor ?? "", date: pendingTime ?? 0 });
      const m = meta.get(curHash)!;
      result.push({ line: curFinal, hash: curHash, author: m.author, date: m.date, text: line.slice(1) });
      continue;
    }
    const h = HEADER_RE.exec(line);
    if (h) {
      curHash = h[1]!;
      curFinal = Number(h[3]);
      pendingAuthor = null;
      pendingTime = null;
      continue;
    }
    if (line.startsWith("author ")) pendingAuthor = line.slice(7);
    else if (line.startsWith("author-time ")) pendingTime = Number(line.slice(12));
  }
  return result;
}
