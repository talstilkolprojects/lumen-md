import { test, expect } from "@playwright/test";

/**
 * Plan W4.10: a first load on a Hebrew system paints right to left from the
 * first frame, and the app keeps it (no LTR flash, no flip when React starts).
 */
for (const [locale, dir, lang] of [["he-IL", "rtl", "he"], ["en-US", "ltr", "en"]] as const) {
  test.describe(`system language ${locale}`, () => {
    test.use({ locale });

    test(`first load: dir=${dir} on the first frame and after the app starts`, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("lumen-tour-done", "1");
        const w = window as unknown as { __dirs: string[]; __first?: string };
        w.__dirs = [];
        new MutationObserver(() => w.__dirs.push(document.documentElement.dir)).observe(document, { attributes: true, subtree: true, attributeFilter: ["dir"] });
        requestAnimationFrame(() => (w.__first = document.documentElement.dir));
      });
      await page.goto("/");
      await expect(page.locator("main").first()).toBeVisible({ timeout: 20_000 });
      const r = await page.evaluate(() => {
        const w = window as unknown as { __dirs: string[]; __first?: string };
        return { first: w.__first, now: document.documentElement.dir, lang: document.documentElement.lang, dirs: w.__dirs };
      });
      expect(r.first).toBe(dir);
      expect(r.now).toBe(dir);
      expect(r.lang).toBe(lang);
      // Never the other direction at any point.
      expect(r.dirs.filter((d) => d !== dir)).toEqual([]);
    });
  });
}

test("og:locale is he_IL", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "he_IL");
  await expect(page.locator('meta[property="og:locale:alternate"]')).toHaveAttribute("content", "en_US");
});
