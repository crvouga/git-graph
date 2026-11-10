// Bundles the Node entry points with esbuild. Everything (hono, zod, MCP SDK) is bundled; only Node
// builtins stay external. Add an entry to ENTRIES to ship another binary.
//
//   node scripts/build-node.ts

import { build } from "esbuild";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Entry {
  in: string;
  out: string;
  executable?: boolean;
  /** Skip silently when the source does not exist yet. */
  optional?: boolean;
}

const ENTRIES: Entry[] = [
  // The CLI also contains the companion (`git-graph serve`) and the MCP server (`git-graph mcp`).
  { in: "src/cli/main.ts", out: "dist/cli/git-graph.mjs", executable: true },
  { in: "src/companion/main.ts", out: "dist/companion/companion.mjs", executable: true },
  { in: "src/server/main.ts", out: "dist/server/server.mjs", optional: true },
];

const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

// CommonJS dependencies inside an ESM bundle need a real `require` for Node builtins.
const banner = [
  "#!/usr/bin/env node",
  "import { createRequire as __lanesCreateRequire } from 'node:module';",
  "const require = __lanesCreateRequire(import.meta.url);",
].join("\n");

const results: { entry: string; out: string; bytes: number }[] = [];
for (const e of ENTRIES) {
  const src = join(root, e.in);
  if (!existsSync(src)) {
    if (e.optional) continue;
    throw new Error(`Missing entry ${e.in}`);
  }
  const outfile = join(root, e.out);
  const r = await build({
    entryPoints: [src],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: "linked",
    legalComments: "none",
    banner: { js: banner },
    define: { "process.env.LANES_BUILD_VERSION": JSON.stringify(version) },
    // The source entry files strip their own shebang via the banner; avoid duplicates.
    logLevel: "warning",
    metafile: true,
  });
  if (e.executable) chmodSync(outfile, 0o755);
  const bytes = Object.entries(r.metafile.outputs).reduce((n, [f, o]) => (f.endsWith(".map") ? n : n + o.bytes), 0);
  results.push({ entry: e.in, out: e.out, bytes });
}

for (const r of results) console.log(`${r.out.padEnd(32)} ${(r.bytes / 1024).toFixed(0).padStart(6)} KiB  <- ${r.entry}`);
