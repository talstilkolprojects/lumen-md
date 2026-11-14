import { test, expect } from "@playwright/test";

/**
 * Complete history (plan 3.2): versions are kept as compressed deltas and
 * read back intact in the panel, and the panel says whether the browser
 * keeps this storage (navigator.storage.persist).
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("delta versions read back intact, and the storage state is shown", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# Draft one\n\nfirst body line\n");
  // Hiding the page is a save point.
  const hide = () =>
    page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    });
  await hide();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# Draft one\n\nfirst body line\nsecond body line\n");
  await hide();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.locator('[role="dialog"]').filter({ has: page.locator("input") });
  await palette.locator("input").first().fill("version history");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Version History/i);
  await page.keyboard.press("Enter");
  const panel = page.locator('[role="dialog"][aria-label="Version History"]');
  await expect(panel).toBeVisible();

  const status = panel.getByTestId("storage-status");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("data-persisted", /^(true|false|null)$/);
  await expect(status).toContainText(/persistent/);

  // The newest version is a delta on top of the first; it reads back whole.
  const entries = panel.locator("button").filter({ hasText: /chars/ });
  await expect(entries.first()).toBeVisible({ timeout: 5000 });
  let found = false;
  for (let i = 0; i < (await entries.count()) && !found; i++) {
    await entries.nth(i).click();
    found = (await panel.locator("pre").first().textContent()) === "# Draft one\n\nfirst body line\nsecond body line\n";
  }
  expect(found).toBe(true);
});
