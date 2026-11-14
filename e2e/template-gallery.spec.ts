import { test, expect } from "@playwright/test";

test.describe("Template Gallery", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.removeItem("lumen-md");
    });
    await page.goto("/");
    await page.locator("header").first().waitFor({ state: "visible", timeout: 5000 });
  });

  // Palette and template gallery both render with role="dialog".
  // Distinguish them by aria-label: palette uses the "Type a command…"
  // placeholder, the gallery uses its own label.
  const PALETTE_LABEL = /Type a command/i;

  test("opens gallery via command palette", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    const palette = page.locator('[role="dialog"]', { hasNot: page.locator("not-real") })
      .filter({ has: page.getByPlaceholder(PALETTE_LABEL) });
    await palette.waitFor({ timeout: 3000 });
    await palette.locator("input").first().fill("template gallery");
    await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/template/i, { timeout: 5000 });
    await page.keyboard.press("Enter");
    // Once the action fires, the PALETTE itself closes and the gallery
    // (its own dialog) opens.
    await expect(palette).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 5000 });
  });

  test("gallery has at least 5 templates", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    const palette = page.locator('[role="dialog"]')
      .filter({ has: page.getByPlaceholder(PALETTE_LABEL) });
    await palette.waitFor({ timeout: 3000 });
    await palette.locator("input").first().fill("template gallery");
    await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/template/i, { timeout: 5000 });
    await page.keyboard.press("Enter");
    await expect(palette).not.toBeVisible({ timeout: 3000 });
    // The static registry (public/templates/registry.json) has ten
    // templates; the gallery lists them once the fetch resolves.
    const cards = page.getByTestId("template-card");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(5);
  });
});
