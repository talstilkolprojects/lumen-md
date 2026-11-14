/**
 * Plan W4.21 — the Hebrew journey under VoiceOver (macOS, Safari's engine).
 * Run on a Mac: see docs editor/screen-reader-automation.
 */
import { voiceOverTest as test } from "@guidepup/playwright";
import { expect } from "@playwright/test";
import { runJourney } from "./runJourney";

test.use({ locale: "he-IL" });

test("VoiceOver: the 10 Hebrew journey tasks", async ({ page, voiceOver }, info) => {
  test.setTimeout(10 * 60_000);
  const results = await runJourney(page, voiceOver, "VoiceOver / macOS", info);
  expect(results.filter((r) => r.missing.length).map((r) => `${r.id} ${r.title}: ${r.missing.join(", ")}`)).toEqual([]);
});
