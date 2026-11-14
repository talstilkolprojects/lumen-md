import { test, expect } from "@playwright/test";
import { productionWorkerOrSkip } from "./_serviceWorker";

/**
 * D1 / D3 — the installed app keeps the manifest's promises:
 * a shared link opens as a note, shortcuts work, and the production build
 * still opens (with code highlighting) after going offline.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
});

test("share target shows the shared text and link", async ({ page }) => {
  await page.goto("/?title=" + encodeURIComponent("Shared page") + "&text=hello&url=" + encodeURIComponent("https://example.com/a"));
  // Appended to inbox.md and the inbox shown (plan 4.16, e2e/quick-capture.spec.ts);
  // a new "# Shared page" note where the vault can't be written.
  await expect(page.locator(".cm-content").first()).toContainText("Shared page", { timeout: 15_000 });
  await expect(page.locator(".cm-content").first()).toContainText("hello");
  await expect(page.locator(".cm-content").first()).toContainText("<https://example.com/a>");
  // The parameters are removed so a reload doesn't share twice.
  await expect.poll(() => new URL(page.url()).search).toBe("");
});

test("palette shortcut opens the command palette", async ({ page }) => {
  await page.goto("/?action=palette");
  await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 15_000 });
});

test("production build opens offline after the first visit", async ({ page, context, browserName }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  const dev = await page.evaluate(() => !!document.querySelector('script[src*="/@vite/client"]'));
  productionWorkerOrSkip(dev, browserName, { chromiumOnly: true });
  // Chromium has service workers: their absence on a production build is a regression, not a skip.
  expect(await page.evaluate(() => "serviceWorker" in navigator)).toBe(true);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // A second load lets the worker control the page and fill the chunk cache.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
  // The load event comes before the lazy editor chunks are even requested:
  // let the app finish loading them, or the cache check below sees none.
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  // The runtime cache stores a lazily-fetched chunk after answering for it,
  // so wait until every script and stylesheet this load used is in a cache:
  // that is what the offline reload needs (this was a fixed 1.5 s sleep).
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const used = performance
            .getEntriesByType("resource")
            .map((e) => new URL(e.name))
            .filter((u) => u.origin === location.origin && /\/assets\/.+\.(js|mjs|css)$/.test(u.pathname));
          const missing: string[] = [];
          for (const u of used) if (!(await caches.match(u.href))) missing.push(u.pathname);
          return missing;
        }),
      { timeout: 20_000, message: "chunks the page loaded but no cache holds yet" },
    )
    .toEqual([]);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
  await context.setOffline(false);
});
