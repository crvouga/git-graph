// Companion entry point: `node src/companion/main.ts [--port N] [--allow-origin URL ...] [--app-origin URL]`
// (bundled to dist/companion/companion.mjs). `git-graph serve` runs the same code.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serveCompanion } from "./server.ts";

export async function companionMain(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      "app-origin": { type: "string" },
      quiet: { type: "boolean" },
    },
    allowPositionals: false,
  });
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error(`Invalid --port ${values.port}`);
  return serveCompanion({ port, allowedOrigins: values["allow-origin"] ?? [], appOrigin: values["app-origin"], quiet: values.quiet });
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain || process.env.LANES_COMPANION_MAIN === "1") {
  companionMain(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
