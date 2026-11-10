// Production smoke: the optimized build is served by the production server (no dev server),
// a local repository opens through the companion, and a GitHub repository opens anonymously.
import { expect, test } from "@playwright/test";
import { openLocal, state } from "./harness.ts";
import { row, waitForGraph } from "./util.ts";

test("production server serves the optimized app with security headers", async ({ request }) => {
  const s = state();
  const res = await request.get(`${s.appOrigin}/github/octo/basic?commit=abc1234`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<div id="app">');
  expect(html).toMatch(/assets\/index-[\w-]+\.js/); // hashed production bundle, not /src/web/main.tsx
  expect(res.headers()["content-security-policy"]).toBeTruthy();
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});

test("opens a local repository through the companion and renders the real graph", async ({ page }) => {
  const { url } = openLocal(state().basic);
  await page.goto(url);
  await waitForGraph(page, 10);
  // The pairing code must be gone from the address bar immediately.
  expect(page.url()).not.toContain("pair=");
  await expect(page.locator('[data-hash="working"]')).toContainText("Uncommitted Changes");
  await expect(row(page, "Add sub()")).toContainText("main");
  await expect(row(page, "Merge branch 'feature/auth' into develop")).toBeVisible();
  await expect(row(page, "Document usage").locator(".ref")).toHaveCount(3); // release/1.0, v1.0, v1.0-lw
  await expect(page.getByTestId("sync-status")).toHaveAttribute("aria-label", /Live|Polling/);
});

test("opens a public GitHub repository anonymously", async ({ page }) => {
  await page.goto(`${state().appOrigin}/github/octo/basic`);
  await waitForGraph(page, 5);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});
