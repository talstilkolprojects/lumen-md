import { test, expect } from "@playwright/test";

/**
 * Plan 14.6 — "What's new": after an update, the version's notes once, in
 * the interface's language; never on a fresh install; any time from the
 * palette. (This build's version is package.json's; its notes come from
 * CHANGELOG.md and changelog/<locale>.md at build time.)
 */

test("an update shows the notes once; a reload doesn't show them again", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.whatsNew.seen", "0.0.1");
  });
  await page.goto("/");
  const dialog = page.getByTestId("whats-new");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText("What's new in Lumen");
  await page.getByTestId("whats-new-close").click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => localStorage.getItem("lumen.whatsNew.seen") !== "0.0.1");
  await expect(dialog).toBeHidden();
});

test("a fresh install shows nothing; the palette command opens the notes in Hebrew", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => localStorage.getItem("lumen.whatsNew.seen") !== null, null, { timeout: 10_000 });
  await expect(page.getByTestId("whats-new")).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "lang.he" } })));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "help.whatsNew" } })));
  const dialog = page.getByTestId("whats-new");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("מה חדש ב־Lumen");
  await expect(dialog).toContainText("עוד לא תורגמו");
});
