import { test, expect } from "@playwright/test";

/**
 * Smart Insert (⌘⇧V): pasted HTML becomes markdown before it lands in
 * the note. Two layers: the converter on the public test surface
 * (`window.__lumen.htmlToMarkdown`, set at startup — works against the
 * dev server and the production bundle alike, so there is no skip), and
 * the user path through the dialog into the editor.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("htmlToMarkdown utility round-trips bold + heading", async ({ page }) => {
  await page.waitForFunction(() => typeof (window as unknown as { __lumen?: { htmlToMarkdown?: unknown } }).__lumen?.htmlToMarkdown === "function", null, { timeout: 10_000 });
  const md = await page.evaluate(() => {
    const w = window as unknown as Window & { __lumen: { htmlToMarkdown: (html: string) => string } };
    return w.__lumen.htmlToMarkdown("<h1>Hello</h1><p><strong>bold</strong> text</p>");
  });
  expect(md).toMatch(/^# Hello/);
  expect(md).toMatch(/\*\*bold\*\*/);
});

test("Smart Insert turns pasted HTML into markdown in the note", async ({ page }) => {
  await page.keyboard.press("Meta+1"); // source
  const source = page.locator(".cm-content").first();
  await source.click();
  await source.press("ControlOrMeta+a");
  await source.fill("# Notes\n\n");

  await page.keyboard.press("Meta+Shift+V");
  const dialog = page.locator('[role="dialog"][aria-labelledby="insert-text-title"]');
  await expect(dialog).toBeVisible({ timeout: 8000 });
  const box = dialog.locator("textarea").first();
  await box.fill("<h2>From the web</h2><p>Some <em>pasted</em> text with a <a href=\"https://example.com\">link</a>.</p><ul><li>one</li><li>two</li></ul>");
  // The detector names the conversion before anything is inserted.
  await expect(dialog).toContainText(/HTML → Markdown/i);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(dialog).toBeHidden({ timeout: 5000 });

  await expect(source).toContainText("## From the web");
  await expect(source).toContainText("*pasted*");
  await expect(source).toContainText("[link](https://example.com)");
  await expect(source).toContainText("- one");
  await expect(source).not.toContainText("<h2>");
});
