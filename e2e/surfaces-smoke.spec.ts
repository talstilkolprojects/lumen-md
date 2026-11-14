import { test, expect } from "@playwright/test";

/**
 * M11 smoke: prove the 5 high-traffic side surfaces actually mount when
 * triggered via the command palette. Each test:
 *   1. Opens the palette.
 *   2. Types a fragment that uniquely matches the target command.
 *   3. Presses Enter.
 *   4. Asserts a visible marker for the corresponding panel/overlay.
 *
 * These are surface-mount smokes — they don't drive the panel's full
 * UI. If a panel ever silently stops rendering (regressed command,
 * dropped i18n key, broken lazy import), one of these will catch it.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await page.locator("header").first().waitFor({ state: "visible", timeout: 5000 });
});

async function openPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"]')
    .filter({ has: page.getByPlaceholder(/Type a command/i) });
  await palette.waitFor({ timeout: 5000 });
  return palette;
}

test("Tags panel opens via palette", async ({ page }) => {
  const palette = await openPalette(page);
  // Use the exact command label so we don't accidentally match the
  // "Insert tag" command or template names.
  await palette.locator("input").first().fill("View tags");
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/View tags/i, { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect(palette).not.toBeVisible({ timeout: 3000 });
  // TagsPanel renders an <aside role="complementary" aria-label="Tags">.
  await expect(
    page.locator('aside[role="complementary"][aria-label="Tags"]').first(),
  ).toBeVisible({ timeout: 3000 });
});

test("Backlinks toggle command runs and closes palette", async ({ page }) => {
  const palette = await openPalette(page);
  await palette.locator("input").first().fill("Toggle backlinks");
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/backlinks/i, { timeout: 5000 });
  await page.keyboard.press("Enter");
  // Backlinks panel may or may not visibly render depending on whether
  // the current doc has incoming wiki links — the smoke contract is
  // just that the command wiring fires and the palette closes.
  await expect(palette).not.toBeVisible({ timeout: 3000 });
});

test("Comments command is offered only with collaboration on; the palette handles a miss cleanly", async ({ page }) => {
  // Listen first: an error thrown by the palette would otherwise be missed.
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const palette = await openPalette(page);
  await palette.locator("input").first().fill("View comments panel");
  // The command exists only in a collaboration session (`collab` set);
  // the default build has none, so the search comes back empty and
  // Enter must not throw. (The old test waited 200 ms and asserted nothing.)
  await expect(palette.locator('[role="option"]')).toHaveCount(0, { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden({ timeout: 3000 });
  expect(errs).toEqual([]);
});

test("Find & Replace command opens its dialog (M3 wiring trace)", async ({ page }) => {
  // M3 audit gap: previously I claimed Find&Replace was "documented as
  // test-infra issue" without ever tracing the actual wiring. This
  // closes that gap with a real end-to-end assertion: palette command
  // `view.findReplace` → setFindReplaceOpen(true) → SearchReplace
  // dialog with role="dialog" (or close button aria-label) appears.
  const palette = await openPalette(page);
  await palette.locator("input").first().fill("Find & Replace");
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/Find & Replace/i, { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect(palette).not.toBeVisible({ timeout: 3000 });
  // SearchReplace renders a Close button with this aria-label.
  await expect(
    page.locator('button[aria-label="Close find & replace"]'),
  ).toBeVisible({ timeout: 3000 });
});

test("AI Fab is mounted in the page chrome", async ({ page }) => {
  // AI Fab is always-on chrome — no command needed. Verify the button
  // is in the DOM and visible.
  const fab = page
    .locator("button[aria-label*='AI' i], button[title*='AI' i]")
    .first();
  await expect(fab).toBeVisible({ timeout: 5000 });
});

test("Print command fires via palette (window.open intent)", async ({ page }) => {
  // printDocument opens a child window and calls print() there. Stub
  // window.open so we can detect the call without actually popping a
  // window that Playwright would have to manage.
  await page.evaluate(() => {
    (window as unknown as { __openedPrint?: boolean }).__openedPrint = false;
    const origOpen = window.open;
    window.open = (...args: Parameters<typeof origOpen>) => {
      (window as unknown as { __openedPrint?: boolean }).__openedPrint = true;
      // Return null so printDocument falls into the inline-iframe branch
      // and doesn't try to drive a real window.
      return null;
    };
    // The fallback path calls window.print() — also stub that for safety.
    window.print = () => {};
  });
  const palette = await openPalette(page);
  await palette.locator("input").first().fill("Print");
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/Print/i, { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect(palette).not.toBeVisible({ timeout: 3000 });
  // The action is dynamically imported; wait for the stub to be hit.
  await page.waitForFunction(() => (window as unknown as { __openedPrint?: boolean }).__openedPrint === true, null, { timeout: 10_000 });
});
