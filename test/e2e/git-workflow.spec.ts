// Git workflow through the CLI companion, keyboard only, verified with independent git commands.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { git, openLocal, state } from "./harness.ts";
import { dismissToasts, focusedRowSubject, MOD, palette, row, waitForGraph } from "./util.ts";
import { makeBasic, makeConflict } from "../fixtures/make-fixtures.ts";

async function runCommand(page: Page, text: string) {
  await palette(page, text);
  await expect(page.getByRole("option").first()).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
}

async function findCommit(page: Page, subject: string) {
  await page.keyboard.press(`${MOD}+f`);
  await page.keyboard.type(subject);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("search")).toContainText(/\d+ of \d+/);
  await page.keyboard.press("Escape");
  expect(await focusedRowSubject(page)).toBe(subject);
}

test("worktree → stage one hunk → commit → diff → compare → push → switch back", async ({ page }) => {
  const s0 = state();
  // Own copy of the fixture so other specs see the pristine one.
  const wfRoot = join(s0.fixturesRoot, "workflow");
  mkdirSync(wfRoot, { recursive: true });
  const fx = makeBasic(wfRoot);
  const s = { ...s0, basic: fx.repo, remote: fx.remote, fixturesRoot: wfRoot };
  const { url } = openLocal(s.basic);
  await page.goto(url);
  await waitForGraph(page, 10);
  await dismissToasts(page);
  await page.getByRole("grid").focus();
  const mainUrl = page.url().split("#")[0]!;

  // 1. Create a linked worktree with a new branch at "Document usage".
  await findCommit(page, "Document usage");
  await runCommand(page, "Worktree: Create worktree");
  const wtPath = join(realpathSync(s.fixturesRoot), "wt e2e"); // path with a space
  const pathField = page.getByLabel("Path");
  await expect(pathField).toBeFocused();
  await pathField.fill(wtPath);
  await page.keyboard.press("Tab");
  await page.keyboard.type("e2e/feature");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Create worktree.*done/)).toBeVisible();
  expect(git(s.basic, ["worktree", "list", "--porcelain"])).toContain(`worktree ${wtPath}`);
  expect(git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("e2e/feature");
  await dismissToasts(page);

  // 2. Switch to it (W opens the worktree picker).
  await page.getByRole("grid").focus();
  await page.keyboard.press("w");
  await page.getByRole("combobox").fill("wt e2e");
  await expect(page.getByRole("option", { name: new RegExp(wtPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(mainUrl);
  await waitForGraph(page, 5);
  await expect(row(page, "Document usage")).toContainText("e2e/feature");

  // 3. An editor changes src/app.ts in two distant places → two hunks. The graph updates by itself.
  const appTs = join(wtPath, "src/app.ts");
  const lines = readFileSync(appTs, "utf8").split("\n");
  lines[2] = "export const line2 = 'first hunk change';";
  lines[35] = "export const line35 = 'second hunk change';";
  writeFileSync(appTs, lines.join("\n"));
  await expect(page.locator('[data-hash="working"]')).toBeVisible({ timeout: 5000 });

  // 4. Open uncommitted changes → README diff → stage only the first hunk.
  await page.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Uncommitted changes" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".files [role=treeitem]:focus")).toHaveAttribute("data-file-path", "src/app.ts");
  await page.keyboard.press("Enter");
  const diff = page.getByTestId("diff-view");
  await expect(diff.locator("[data-hunk]")).toHaveCount(2);
  await page.keyboard.press("s");
  await expect(diff).toContainText("Staged changes");
  await expect(diff.locator("[data-hunk]")).toHaveCount(2); // one staged + one unstaged
  const cached = git(wtPath, ["diff", "--cached", "--", "src/app.ts"]);
  expect(cached).toContain("+export const line2 = 'first hunk change';");
  expect(cached).not.toContain("second hunk change");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // 5. Commit the staged hunk.
  await runCommand(page, "Working Tree: Commit");
  const msg = page.getByLabel("Commit message");
  await expect(msg).toBeFocused();
  await page.keyboard.type("E2E: stage one hunk");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(row(page, "E2E: stage one hunk")).toBeVisible();
  expect(git(wtPath, ["log", "-1", "--format=%s"]).trim()).toBe("E2E: stage one hunk");
  expect(git(wtPath, ["diff", "--cached"]).trim()).toBe("");
  const unstaged = git(wtPath, ["diff", "--", "src/app.ts"]);
  expect(unstaged).toContain("+export const line35 = 'second hunk change';");
  expect(unstaged).not.toContain("first hunk change");
  const newHash = git(wtPath, ["rev-parse", "HEAD"]).trim();
  await dismissToasts(page);

  // 6. Inspect the new commit's diff.
  await page.getByRole("grid").focus();
  await findCommit(page, "E2E: stage one hunk");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator(".files [role=treeitem]:focus")).toHaveAttribute("aria-label", "folder src");
  await page.keyboard.press("ArrowDown"); // src/ → app.ts
  await expect(page.locator(".files [role=treeitem]:focus")).toHaveAttribute("data-file-path", "src/app.ts");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("diff-view")).toContainText("first hunk change");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // 7. Compare it with another commit.
  await page.keyboard.press("Space");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("c");
  await expect(page.getByRole("region", { name: "Commit comparison" })).toContainText(newHash);
  await page.keyboard.press("Escape");

  // 8. Push the branch to the fixture remote (sets upstream).
  await runCommand(page, "Remote: Push");
  await expect(page.getByRole("alertdialog").getByLabel("Remote", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Push .*done/)).toBeVisible({ timeout: 15000 });
  expect(git(s.remote, ["rev-parse", "refs/heads/e2e/feature"]).trim()).toBe(newHash);
  expect(git(wtPath, ["rev-parse", "--abbrev-ref", "@{upstream}"]).trim()).toBe("origin/e2e/feature");
  await dismissToasts(page);

  // 9. Switch back to the main worktree.
  await page.getByRole("grid").focus();
  await page.keyboard.press("w");
  await page.getByRole("combobox").fill("main worktree");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(mainUrl.replace(/.*\/local\//, "/local/")));
  await waitForGraph(page, 5);
  // The shared ref created in the other worktree is visible here too.
  await expect(row(page, "E2E: stage one hunk")).toContainText("e2e/feature");
});

test("conflict: inspect, resolve, stage and continue", async ({ page }) => {
  const s0 = state();
  // Fresh mid-merge repository per run, so the test is repeatable and isolated.
  const caseRoot = join(s0.fixturesRoot, `continue-case-${Date.now()}`);
  mkdirSync(caseRoot, { recursive: true });
  const s = { ...s0, conflict: makeConflict(caseRoot) };
  const { url } = openLocal(s.conflict);
  await page.goto(url);
  await waitForGraph(page, 3);
  await expect(page.getByRole("alert").filter({ hasText: "merge in progress" })).toBeVisible();
  await page.getByRole("grid").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Uncommitted changes" })).toContainText("Merge Conflicts");
  await page.keyboard.press("Tab");
  await expect(page.locator(".files [role=treeitem]:focus")).toHaveAttribute("data-file-path", "file.txt");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Conflict in file.txt")).toBeVisible();
  await expect(page.getByText("Theirs (incoming)")).toBeVisible();
  // Edit the result by keyboard and save (Mod+Enter stages it).
  const editor = page.getByLabel(/Result/);
  await editor.focus();
  await editor.fill("a\nB-merged\nc\n");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(page.getByText(/Resolve conflict.*done/)).toBeVisible();
  expect(readFileSync(join(s.conflict, "file.txt"), "utf8")).toBe("a\nB-merged\nc\n");
  expect(git(s.conflict, ["diff", "--name-only", "--diff-filter=U"]).trim()).toBe("");
  await page.keyboard.press("Escape");
  await runCommand(page, "Continue operation");
  await expect(page.getByText(/Continue operation.*done/)).toBeVisible({ timeout: 15000 });
  const merging = () => {
    try {
      git(s.conflict, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      return true;
    } catch {
      return false;
    }
  };
  await expect.poll(merging, { timeout: 10_000 }).toBe(false);
  // Both the banner and the details-panel notice must go away (count, so it waits for all of them).
  await expect(page.getByRole("alert").filter({ hasText: /merge in progress/i })).toHaveCount(0);
  expect(git(s.conflict, ["log", "-1", "--format=%P"]).trim().split(" ")).toHaveLength(2);
});

test("conflict: abort restores the previous state", async ({ page }) => {
  const s = state();
  const caseRoot = join(s.fixturesRoot, `abort-case-${Date.now()}`);
  mkdirSync(caseRoot, { recursive: true });
  const repo = makeConflict(caseRoot);
  const before = git(repo, ["rev-parse", "HEAD"]).trim();
  const { url } = openLocal(repo);
  await page.goto(url);
  await waitForGraph(page, 3);
  await page.getByRole("grid").focus();
  await runCommand(page, "Abort operation");
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toContainText("Abort the in-progress operation");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Abort operation.*done/)).toBeVisible({ timeout: 15000 });
  expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(before);
  expect(() => git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toThrow();
  expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");
});
