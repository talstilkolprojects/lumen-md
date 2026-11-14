/**
 * Plan 10.3 acceptance: an unintended pixel change is caught.
 *
 * Takes a shot of the split view as a throwaway baseline, checks that the
 * same page matches it, then moves the toolbar by 3 px (the kind of change
 * nobody meant) and checks that the comparison fails. The throwaway file is
 * removed; it never becomes a real baseline.
 */
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VARIANTS, prepare, settle } from "./harness";

test("an unintended 3 px shift fails the comparison", async ({ page }, testInfo) => {
  test.skip(testInfo.config.updateSnapshots !== "none", "only meaningful when comparing, not when writing baselines");
  await prepare(page, VARIANTS[0]);
  await page.keyboard.press("Meta+2");
  await page.locator(".prose-lumen h1").first().waitFor({ state: "visible", timeout: 20_000 });
  await settle(page);

  const name = "selftest--split.png";
  const file = testInfo.snapshotPath(name);
  mkdirSync(dirname(file), { recursive: true });
  // The same settings toHaveScreenshot uses (playwright.visual.config.ts).
  const style = readFileSync(join(__dirname, "stable.css"), "utf8");
  writeFileSync(file, await page.screenshot({ animations: "disabled", caret: "hide", scale: "css", style }));
  try {
    await expect(page).toHaveScreenshot(name);

    await page.evaluate(() => {
      const bar = document.querySelector("header");
      if (bar) (bar as HTMLElement).style.paddingInlineStart = "3px";
    });
    await settle(page);
    let caught = false;
    try {
      await expect(page).toHaveScreenshot(name, { timeout: 2_000 });
    } catch {
      caught = true;
    }
    expect(caught, "a 3 px shift of the toolbar must not match the baseline").toBe(true);
  } finally {
    if (existsSync(file)) rmSync(file);
  }
});
