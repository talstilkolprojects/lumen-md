/**
 * Plan 10.3 — 10 surfaces × he / en × light / dark, compared with their
 * baselines in visual/__baselines__/<platform>/. A missing baseline fails
 * (updateSnapshots: "none"); `npm run test:visual:update` writes them.
 */
import { test, expect } from "@playwright/test";
import { SURFACES, VARIANTS, prepare, settle } from "./harness";

for (const v of VARIANTS) {
  test.describe(v.id, () => {
    for (const s of SURFACES) {
      test(s.id, async ({ page }) => {
        await prepare(page, v);
        await s.open(page);
        await page.locator(s.ready).first().waitFor({ state: "visible", timeout: 20_000 });
        await s.settled?.(page);
        await settle(page);
        // The commonest RTL bug: the page wider than the viewport.
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        await expect(page).toHaveScreenshot(`${s.id}--${v.id}.png`, { mask: s.mask?.(page) });
      });
    }
  });
}
