// Puts the before/after screenshots from `pnpm ui:compare` into a pull request description.
//
//   pnpm ui:publish --pr 12            # push images, update the PR body
//   pnpm ui:publish --pr 12 --dry-run  # print the section, push nothing
//
// The images are committed (outside any branch, with a temporary index) and pushed to
// refs/ui-shots/pr-<n>. That ref is not a branch, so nothing lands on main and the squash merge
// never contains screenshots; the PR body links the images by commit hash. Re-running replaces the
// section between the ui-shots markers, so the PR always shows the latest comparison.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CompareReport } from "./ui-compare.ts";

const START = "<!-- ui-shots:start -->";
const END = "<!-- ui-shots:end -->";
const MAX_IMAGES = 40;

const root = resolve(import.meta.dirname, "..");
const run = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", input: opts.input, env: { ...process.env, ...opts.env } }).trim();

const { values } = parseArgs({
  options: {
    pr: { type: "string" },
    dir: { type: "string", default: ".ui-shots" },
    remote: { type: "string", default: "origin" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.pr || !/^\d+$/.test(values.pr)) {
  console.error("usage: pnpm ui:publish --pr <number> [--dir .ui-shots] [--dry-run]");
  process.exit(2);
}
const pr = values.pr;
const dir = resolve(values.dir!);
const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as CompareReport;
const shown = report.entries.filter((e) => e.status !== "unchanged");
const images = shown.slice(0, MAX_IMAGES);

// Commit the images without touching the working tree, index or any branch.
let commit = "";
if (images.length) {
  const tmp = mkdtempSync(join(tmpdir(), "lanes-ui-index-"));
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  try {
    for (const e of images) {
      const file = e.compare ?? e.after ?? e.before!;
      const blob = run("git", ["hash-object", "-w", join(dir, file)]);
      run("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env });
    }
    const tree = run("git", ["write-tree"], { env });
    commit = run("git", ["commit-tree", tree, "-m", `UI screenshots for pull request #${pr}\n\nBase ${report.base}, head ${report.head}.`]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const repo = values["dry-run"] ? "OWNER/REPO" : run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
const url = (path: string) => `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;

const label = { changed: "changed", added: "new story", removed: "removed story", unchanged: "" };
const lines = [START, "## UI before / after", ""];
lines.push(`Storybook screenshots from \`pnpm ui:compare\`: base \`${report.base.slice(0, 10)}\` → head \`${report.head.slice(0, 10)}\`${report.dirty ? " (+ uncommitted changes)" : ""}. ${shown.length} of ${report.entries.length} screenshots differ.`, "");
if (report.beforeMissing) lines.push(`> No "before" screenshots: ${report.beforeMissing}. Showing "after" only.`, "");
if (!shown.length) lines.push("No visual changes in any story.", "");
for (const [i, e] of shown.entries()) {
  const title = `${e.title} › ${e.name} (${e.theme}) — ${label[e.status]}${e.status === "changed" ? `, ${e.diffPixels.toLocaleString("en-US")} px` : ""}`;
  if (i < MAX_IMAGES) lines.push(`<details${i < 6 ? " open" : ""}><summary>${title}</summary>`, "", `![${e.key}](${url(e.compare ?? e.after ?? e.before!)})`, "", "</details>", "");
  else lines.push(`- ${title}`);
}
lines.push(END);
const section = lines.join("\n");

if (values["dry-run"]) {
  console.log(section);
  console.log(commit ? `\n(dry run: images are in local commit ${commit}; nothing pushed)` : "");
  process.exit(0);
}

if (commit) run("git", ["push", "--force", "--quiet", values.remote!, `${commit}:refs/ui-shots/pr-${pr}`]);
const body = run("gh", ["pr", "view", pr, "--json", "body", "-q", ".body"]);
const i = body.indexOf(START);
const j = body.indexOf(END);
const next = i >= 0 && j > i ? body.slice(0, i) + section + body.slice(j + END.length) : `${body.trimEnd()}\n\n${section}\n`;
run("gh", ["pr", "edit", pr, "--body-file", "-"], { input: next });
console.log(`Updated pull request #${pr} with ${images.length} image(s)${commit ? ` (refs/ui-shots/pr-${pr} → ${commit.slice(0, 10)})` : ""}.`);
