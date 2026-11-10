import { expect, type Page } from "@playwright/test";

export const MOD = process.platform === "darwin" ? "Meta" : "Control";

export async function waitForGraph(page: Page, minRows = 3) {
  await expect(page.locator('[role="row"][data-row]').nth(minRows - 1)).toBeVisible({ timeout: 20_000 });
}

export function row(page: Page, subject: string) {
  return page.locator('[role="row"][data-row]', { has: page.locator(".subject", { hasText: subject }) }).first();
}

export async function focusedRowSubject(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const grid = document.querySelector('[role="grid"]');
    const id = grid?.getAttribute("aria-activedescendant");
    return id ? (document.getElementById(id)?.querySelector(".subject")?.textContent ?? null) : null;
  });
}

export async function dismissToasts(page: Page) {
  await page.evaluate(() => document.querySelectorAll('button[aria-label^="Dismiss"]').forEach((b) => (b as HTMLButtonElement).click()));
}

export async function palette(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+Shift+P`);
  const input = page.getByRole("combobox");
  await expect(input).toBeFocused();
  await input.fill(text);
  await page.waitForTimeout(100);
}
