import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Responsive sweep — capture screenshots at three viewport widths to
 * surface responsive bugs the desktop-only sweep missed. The previous
 * rounds found 6 production bugs via real screenshots; mobile users
 * are a different rendering path so deserve their own sweep.
 *
 * Widths chosen:
 *   - 375 × 667  : iPhone SE / older iPhone safe zone
 *   - 768 × 1024 : iPad portrait
 *   - 1024 × 768 : laptop / iPad landscape
 *
 * Plus default desktop 1280 × 720 (covered by the other sweep specs).
 */

const OUT = path.join(process.cwd(), "test-results", "screenshots", "responsive");

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
});

const VIEWPORTS = [
  { name: "iphone-se", width: 375, height: 667 },
  { name: "ipad-portrait", width: 768, height: 1024 },
  { name: "laptop", width: 1024, height: 768 },
];

for (const vp of VIEWPORTS) {
  test.describe(`@${vp.name} (${vp.width}×${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("lumen-tour-done", "1");
        localStorage.removeItem("lumen-md");
      });
      await page.goto("/");
      await page.locator("header").first().waitFor({ state: "visible", timeout: 5000 });
    });

    test("welcome doc default", async ({ page }) => {
      await expect(page.locator(".prose-lumen h1").first()).toBeVisible({ timeout: 10_000 });
      await page.screenshot({
        path: path.join(OUT, `${vp.name}-welcome.png`),
      });
    });

    test("source mode only", async ({ page }) => {
      await page.keyboard.press("Meta+1");
      await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 5000 });
      await expect(page.locator(".prose-lumen")).toHaveCount(0, { timeout: 5000 });
      await page.screenshot({
        path: path.join(OUT, `${vp.name}-source.png`),
      });
    });

    test("preview mode only", async ({ page }) => {
      await page.keyboard.press("Meta+3");
      await expect(page.locator(".prose-lumen h1").first()).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".cm-content")).toHaveCount(0, { timeout: 5000 });
      await page.screenshot({
        path: path.join(OUT, `${vp.name}-preview.png`),
      });
    });

    test("command palette is reachable + usable", async ({ page }) => {
      await page.keyboard.press("Meta+K");
      const palette = page
        .locator('[role="dialog"][aria-modal="true"]')
        .filter({ has: page.locator("input") });
      await palette.waitFor({ timeout: 5000 });
      await page.screenshot({
        path: path.join(OUT, `${vp.name}-palette.png`),
      });
      // Palette must not exceed the viewport — otherwise users on
      // smaller screens can't see their search results.
      const box = await palette.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(vp.width);
    });
  });
}
