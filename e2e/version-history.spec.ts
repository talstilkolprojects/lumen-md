import { test, expect } from "@playwright/test";

test.describe("Version History", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.removeItem("lumen-md");
    });
    await page.goto("/");
    await page.locator("header").first().waitFor({ state: "visible", timeout: 5000 });
  });

  test("opens version history via command palette", async ({ page }) => {
    // Type some content first to create a version
    const editor = page.locator(".cm-content, .ProseMirror").first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type("# Test Document");
    await expect(editor).toContainText("# Test Document");

    // Open command palette
    await page.keyboard.press("Meta+k");
    // Scope the lookup INSIDE the palette dialog so we don't match
    // the same text appearing in the editor body underneath.
    const palette = page.locator('[role="dialog"]').filter({ has: page.locator("input") });
    await expect(palette).toBeVisible({ timeout: 3000 });
    // fill() targets the input itself: typing right after the palette
    // appears can land before it has focus.
    await palette.locator("input").first().fill("version history");
    await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Version History/i, { timeout: 5000 });
    // Use keyboard Enter — the palette already focuses the first
    // match, and a mouse click can be intercepted by the backdrop.
    await page.keyboard.press("Enter");
    // The palette closes and the history panel opens in its place.
    await expect(palette).toBeHidden({ timeout: 3000 });
    await expect(page.locator('[role="dialog"][aria-label="Version History"]')).toBeVisible({ timeout: 5000 });
  });
});
