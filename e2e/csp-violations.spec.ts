/**
 * Guard: the first-run welcome document must not trigger any CSP or
 * Trusted Types violation. Run it against a production build served with
 * public/_headers (PLAYWRIGHT_BASE_URL) to exercise the enforced
 * `require-trusted-types-for 'script'` policy; against the dev server it
 * checks the meta-tag CSP.
 */
import { test, expect } from "@playwright/test";
test("no CSP / Trusted Types violations on first run", async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __v: string[] }).__v ??= [];
      (window as unknown as { __v: string[] }).__v.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  await page.goto("/");
  // The welcome note renders fully (lazy chunks, fonts, charts), then the
  // page is scrolled so every block mounts, then the network goes quiet.
  await expect(page.locator(".prose-lumen h1").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  await page.mouse.wheel(0, 20000);
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  const v = await page.evaluate(() => (window as unknown as { __v?: string[] }).__v ?? []);
  expect(v).toEqual([]);
});
