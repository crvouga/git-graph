// GitHub authentication boundaries and URL-addressable state.
import { expect, test } from "@playwright/test";
import { control, state } from "./harness.ts";
import { row, waitForGraph } from "./util.ts";

test("private repository: denied anonymously, readable after sign-in and connecting GitHub, denied again when GitHub revokes access", async ({ page, context }) => {
  const s = state();
  await page.goto(`${s.appOrigin}/github/octo/secret`);
  await expect(page.getByRole("alert")).toContainText("Repository not found");
  // Possession of the URL grants nothing; the API says the same.
  const api = await page.request.get(`${s.appOrigin}/api/v1/repositories/github:octo:secret/refs`);
  expect(api.status()).toBe(404);

  // Sign in through the auth relay (the fake relay signs in "alice") and land back on the same URL:
  // still not found, because GitHub is not connected yet.
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${s.appOrigin}/github/octo/secret`);
  await expect(page.getByRole("alert")).toContainText("Connect your GitHub account");
  let session = await (await page.request.get(`${s.appOrigin}/api/v1/session`)).json();
  expect(session).toMatchObject({ authenticated: true, github: { connected: false } });

  // Connect GitHub (fake GitHub authorizes "alice"): the private repository opens.
  await page.getByRole("link", { name: "Connect GitHub" }).click();
  await expect(page).toHaveURL(`${s.appOrigin}/github/octo/secret`);
  await waitForGraph(page, 5);
  await expect(page.getByRole("button", { name: /GitHub @alice/ })).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.some((c) => /token|alice/i.test(c.value) || c.value.startsWith("ghu_"))).toBe(false); // no token in the browser
  session = await (await page.request.get(`${s.appOrigin}/api/v1/session`)).json();
  expect(session).toMatchObject({ authenticated: true, github: { connected: true, login: "alice" } });
  expect(JSON.stringify(session)).not.toMatch(/ghu_|ghr_|access_token|refresh_token/);

  // GitHub revokes everything: the next authoritative read fails, GitHub is disconnected, and the UI
  // offers to connect again (the Lanes session itself stays).
  await control("/expire", { login: "alice" });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(/not found|Connection needed|Access denied/i);
  await page.reload();
  await expect(page.getByRole("link", { name: "Connect GitHub" })).toBeVisible();
});

test("deep links reconstruct the view in a fresh browser session", async ({ browser }) => {
  const s = state();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${s.appOrigin}/github/octo/basic`);
  await waitForGraph(page, 5);
  const hashes = await page.locator('[role="row"][data-hash]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.hash!));
  await ctx.close();

  const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 720 } });
  const p2 = await ctx2.newPage();
  // Commit details.
  await p2.goto(`${s.appOrigin}/github/octo/basic?commit=${hashes[1]}`);
  await expect(p2.getByRole("region", { name: "Commit details" })).toContainText(hashes[1]!);
  // Comparison via the compact a...b form, normalized into commit+compare.
  await p2.goto(`${s.appOrigin}/github/octo/basic?compare=${hashes[4]!.slice(0, 12)}...${hashes[1]!.slice(0, 12)}`);
  await expect(p2.getByRole("region", { name: "Commit comparison" })).toContainText("Displaying all changes from");
  // File diff.
  await p2.goto(`${s.appOrigin}/github/octo/basic?commit=${hashes[1]}`);
  const firstFile = p2.locator(".files [data-file-path]").first();
  await expect(firstFile).toBeVisible();
  const path = (await firstFile.getAttribute("data-file-path"))!;
  await p2.goto(`${s.appOrigin}/github/octo/basic?commit=${hashes[1]}&file=${encodeURIComponent(path)}`);
  await expect(p2.getByTestId("diff-view")).toContainText(path);
  // Branch filter + focused branch.
  await p2.goto(`${s.appOrigin}/github/octo/basic?branch=main&focus-branch=main`);
  await expect(p2.locator('[data-dropdown="branches"]')).toHaveText("main");
  await ctx2.close();
});

test("back/forward and reload restore state; invalid parameters degrade; missing refs explain themselves", async ({ page }) => {
  const s = state();
  await page.goto(`${s.appOrigin}/github/octo/basic`);
  await waitForGraph(page, 5);
  await page.getByRole("grid").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/commit=/);
  const withCommit = page.url();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/commit=/);
  await page.goBack();
  await expect(page).toHaveURL(withCommit);
  await expect(page.getByRole("region", { name: "Commit details" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("region", { name: "Commit details" })).toBeHidden();
  await page.goBack();
  await page.reload();
  await expect(page.getByRole("region", { name: "Commit details" })).toBeVisible();

  await page.goto(`${s.appOrigin}/github/octo/basic?commit=not-a-hash&order=sideways&branch=..bad`);
  await waitForGraph(page, 5);
  await expect(page.getByText(/Some link parameters were ignored/)).toBeVisible();

  await page.goto(`${s.appOrigin}/github/octo/basic?branch=deleted-branch`);
  await expect(page.getByRole("alert").filter({ hasText: "deleted-branch" })).toContainText("Not found in this repository");
  await page.getByRole("button", { name: "Show all branches" }).click();
  await waitForGraph(page, 5);
  await expect(page).not.toHaveURL(/branch=/);
  void row;
});
