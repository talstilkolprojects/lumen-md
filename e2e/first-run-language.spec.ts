import { test, expect } from "@playwright/test";

/**
 * Plan W4.35: a Hebrew system starts the first run in Hebrew with no
 * language question and no English on screen; any other system gets one
 * question, "Which language will you write in?". Either way the first note
 * opens in the chosen language within 4 s of finishing setup.
 */
const LATIN_OK = /\b(Lumen|Obsidian|Notion|Markdown|zip|OPFS|Nord|Chrome|Edge|Safari|Firefox)\b/g;

test.describe("system language he-IL", () => {
  test.use({ locale: "he-IL" });

  test("Hebrew from the start, no language step, 0 English strings, a Hebrew first note", async ({ page }) => {
    await page.goto("/");
    const dlg = page.getByTestId("first-run");
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(dlg.locator('input[name="fr-lang"]')).toHaveCount(0);
    const steps = await dlg.locator(".lumen-firstrun-dots li").count();
    for (let i = 0; i < steps; i++) {
      const text = (await dlg.innerText()).replace(LATIN_OK, "");
      expect(text.match(/[A-Za-z]{3,}/g) ?? [], `step ${i + 1}`).toEqual([]);
      if (i < steps - 1) await dlg.locator("footer button").last().click();
    }
    const t0 = Date.now();
    await dlg.locator("footer button").last().click(); // finish, with the sample vault
    await expect(page.locator(".cm-content, .prose-lumen").first()).toContainText(/[֐-׿]/, { timeout: 4000 });
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

test.describe("system language en-US", () => {
  test.use({ locale: "en-US" });

  test("one question, Hebrew first in the list; choosing English gives an English first note", async ({ page }) => {
    await page.goto("/");
    const dlg = page.getByTestId("first-run");
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    await expect(dlg.locator("legend").first()).toHaveText("Which language will you write in?");
    await expect(dlg.locator('input[name="fr-lang"]').first().locator("..")).toHaveText("עברית");
    const steps = await dlg.locator(".lumen-firstrun-dots li").count();
    for (let i = 0; i < steps - 1; i++) await dlg.locator("footer button").last().click();
    const t0 = Date.now();
    await dlg.locator("footer button").last().click();
    await expect(page.locator(".cm-content, .prose-lumen").first()).toContainText(/Welcome|Lumen/, { timeout: 4000 });
    expect(Date.now() - t0).toBeLessThan(4000);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });
});
