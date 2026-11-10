// Screenshots of Storybook stories: deterministic viewport, timezone, clock and motion, in both
// themes. Used directly while working on the UI and by scripts/ui-compare.ts for before/after.
//
//   node scripts/ui-shots.ts --out .ui-shots/now                       # every story, from a fresh build
//   node scripts/ui-shots.ts --url http://127.0.0.1:6006 --stories palette,dialog --out /tmp/x
//   node scripts/ui-shots.ts --static storybook-static --check          # CI: fail if any story errors
//
// Options:
//   --url <storybook>      a running Storybook (pnpm storybook)
//   --static <dir>         a built Storybook (pnpm storybook:build); default: storybook-static, built if missing
//   --out <dir>            where PNGs and manifest.json go (default .ui-shots/current)
//   --stories <a,b>        only stories whose id contains one of these (case-insensitive)
//   --themes <dark,light>  default: both
//   --check                exit 1 when a story fails to render or logs an error
//
// Stories tagged "no-screenshot" are skipped.

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "@playwright/test";

export const VIEWPORT = { width: 1200, height: 720 };
export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export interface Shot {
  key: string; // `${id}--${theme}`
  id: string;
  title: string;
  name: string;
  theme: Theme;
  file: string; // relative to the out dir
  errors: string[];
}

export interface ShotsOptions {
  url?: string;
  staticDir?: string;
  out: string;
  stories?: string[];
  themes?: Theme[];
  log?: (s: string) => void;
}

interface IndexEntry {
  type: string;
  id: string;
  title: string;
  name: string;
  tags?: string[];
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm" };

export function serveStatic(dir: string): Promise<{ url: string; server: Server }> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^([/\\])+/, "");
    let file = join(root, path);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })));
}

/** Stable CSS for screenshots: no caret blink, transitions or animations. */
const FREEZE_CSS = `*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}`;

export async function takeShots(o: ShotsOptions): Promise<Shot[]> {
  const log = o.log ?? ((s: string) => console.log(s));
  let base = o.url?.replace(/\/$/, "");
  let server: Server | null = null;
  if (!base) {
    const dir = o.staticDir ?? "storybook-static";
    if (!existsSync(join(dir, "index.json"))) {
      log(`Building Storybook into ${dir}…`);
      execFileSync("pnpm", ["exec", "storybook", "build", "-o", dir, "--quiet"], { stdio: "inherit" });
    }
    ({ url: base, server } = await serveStatic(dir));
  }
  const index = (await (await fetch(`${base}/index.json`)).json()) as { entries: Record<string, IndexEntry> };
  const filters = (o.stories ?? []).map((s) => s.toLowerCase()).filter(Boolean);
  const stories = Object.values(index.entries).filter((e) => e.type === "story" && !e.tags?.includes("no-screenshot") && (!filters.length || filters.some((f) => e.id.toLowerCase().includes(f))));
  const themes = o.themes ?? [...THEMES];

  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });
  const shots: Shot[] = [];
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    for (const theme of themes) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
      for (const s of stories) {
        const page = await ctx.newPage();
        await page.clock.setFixedTime(new Date("2024-01-15T12:00:00Z"));
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        const key = `${s.id}--${theme}`;
        const file = `${key}.png`;
        try {
          await page.goto(`${base}/iframe.html?id=${encodeURIComponent(s.id)}&viewMode=story&globals=theme:${theme}`);
          await page.addStyleTag({ content: FREEZE_CSS });
          // Storybook marks a render "completed" after loaders, beforeEach, render and play.
          const phase = await page
            .waitForFunction(
              () => {
                const p = (window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } }).__STORYBOOK_PREVIEW__?.currentRender?.phase;
                return p === "completed" || p === "finished" || p === "errored" || p === "aborted" ? p : document.body.classList.contains("sb-show-errordisplay") ? "errored" : false;
              },
              null,
              { timeout: 30_000 },
            )
            .then((h) => h.jsonValue());
          if (phase === "errored" || phase === "aborted") errors.push(`Story ${phase}: ${(await page.locator("#error-message").textContent().catch(() => "")) ?? ""}`.trim());
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          });
          await page.waitForTimeout(100);
          // Full viewport for app-sized stories; just the story's box for small components.
          const box = await page.locator("#storybook-root").boundingBox();
          const small = box && box.height > 0 && box.height < VIEWPORT.height - 1;
          await page.screenshot({ path: join(o.out, file), ...(small ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.ceil(box.y + box.height + (box.y > 0 ? box.y : 0)) } } : {}) });
        } catch (e) {
          errors.push(e instanceof Error ? e.message.split("\n")[0]! : String(e));
        }
        await page.close();
        shots.push({ key, id: s.id, title: s.title, name: s.name, theme, file, errors });
        log(`${errors.length ? "✗" : "✓"} ${s.title} › ${s.name} (${theme})${errors.length ? `\n    ${errors.join("\n    ")}` : ""}`);
      }
      await ctx.close();
    }
  } finally {
    await browser?.close();
    server?.close();
  }
  writeFileSync(join(o.out, "manifest.json"), JSON.stringify({ viewport: VIEWPORT, shots }, null, 2));
  return shots;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      static: { type: "string" },
      out: { type: "string", default: ".ui-shots/current" },
      stories: { type: "string" },
      themes: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });
  const shots = await takeShots({
    url: values.url,
    staticDir: values.static,
    out: values.out!,
    stories: values.stories?.split(","),
    themes: values.themes?.split(",") as Theme[] | undefined,
  });
  const failed = shots.filter((s) => s.errors.length);
  console.log(`\n${shots.length} screenshots in ${resolve(values.out!)}${failed.length ? `, ${failed.length} with errors` : ""}`);
  if (values.check && failed.length) process.exit(1);
}
