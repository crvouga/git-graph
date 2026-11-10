// Hex <-> bytes helpers and a tiny deterministic string hash. Hot paths: keep allocation-free.

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function toHex(b: Uint8Array, off = 0, len = 20): string {
  let s = "";
  for (let i = 0; i < len; i++) s += HEX[b[off + i]!];
  return s;
}

function nibble(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/** Parses 40 hex chars into `out` (20 bytes). Returns false for invalid input. */
export function hexInto(hex: string, out: Uint8Array): boolean {
  if (hex.length !== 40) return false;
  for (let i = 0; i < 20; i++) {
    const hi = nibble(hex.charCodeAt(i * 2));
    const lo = nibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return false;
    out[i] = (hi << 4) | lo;
  }
  return true;
}

export const isFullHash = (s: string): boolean => /^[0-9a-f]{40}$/.test(s);
export const isHashPrefix = (s: string): boolean => /^[0-9a-f]{4,40}$/.test(s);

/** 64-bit FNV-1a over UTF-16 code units, as 16 hex chars. Deterministic across runtimes. */
export function digest(s: string): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x050c5d1f | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
