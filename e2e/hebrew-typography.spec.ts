import { test, expect, type Page } from "@playwright/test";

/**
 * Hebrew typography (plan W2.9): typing צה"ל in the source editor gives
 * צה״ל; Ctrl+Z right after gives back the " at once; code is left alone;
 * the dialog applies the rules to the whole note after a preview.
 */

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.removeItem("lumen-hebrew-typography");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
});

test('typing צה"ל gives צה״ל, and undo gives back the " at once', async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type('צה"ל');
  await expect(editor).toContainText("צה״ל", { timeout: 5_000 });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toContainText('צה"ל', { timeout: 5_000 });
  // Typing on does not redo it.
  await page.keyboard.type(" הוא");
  await expect(editor).toContainText('צה"ל הוא');
});

test("code stays as typed", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type('`צה"ל` ');
  await expect(editor).toContainText('`צה"ל`');
});

test("the dialog previews and applies the rules to the whole note", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(['בית-ספר ו"ההגנה" - סיפור', "", "```", 'x = "א"-ב', "```", ""].join("\n"));
  await run(page, "edit.hebrewTypography");
  const dialog = page.getByTestId("typography-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("typography-count")).toContainText("4");
  await dialog.getByTestId("typography-apply").click();
  await expect(dialog).toHaveCount(0);
  await expect(editor).toContainText("בית־ספר ו„ההגנה” – סיפור");
  await expect(editor).toContainText('x = "א"-ב');
  // One undo step for the whole apply.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toContainText('בית-ספר ו"ההגנה" - סיפור');
});
