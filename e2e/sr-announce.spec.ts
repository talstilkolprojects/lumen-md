import { test, expect, type Page } from "@playwright/test";

/**
 * Screen-reader announcements (plan W1.23): moving the cursor onto a
 * heading or a task speaks its structure through the shared polite live
 * region, in the UI language; "Announce cursor position" speaks line,
 * column and the heading above.
 */

const DOC = ["# Plan", "", "Some text.", "", "## Next steps", "", "- [x] Done thing", "- [ ] Open thing", ""].join("\n");

async function boot(page: Page, lang: "en" | "he") {
  await page.addInitScript((l) => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: l }, version: 0 }));
  }, lang);
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
}

const polite = (page: Page) => page.getByTestId("sr-announcer-polite");

for (const [lang, heading, task, position] of [
  ["en", "Heading 2: Next steps", "Task, done", /Line 5 of \d+, column 1, under the heading: Next steps/],
  ["he", "כותרת 2: Next steps", "משימה, בוצעה", /שורה 5 מתוך \d+, עמודה 1, תחת הכותרת: Next steps/],
] as const) {
  test(`announces headings, tasks and the cursor position — ${lang}`, async ({ page }) => {
    await boot(page, lang);
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await editor.fill(DOC);
    const line = (text: string) => editor.locator(".cm-line", { hasText: text }).first();
    // Put the cursor on a line (click at its start), as a keyboard user would arrive there.
    const goTo = async (text: string) => {
      await line(text).click({ position: { x: 2, y: 4 } });
      await page.keyboard.press("Home");
    };
    await goTo("Some text.");
    await goTo("Next steps");
    await expect(polite(page)).toHaveText(heading, { timeout: 5_000 });
    await goTo("Done thing");
    await expect(polite(page)).toHaveText(task, { timeout: 5_000 });
    // Back to the heading line, then "where am I" from the palette.
    await goTo("Next steps");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "a11y.whereAmI" } })));
    await expect(polite(page)).toHaveText(position, { timeout: 5_000 });
  });
}

test("plain text lines stay quiet in the default mode", async ({ page }) => {
  await boot(page, "en");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(DOC);
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  // Line 3 is plain text: nothing is said for it. Then line 5 (a heading) is, so the region works.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(polite(page)).toHaveText("Heading 2: Next steps", { timeout: 5_000 });
  const said = await page.evaluate(() => document.querySelector('[data-testid="sr-announcer-polite"]')?.textContent ?? "");
  expect(said).not.toContain("Line 3");
});
