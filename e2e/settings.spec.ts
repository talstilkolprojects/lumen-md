import { test, expect } from "@playwright/test";

/**
 * Plan 11.1 — one settings screen: open it from the palette, search, change
 * a setting, and find a setting that lives inside another tab.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await page.locator("header").first().waitFor({ state: "visible", timeout: 5000 });
});

test("settings: search, change a setting, and the change is saved", async ({ page }) => {
  await page.keyboard.press("Meta+K");
  await page.keyboard.type("Settings");
  await page.getByRole("option", { name: /^Settings/ }).first().click();

  const screen = page.getByTestId("settings-screen");
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");

  // Search narrows the General tab to the matching switch.
  await screen.getByTestId("settings-search").fill("vim");
  const vim = screen.locator('[data-setting="vimEnabled"]');
  await expect(vim).toBeVisible();
  await expect(screen.locator('[data-setting="spellCheck"]')).toHaveCount(0);

  await vim.check();
  await expect(vim).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("lumen-md") ?? "{}").state?.vimEnabled))
    .toBe(true);

  // A setting inside another tab's dialog: the search moves to that tab.
  await screen.getByTestId("settings-search").fill("Ollama");
  await expect(screen.getByRole("tab", { name: "AI settings" })).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByRole("tab", { name: "General" })).toHaveCount(0);
  await expect(screen.getByTestId("settings-tab-ai")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(screen).toHaveCount(0);
});

test("settings: the theme command opens the screen on the Theme tab", async ({ page }) => {
  await page.keyboard.press("Meta+K");
  await page.keyboard.type("Theme settings");
  await page.getByRole("option", { name: /Theme settings/ }).first().click();
  const screen = page.getByTestId("settings-screen");
  await expect(screen.getByRole("tab", { name: "Theme" })).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByTestId("theme-settings")).toBeVisible();
});
