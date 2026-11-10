// Clone, blame and interactive rebase through the UI (keyboard), verified with git.
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AUTH_STATE, git, state } from "./harness.ts";
import { makeBasic } from "../fixtures/make-fixtures.ts";
import { dismissToasts, focusedRowSubject, MOD, palette, row, waitForGraph } from "./util.ts";

test.use({ storageState: AUTH_STATE });

test("clone → blame → interactive rebase (reword)", async ({ page }) => {
  const s = state();
  const root = join(s.fixturesRoot, "more");
  mkdirSync(root, { recursive: true });
  const fx = makeBasic(root);
  const dest = join(root, "cloned repo");

  // Signed in to the account the companion is paired with; the clone runs on the companion.
  await page.goto(`${s.appOrigin}/`);

  // Clone the fixture remote.
  await palette(page, "Clone Repository");
  await page.keyboard.press("Enter");
  await page.getByLabel("Repository URL").fill(fx.remote);
  await page.getByLabel("Destination folder (absolute path)").fill(dest);
  await page.keyboard.press("Enter");
  await waitForGraph(page, 5);
  await expect(row(page, "Remove old docs and update logo")).toContainText("main");
  expect(git(dest, ["rev-parse", "HEAD"]).trim()).toBe(git(fx.remote, ["rev-parse", "main"]).trim());
  await dismissToasts(page);

  // Blame from the file context menu.
  await page.getByRole("grid").focus();
  await page.keyboard.press(`${MOD}+f`);
  await page.keyboard.type("Add util module");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("search")).toContainText("1 of 1");
  await page.keyboard.press("Escape");
  expect(await focusedRowSubject(page)).toBe("Add util module");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator(".files [role=treeitem]:focus")).toHaveAttribute("aria-label", "folder src");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("b"); // type-ahead → "Blame at This Revision"
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toContainText("export function add");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");

  // Interactive rebase: reword the newest commit on main, onto "Document usage".
  await page.getByRole("grid").focus();
  await page.keyboard.press(`${MOD}+f`);
  await page.keyboard.type("Document usage");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("search")).toContainText("1 of 1");
  await page.keyboard.press("Escape");
  await palette(page, "Interactive Rebase from Here");
  await page.keyboard.press("Enter");
  const plan = page.getByLabel("Plan");
  await expect(plan).toHaveValue(/Remove old docs and update logo/);
  const value = await plan.inputValue();
  await plan.fill(value.replace(/^pick (\w+) Remove old docs and update logo$/m, "reword $1 Reworded by interactive rebase"));
  await page.keyboard.press(`${MOD}+Enter`);
  // The rebase rewrites history: confirm the exact consequence.
  await expect(page.getByRole("alertdialog")).toContainText("interactive plan of 2 steps");
  await page.keyboard.press("Enter");
  await expect(row(page, "Reworded by interactive rebase")).toBeVisible({ timeout: 15000 });
  expect(git(dest, ["log", "-1", "--format=%s"]).trim()).toBe("Reworded by interactive rebase");
  expect(git(dest, ["log", "-2", "--format=%s"]).trim().split("\n")[1]).toBe("Rename app.ts to main.ts");
});
