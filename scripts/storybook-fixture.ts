// Builds the repository every Storybook story browses: the deterministic e2e "basic" fixture,
// serialized as its .git directory. Stories copy it into the browser's private file system and
// open it with the in-browser git reader, so the graph, details and diffs are real.
//
//   node scripts/storybook-fixture.ts <out.json>
//
// Run it in a fresh process: the fixture clock is module state, so a second makeBasic() in the
// same process produces different dates and hashes.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fixtureEnv, makeBasic, ROOT } from "../test/fixtures/make-fixtures.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/storybook-fixture.ts <out.json>");

// fixtureEnv() reads its isolated git config from ROOT; makeBasic only writes it into its own root.
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, ".gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n");
const { repo } = makeBasic(join(ROOT, "storybook"));
const gitDir = join(repo, ".git");

const skip = new Set(["hooks", "index", "COMMIT_EDITMSG", "description", "info"]);
function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if ((dir === gitDir && skip.has(name)) || name === "index") continue; // index files carry file-system timestamps
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: fixtureEnv() });
const commits: Record<string, string> = {};
for (const line of git(["log", "--all", "--format=%H %s"]).trim().split("\n")) {
  const i = line.indexOf(" ");
  commits[line.slice(i + 1)] ??= line.slice(0, i);
}

writeFileSync(
  out,
  JSON.stringify({
    head: git(["rev-parse", "HEAD"]).trim(),
    commits,
    files: walk(gitDir).map((f) => ({ path: `.git/${relative(gitDir, f).split("\\").join("/")}`, b64: readFileSync(f).toString("base64") })),
  }),
);
