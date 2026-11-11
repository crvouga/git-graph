// Read-only local repository opened through the File System Access API, parsed entirely in the
// browser worker (no companion). OPFS provides a real FileSystemDirectoryHandle in automation.
import { expect, test } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AUTH_STATE, git, state } from "./harness.ts";
import { makeBasic, makePacked } from "../fixtures/make-fixtures.ts";
import { MOD, palette, row, waitForGraph } from "./util.ts";

// Local repositories (and browser-opened folders) sync through the signed-in account.
test.use({ storageState: AUTH_STATE });

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("open a packed repository from browser file access and browse it read-only", async ({ page }) => {
  const s = state();
  const root = join(s.fixturesRoot, "fsaccess");
  mkdirSync(root, { recursive: true });
  makeBasic(root);
  const packed = makePacked(root);
  const files = walk(join(packed, ".git")).map((f) => ({ path: `.git/${relative(join(packed, ".git"), f)}`, b64: readFileSync(f).toString("base64") }));
  const expected = git(packed, ["log", "--date-order", "--branches", "--tags", "--remotes", "--format=%s", "-5"]).trim().split("\n");

  await page.goto(s.appOrigin + "/");
  await page.evaluate(async (files) => {
    const opfs = await navigator.storage.getDirectory();
    const repo = await opfs.getDirectoryHandle("fixture-repo", { create: true });
    for (const f of files) {
      const parts = f.path.split("/");
      let dir = repo;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const fh = await dir.getFileHandle(parts[parts.length - 1]!, { create: true });
      const w = await fh.createWritable();
      await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
      await w.close();
    }
    // Persist the handle the same way "Open Folder…" does.
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("lanes-handles", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("handles");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise<void>((res) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(repo, "opfsfixture");
      tx.oncomplete = () => res();
    });
  }, files);

  await page.goto(`${s.appOrigin}/browser/opfsfixture`);
  await waitForGraph(page, 10);
  for (const subject of expected) await expect(row(page, subject)).toBeVisible();
  await expect(row(page, "Document usage").locator(".ref")).toHaveCount(3);

  // Details and diff come from the in-browser object reader (packfiles + deltas).
  await page.getByRole("grid").focus();
  await page.keyboard.press(`${MOD}+f`);
  await page.keyboard.type("Rename app.ts");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Commit details" })).toContainText("main.ts");

  // Mutations are unavailable and say why.
  await page.keyboard.press("Escape");
  await palette(page, "Create branch");
  await expect(page.getByRole("option").first()).toContainText(/read-only|git-graph open/);
  await page.keyboard.press("Escape");
});
