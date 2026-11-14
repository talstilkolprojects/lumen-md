/**
 * Plan 9.5 — visual baselines of the RTL matrix note (e2e/rtl-note.ts):
 * tables, lists, tasks, quotes and code, in the preview and in WYSIWYG,
 * with the interface in Hebrew, light and dark, and on two phones.
 * Same rules as surfaces.visual.ts: a missing baseline fails.
 */
import { test, expect, devices } from "@playwright/test";
import { RTL_NOTE } from "../e2e/rtl-note";
import { prepare, settle, type Variant } from "./harness";

const HE: Variant[] = [
  { id: "he-light", locale: "he", theme: "light" },
  { id: "he-dark", locale: "he", theme: "dark" },
];

const VIEWS = [
  { id: "preview", key: "Meta+3", ready: ".prose-lumen table" },
  { id: "wysiwyg", key: "Meta+4", ready: ".ProseMirror table" },
];

for (const v of HE) {
  for (const view of VIEWS) {
    test(`rtl matrix · ${view.id} · ${v.id}`, async ({ page }) => {
      await prepare(page, v, RTL_NOTE);
      await page.keyboard.press(view.key);
      await page.locator(view.ready).first().waitFor({ state: "visible", timeout: 20_000 });
      await settle(page);
      await expect(page).toHaveScreenshot(`rtl-${view.id}--${v.id}.png`, { fullPage: true });
    });
  }
}

for (const name of ["iPhone 14", "Pixel 7"] as const) {
  test.describe(name, () => {
    const { defaultBrowserType: _engine, ...device } = devices[name];
    test.use(device);
    test(`rtl matrix · preview · he-light · ${name}`, async ({ page }) => {
      await prepare(page, HE[0], RTL_NOTE);
      await page.keyboard.press("Meta+3");
      await page.locator(".prose-lumen table").first().waitFor({ state: "visible", timeout: 20_000 });
      await settle(page);
      await expect(page).toHaveScreenshot(`rtl-preview--he-light--${name.replace(/\s+/g, "-").toLowerCase()}.png`, { fullPage: true });
    });
  });
}
