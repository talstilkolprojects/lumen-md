import { test, expect } from "@playwright/test";

/**
 * T26 — a Hebrew note's outline works: every heading has a real id in the
 * preview (it used to be an empty string), the outline lists them, and
 * clicking an entry scrolls that heading into view. Repeated headings get
 * distinct ids, and a `[[note#heading]]`-style anchor matches the id.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("Hebrew headings get ids, the outline lists them and scrolls to them", async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `שורה ${i + 1} של טקסט בעברית.`).join("\n\n");
  const md = `# פרק ראשון\n\n${filler}\n\n## סיכום ומסקנות\n\n${filler}\n\n## פרק\n\nא\n\n## פרק\n\nב\n`;
  await page.keyboard.press("Meta+2");
  const source = page.locator(".cm-content").first();
  await source.click();
  await source.press("ControlOrMeta+a");
  await source.fill(md);

  const preview = page.locator("[data-preview-root]").first();
  await expect(preview.locator("h2#סיכום-ומסקנות")).toHaveCount(1, { timeout: 10_000 });
  await expect(preview.locator("h1#פרק-ראשון")).toHaveCount(1);
  await expect(preview.locator("h2#פרק")).toHaveCount(1);
  await expect(preview.locator("h2#פרק-1")).toHaveCount(1);
  // No heading without an id.
  expect(await preview.locator("h1:not([id]), h2:not([id]), h1[id=''], h2[id='']").count()).toBe(0);

  const link = page.locator('a.outline-link[href="#סיכום-ומסקנות"]');
  await expect(link).toBeVisible({ timeout: 10_000 });
  await link.click();
  await expect(preview.locator("h2#סיכום-ומסקנות")).toBeInViewport({ timeout: 5000 });
});
