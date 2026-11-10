// Keyboard-only workflow: no mouse events from first load to closing nested views.
import { expect, test } from "@playwright/test";
import { cli, state } from "./harness.ts";
import { focusedRowSubject, MOD, waitForGraph } from "./util.ts";

test("open, navigate, details, diff, focus restoration, multi-select, compare — keyboard only", async ({ page }) => {
  const s = state();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message, e.stack?.split("\n").slice(0, 4).join(" | ")));
  page.on("console", (m) => m.type() === "error" && console.log("CONSOLEERR", m.text()));
  // Fresh launch on the home screen, paired through the one-time fragment code (as `git-graph open` does).
  const code = JSON.parse(cli(["pair", "--json"])).code as string;
  await page.goto(`${s.appOrigin}/#pair=${code}&companion=${s.companionPort}`);
  await expect(page.getByText("Connected to the local git-graph companion")).toBeVisible();

  // Open the repository by path from the palette.
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.getByRole("combobox").fill("Open Repository");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox").fill(s.basic);
  await expect(page.getByRole("option", { name: /Open local path/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await waitForGraph(page, 10);
  await expect(page).toHaveURL(/\/local\/[\w-]+/);
  await expect(page.getByRole("grid")).toBeFocused();

  // Arrow navigation and parent traversal.
  expect(await focusedRowSubject(page)).toBe("Uncommitted Changes (5)");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  expect(await focusedRowSubject(page)).toBe("Add sub()");
  await page.keyboard.press(`${MOD}+ArrowDown`); // first parent
  expect(await focusedRowSubject(page)).toBe("Remove old docs and update logo");
  await page.keyboard.press(`${MOD}+ArrowUp`); // child on the same branch
  expect(await focusedRowSubject(page)).toBe("Add sub()");

  // Enter opens details in place; the URL reproduces it.
  await page.keyboard.press("Enter");
  const details = page.getByRole("region", { name: "Commit details" });
  await expect(details).toBeVisible();
  await expect(page).toHaveURL(/commit=[0-9a-f]{40}/);

  // Tab into files, Enter opens the diff, Escape returns focus to that file.
  await page.keyboard.press("Tab");
  await expect(page.locator(".files [role=treeitem]:focus")).toBeVisible();
  await page.keyboard.press("ArrowDown"); // src/ → util.ts
  await expect(page.locator(".files [role=treeitem]:focus")).toHaveAttribute("data-file-path", "src/util.ts");
  await page.keyboard.press("Enter");
  const diff = page.getByTestId("diff-view");
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("export function sub");
  await expect(page).toHaveURL(/view=diff|file=src(%2F|\/)util\.ts/);
  await page.keyboard.press("Escape");
  await expect(diff).toBeHidden();
  await expect(page.locator(".files [role=treeitem]:focus")).toHaveAttribute("data-file-path", "src/util.ts");

  // Escape closes details and returns focus to that commit.
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(page.getByRole("grid")).toBeFocused();
  expect(await focusedRowSubject(page)).toBe("Add sub()");

  // Select two nonadjacent commits with Space, then compare with C.
  await page.keyboard.press("Space");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  expect(await focusedRowSubject(page)).toBe("Conflict side A");
  await page.keyboard.press("Space");
  await expect(page.locator('[role="row"][aria-selected="true"]')).toHaveCount(2);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("c");
  await expect(page.getByRole("region", { name: "Commit comparison" })).toContainText("Displaying all changes from");
  await expect(page).toHaveURL(/compare=/);
  await page.keyboard.press("Escape");

  // Choose a ref on a row with several refs (release/1.0, v1.0, v1.0-lw) and open its context menu.
  await page.keyboard.press("Home");
  await page.keyboard.press(`${MOD}+f`);
  await page.keyboard.type("Document usage");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("search")).toContainText("1 of 1");
  await page.keyboard.press("Escape"); // close find, focus back to graph
  expect(await focusedRowSubject(page)).toBe("Document usage");
  // ←/→ cycle through the labels on the focused row; stop on the v1.0 tag.
  const focusedRef = () => page.evaluate(() => (document.querySelector(".ref.focused") as HTMLElement | null)?.dataset.ref ?? null);
  for (let i = 0; i < 6 && (await focusedRef()) !== "v1.0"; i++) await page.keyboard.press("ArrowRight");
  await expect(page.locator(".ref.focused")).toHaveAttribute("data-ref", "v1.0");
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Delete tag");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("grid")).toBeFocused();

  // Tooltip by keyboard, shortcut help, palette shows disabled reasons.
  await page.keyboard.press("Escape"); // clear ref focus
  await page.keyboard.press("i");
  await expect(page.getByRole("tooltip")).toContainText("Document usage");
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  const helpSearch = page.getByRole("textbox", { name: "Search shortcuts" });
  await expect(helpSearch).toBeFocused();
  await page.keyboard.type("parent");
  await expect(helpSearch).toHaveValue("parent");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toContainText("Go to Parent");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.getByRole("combobox").fill("Abort operation");
  await expect(page.getByRole("option").first()).toContainText("Unavailable: No operation is in progress");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("grid")).toBeFocused();

  // Column resize by keyboard.
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.getByRole("combobox").fill("Resize Columns");
  await page.keyboard.press("Enter");
  const sep = page.getByRole("separator", { name: "Resize Graph column" });
  await expect(sep).toBeFocused();
  const before = Number(await sep.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(Number(await sep.getAttribute("aria-valuenow"))).toBe(before + 16);
  await page.keyboard.press("Escape");
});
