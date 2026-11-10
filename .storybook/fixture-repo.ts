// Vite plugin: `import fixture from "virtual:lanes-fixture-repo"` gives stories the fixture
// repository (see scripts/storybook-fixture.ts). Generated once and cached by input hash.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:lanes-fixture-repo";
const root = resolve(import.meta.dirname, "..");
const generator = join(root, "scripts/storybook-fixture.ts");
const inputs = [generator, join(root, "test/fixtures/make-fixtures.ts")];

function fixtureJson(): string {
  const hash = createHash("sha256");
  for (const f of inputs) hash.update(readFileSync(f));
  hash.update(execFileSync("git", ["--version"], { encoding: "utf8" }));
  const dir = join(root, "node_modules/.cache/lanes-storybook");
  const file = join(dir, `fixture-${hash.digest("hex").slice(0, 16)}.json`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    execFileSync(process.execPath, [generator, file], { cwd: root, stdio: "inherit" });
  }
  return readFileSync(file, "utf8");
}

export function fixtureRepo(): Plugin {
  let json: string | null = null;
  return {
    name: "lanes-fixture-repo",
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      json ??= fixtureJson();
      return `export default ${json};`;
    },
  };
}
