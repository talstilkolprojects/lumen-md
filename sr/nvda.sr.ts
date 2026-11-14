/**
 * Plan W4.21 — the Hebrew journey under NVDA (Windows, Chrome or Firefox).
 * Run on Windows (a VM is fine): see docs editor/screen-reader-automation.
 */
import { nvdaTest as test } from "@guidepup/playwright";
import { expect } from "@playwright/test";
import { runJourney } from "./runJourney";

test.use({ locale: "he-IL" });

test("NVDA: the 10 Hebrew journey tasks", async ({ page, nvda, browserName }, info) => {
  test.setTimeout(10 * 60_000);
  const results = await runJourney(page, nvda, `NVDA / Windows / ${browserName}`, info);
  expect(results.filter((r) => r.missing.length).map((r) => `${r.id} ${r.title}: ${r.missing.join(", ")}`)).toEqual([]);
});
