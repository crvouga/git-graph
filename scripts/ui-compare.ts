// Before/after screenshots of every Storybook story: "before" is the base commit (default: where
// this branch left origin/main), "after" is the working tree, uncommitted changes included.
//
//   pnpm ui:compare                         # all stories, both themes
//   pnpm ui:compare --stories overlays      # stories whose id contains "overlays"
//   pnpm ui:compare --base HEAD             # compare against the last commit instead
//
// Writes to .ui-shots/ (gitignored):
//   before/ after/      raw screenshots      compare/   side-by-side Before | After | Diff
//   report.md           summary              report.json  input for `pnpm ui:publish`
//
// The base build runs in a temporary git worktree and is cached by commit, so repeated runs while
// iterating on a change only rebuild "after".

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { takeShots, type Shot, type Theme } from "./ui-shots.ts";

export interface CompareEntry {
  key: string;
  id: string;
  title: string;
  name: string;
  theme: Theme;
  status: "changed" | "added" | "removed" | "unchanged";
  diffPixels: number;
  /** Paths relative to the output dir. */
  before?: string;
  after?: string;
  compare?: string;
  errors: string[];
}

export interface CompareReport {
  base: string;
  baseRef: string;
  head: string;
  dirty: boolean;
  /** Why there are no "before" screenshots, if there are none. */
  beforeMissing?: string;
  entries: CompareEntry[];
}

const root = resolve(import.meta.dirname, "..");
const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function defaultBase(): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", ref]);
    } catch {
      /* try the next */
    }
  }
  return git(["rev-parse", "HEAD"]);
}

function buildStorybook(cwd: string, out: string) {
  execFileSync("pnpm", ["exec", "storybook", "build", "-o", out, "--quiet"], { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

async function beforeShots(base: string, dir: string, opts: { stories?: string[]; themes?: Theme[] }): Promise<string | null> {
  const key = createHash("sha256")
    .update([base, readFileSync(join(root, "scripts/ui-shots.ts"), "utf8"), JSON.stringify(opts)].join("\n"))
    .digest("hex")
    .slice(0, 16);
  const cache = join(root, "node_modules/.cache/lanes-ui", `before-${key}`);
  if (!existsSync(join(cache, "manifest.json"))) {
    const wt = mkdtempSync(join(tmpdir(), "lanes-ui-base-"));
    try {
      console.log(`Building "before" at ${base.slice(0, 10)} in ${wt}…`);
      git(["worktree", "add", "--detach", "--force", wt, base]);
      if (!existsSync(join(wt, ".storybook/main.ts"))) return `the base commit ${base.slice(0, 10)} has no Storybook`;
      execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--silent"], { cwd: wt, stdio: "inherit" });
      buildStorybook(wt, join(wt, "storybook-static"));
      await takeShots({ staticDir: join(wt, "storybook-static"), out: cache, ...opts, log: () => {} });
    } finally {
      try {
        git(["worktree", "remove", "--force", wt]);
      } catch {
        rmSync(wt, { recursive: true, force: true });
        git(["worktree", "prune"]);
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
  cpSync(cache, dir, { recursive: true });
  return null;
}

/** Pixel diff and a Before | After | Diff image, computed in the browser with canvas. */
async function compareImages(pairs: { before: string; after: string; out: string }[]): Promise<number[]> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results: number[] = [];
  try {
    for (const p of pairs) {
      const b64 = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
      const r = await page.evaluate(
        async ({ before, after }) => {
          const load = (src: string) =>
            new Promise<HTMLImageElement>((res, rej) => {
              const i = new Image();
              i.onload = () => res(i);
              i.onerror = rej;
              i.src = src;
            });
          const [a, b] = await Promise.all([load(before), load(after)]);
          const w = Math.max(a.width, b.width);
          const h = Math.max(a.height, b.height);
          const pixels = (img: HTMLImageElement) => {
            const c = new OffscreenCanvas(w, h);
            const g = c.getContext("2d")!;
            g.fillStyle = "#ff00ff";
            g.fillRect(0, 0, w, h);
            g.drawImage(img, 0, 0);
            return g.getImageData(0, 0, w, h);
          };
          const pa = pixels(a);
          const pb = pixels(b);
          const diff = new ImageData(w, h);
          let changed = 0;
          for (let i = 0; i < pa.data.length; i += 4) {
            const d = Math.max(Math.abs(pa.data[i]! - pb.data[i]!), Math.abs(pa.data[i + 1]! - pb.data[i + 1]!), Math.abs(pa.data[i + 2]! - pb.data[i + 2]!));
            const gray = (pb.data[i]! + pb.data[i + 1]! + pb.data[i + 2]!) / 3;
            if (d > 2) {
              changed++;
              diff.data.set([255, 0, 80, 255], i);
            } else diff.data.set([gray, gray, gray, 60], i);
          }
          if (!changed) return { changed, png: null };
          // Before | After | Diff, labelled.
          const gap = 12;
          const head = 26;
          const out = new OffscreenCanvas(w * 3 + gap * 2, h + head);
          const g = out.getContext("2d")!;
          g.fillStyle = "#111";
          g.fillRect(0, 0, out.width, out.height);
          g.fillStyle = "#eee";
          g.font = "bold 14px sans-serif";
          ["Before", "After", `Diff (${changed.toLocaleString("en-US")} px)`].forEach((t, i) => g.fillText(t, i * (w + gap) + 4, 18));
          g.drawImage(a, 0, head);
          g.drawImage(b, w + gap, head);
          g.fillStyle = "#fff";
          g.fillRect((w + gap) * 2, head, w, h);
          g.putImageData(diff, (w + gap) * 2, head);
          const blob = await out.convertToBlob({ type: "image/png" });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return { changed, png: btoa(s) };
        },
        { before: b64(p.before), after: b64(p.after) },
      );
      if (r.png) writeFileSync(p.out, Buffer.from(r.png, "base64"));
      results.push(r.changed);
    }
  } finally {
    await browser.close();
  }
  return results;
}

function markdown(r: CompareReport): string {
  const changed = r.entries.filter((e) => e.status !== "unchanged");
  const lines = [
    `# UI before / after`,
    ``,
    `Base \`${r.base.slice(0, 10)}\` (${r.baseRef}) → head \`${r.head.slice(0, 10)}\`${r.dirty ? " + uncommitted changes" : ""}.`,
    r.beforeMissing ? `\nNo "before" screenshots: ${r.beforeMissing}.` : "",
    ``,
    `${changed.length} of ${r.entries.length} story screenshots differ.`,
    ``,
  ];
  for (const e of changed) {
    lines.push(`## ${e.title} › ${e.name} (${e.theme}) — ${e.status}${e.status === "changed" ? `, ${e.diffPixels} px` : ""}`, "");
    lines.push(`![${e.key}](${e.compare ?? e.after ?? e.before})`, "");
  }
  return lines.join("\n");
}

export async function compare(o: { base?: string; stories?: string[]; themes?: Theme[]; out: string }): Promise<CompareReport> {
  const baseRef = o.base ?? "merge-base with origin/main";
  const base = o.base ? git(["rev-parse", o.base]) : defaultBase();
  const head = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]).length > 0;
  const out = resolve(o.out);
  for (const d of ["after", "before", "compare"]) rmSync(join(out, d), { recursive: true, force: true });
  mkdirSync(join(out, "compare"), { recursive: true });

  const filters = { stories: o.stories, themes: o.themes };
  const beforeMissing = (await beforeShots(base, join(out, "before"), filters)) ?? undefined;

  console.log(`Building "after" from the working tree…`);
  const afterBuild = join(root, "node_modules/.cache/lanes-ui/after-static");
  buildStorybook(root, afterBuild);
  const after = await takeShots({ staticDir: afterBuild, out: join(out, "after"), ...filters, log: () => {} });
  const before: Shot[] = beforeMissing ? [] : (JSON.parse(readFileSync(join(out, "before/manifest.json"), "utf8")) as { shots: Shot[] }).shots;

  const byKey = new Map<string, CompareEntry>();
  for (const s of before) byKey.set(s.key, { key: s.key, id: s.id, title: s.title, name: s.name, theme: s.theme, status: "removed", diffPixels: 0, before: `before/${s.file}`, errors: [] });
  for (const s of after) {
    const e = byKey.get(s.key);
    if (e) Object.assign(e, { title: s.title, name: s.name, status: "unchanged", after: `after/${s.file}`, errors: s.errors });
    else byKey.set(s.key, { key: s.key, id: s.id, title: s.title, name: s.name, theme: s.theme, status: beforeMissing ? "added" : "added", diffPixels: 0, after: `after/${s.file}`, errors: s.errors });
  }
  const both = [...byKey.values()].filter((e) => e.before && e.after);
  const counts = await compareImages(both.map((e) => ({ before: join(out, e.before!), after: join(out, e.after!), out: join(out, "compare", `${e.key}.png`) })));
  both.forEach((e, i) => {
    e.diffPixels = counts[i]!;
    if (e.diffPixels) {
      e.status = "changed";
      e.compare = `compare/${e.key}.png`;
    }
  });

  const order = { changed: 0, added: 1, removed: 2, unchanged: 3 };
  const entries = [...byKey.values()].sort((a, b) => order[a.status] - order[b.status] || a.key.localeCompare(b.key));
  const report: CompareReport = { base, baseRef, head, dirty, beforeMissing, entries };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "report.md"), markdown(report));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      stories: { type: "string" },
      themes: { type: "string" },
      out: { type: "string", default: ".ui-shots" },
    },
  });
  const r = await compare({ base: values.base, stories: values.stories?.split(","), themes: values.themes?.split(",") as Theme[] | undefined, out: values.out! });
  const out = resolve(values.out!);
  if (r.beforeMissing) console.log(`\nNo "before" screenshots: ${r.beforeMissing}. Showing "after" only.`);
  const diff = r.entries.filter((e) => e.status !== "unchanged");
  console.log(`\n${diff.length} of ${r.entries.length} story screenshots differ (base ${r.base.slice(0, 10)}).`);
  for (const e of diff) console.log(`  ${e.status.padEnd(8)} ${e.title} › ${e.name} (${e.theme})  ${join(out, e.compare ?? e.after ?? e.before!)}`);
  const broken = r.entries.filter((e) => e.errors.length);
  for (const e of broken) console.log(`  ERROR    ${e.title} › ${e.name} (${e.theme}): ${e.errors[0]}`);
  console.log(`\nReport: ${join(out, "report.md")}`);
  if (broken.length) process.exit(1);
}
