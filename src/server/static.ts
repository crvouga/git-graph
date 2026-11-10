// Static hosting of the built SPA with SPA fallback, immutable caching of hashed assets and
// cached brotli/gzip compression of text assets.

import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { brotliCompressSync, gzipSync, constants as zc } from "node:zlib";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".webmanifest", ".txt", ".wasm"]);
/** Vite-style content hashes: name-[hash].ext with 8+ base64url chars. */
const HASHED = /[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

interface FileEntry {
  body: Uint8Array;
  br?: Uint8Array;
  gz?: Uint8Array;
  mtimeMs: number;
  type: string;
}

export const NON_SPA_PREFIXES = ["/api/", "/auth/", "/webhooks/", "/health"];

export class StaticSite {
  readonly dir: string;
  private readonly cache = new Map<string, FileEntry | null>();
  private readonly maxCacheBytes = 64 * 1024 * 1024;
  private bytes = 0;

  constructor(dir: string) {
    this.dir = normalize(dir);
  }

  private load(rel: string): FileEntry | null {
    const abs = normalize(join(this.dir, rel));
    if (abs !== this.dir && !abs.startsWith(this.dir + sep)) return null; // traversal
    const hit = this.cache.get(abs);
    try {
      const st = statSync(abs);
      if (!st.isFile()) return null;
      if (hit && hit.mtimeMs === st.mtimeMs) return hit;
      const body = new Uint8Array(readFileSync(abs));
      const ext = extname(abs).toLowerCase();
      const e: FileEntry = { body, mtimeMs: st.mtimeMs, type: TYPES[ext] ?? "application/octet-stream" };
      if (COMPRESSIBLE.has(ext) && body.length > 1024) {
        e.br = new Uint8Array(brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }));
        e.gz = new Uint8Array(gzipSync(body, { level: 9 }));
      }
      const size = body.length + (e.br?.length ?? 0) + (e.gz?.length ?? 0);
      if (this.bytes + size < this.maxCacheBytes) {
        this.cache.set(abs, e);
        this.bytes += size;
      }
      return e;
    } catch {
      return null;
    }
  }

  private respond(c: Context, e: FileEntry, cacheControl: string): Response {
    const ae = c.req.header("accept-encoding") ?? "";
    let body = e.body;
    const headers: Record<string, string> = { "content-type": e.type, "cache-control": cacheControl, vary: "Accept-Encoding" };
    if (e.br && /\bbr\b/.test(ae)) {
      body = e.br;
      headers["content-encoding"] = "br";
    } else if (e.gz && /\bgzip\b/.test(ae)) {
      body = e.gz;
      headers["content-encoding"] = "gzip";
    }
    headers["content-length"] = String(body.length);
    return new Response(c.req.method === "HEAD" ? null : (body as unknown as BodyInit), { status: 200, headers });
  }

  /** Serve a file or the SPA shell. Returns null when the request is not for the SPA. */
  serve(c: Context): Response | null {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return null;
    const path = decodeURIComponentSafe(new URL(c.req.url).pathname);
    if (path === null) return null;
    if (NON_SPA_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p))) return null;
    if (path !== "/" && !path.includes("\0")) {
      const e = this.load(path.slice(1));
      if (e) return this.respond(c, e, HASHED.test(path) ? "public, max-age=31536000, immutable" : "public, max-age=300");
      // Missing asset files must 404 rather than return HTML (avoids caching the shell as JS).
      // Only top-level "name.ext" paths count: SPA routes like /github/vercel/next.js are views.
      if (/^\/assets\//.test(path) || /^\/[^/]+\.[a-z0-9]{1,8}$/i.test(path)) return null;
    }
    const index = this.load("index.html");
    if (!index) return new Response("The web app is not built. Run `pnpm build` (or set STATIC_DIR).", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    return this.respond(c, index, "no-cache");
  }
}

function decodeURIComponentSafe(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
