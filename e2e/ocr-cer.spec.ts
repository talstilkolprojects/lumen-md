import { test, expect } from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { incompleteParts, loadSet } from "../scripts/lib/golden.mjs";
import { OCR_CONDITIONS, buildReport, checkGates, formatReport, heldOutGaps, type CerItemInput, type OcrCondition } from "../src/ai/ocrCer";

/**
 * Plan 7.5 — OCR measured in CI. Runs the app's own OCR path
 * (window.__lumen.ocr → src/ai/ocr.ts, tesseract.js with the committed
 * tessdata_fast heb+eng models) in the production build on the golden set
 * ocr-he (plan 7.1), and gates the character error rate, Hebrew and English
 * separately, nikud removed (src/ai/ocrCer.ts): clean print ≤ 5 %, degraded
 * ≤ 12 %; nikud lines and the owner's photos (15.11) are reported only.
 *
 * Which split:
 *  - GOLDEN_TEST=<dir> (golden-sets.yml, where GOLDEN_SEED lives): the
 *    held-out test split. Only aggregate numbers are printed.
 *  - otherwise (every PR, ci.yml job ocr-cer): the public dev split
 *    committed in eval/golden/ocr-he/dev, and the output says so. These are
 *    dev numbers, never the test score.
 *
 * Opt-in (OCR_CER=1) so the regular e2e jobs do not run a several-minute
 * measurement in three browsers.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = process.env.GOLDEN_TEST;
const split = testDir ? "test" : "dev";
/** golden-sets.yml task=test record=true: the parts' sha256 are being recorded by this very run. */
const recordRun = process.env.GOLDEN_RECORD === "1";
const outPath = resolve(ROOT, process.env.OCR_CER_OUT ?? "reports/ocr-cer.json");

interface GoldenItem {
  id: string;
  part: string;
  condition: OcrCondition;
  text: string;
  image: string;
}

test.describe.configure({ retries: 0 });
// The page receives the images; with the test split nothing of it may land in a trace or a video.
test.use({ trace: "off", video: "off", screenshot: "off" });

test("OCR CER on the golden set ocr-he (Hebrew and English, per condition)", async ({ page }) => {
  test.skip(!process.env.OCR_CER, "set OCR_CER=1 to measure (ci.yml job ocr-cer)");
  test.setTimeout(20 * 60_000);

  const set = loadSet(join(ROOT, "eval", "golden"), "ocr-he", testDir ? { split: "test", testDir } : {}) as {
    manifest: unknown;
    items: GoldenItem[];
    unverified: string[];
  };
  // The held-out score is the whole split or nothing: every part at its
  // manifest count (the owner's photos included) and every part's sha256
  // recorded. golden-sets.yml continues past a failed builder or a missing
  // owner bundle, so a partial split must stop here. On the record run the
  // hashes are not recorded yet by definition: complete parts pass, and the
  // report names the ones still unverified.
  if (split === "test") {
    const gaps = heldOutGaps(incompleteParts(set.manifest, set.items), set.unverified, { recordRun });
    expect(gaps, `the ocr-he test split is incomplete or unverified, so no test score is reported: ${gaps.join("; ")}`).toEqual([]);
  }
  // Every item is measured; one without an image, a text or a known condition is an error.
  const items = set.items;
  const malformed = items.filter((it) => typeof it.image !== "string" || typeof it.text !== "string" || !(OCR_CONDITIONS as readonly string[]).includes(it.condition));
  expect(
    malformed.map((it) => (split === "dev" ? `${it.id} (${String(it.condition)})` : String(it.condition))),
    "ocr-he items without an image, a text or a known condition",
  ).toEqual([]);
  expect(items.length, `no ${split} items in eval/golden/ocr-he`).toBeGreaterThan(0);

  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await page.waitForFunction(() => typeof (window as unknown as { __lumen?: { ocr?: unknown } }).__lumen?.ocr === "function", null, { timeout: 30_000 });

  const inputs: CerItemInput[] = [];
  const started = Date.now();
  for (const it of items) {
    const b64 = readFileSync(it.image).toString("base64");
    const text = await page.evaluate(async (data) => {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const w = window as unknown as { __lumen: { ocr: (b: Blob) => Promise<{ text: string }> } };
      return (await w.__lumen.ocr(new Blob([bytes], { type: "image/png" }))).text;
    }, b64);
    inputs.push({ id: it.id, condition: it.condition, reference: it.text, hypothesis: text });
  }
  const seconds = Math.round((Date.now() - started) / 1000);

  const report = buildReport(inputs);
  const gates = checkGates(report);
  const banner =
    split === "test"
      ? `held-out TEST split (GOLDEN_SEED)${recordRun ? " — record run" : ""}${set.unverified.length ? `; parts without a recorded sha256 yet: ${set.unverified.join(", ")}` : ""}`
      : "public DEV split (eval/golden/ocr-he/dev) — GOLDEN_SEED is not available here, so these are dev numbers, not the held-out test score (plan 15.9)";
  const title = `OCR CER — ocr-he, ${banner}; ${items.length} images, ${seconds} s, tesseract.js tessdata_fast heb+eng`;
  const md = formatReport(report, title);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        split,
        ...(split === "test" ? { recordRun, unverified: set.unverified } : {}),
        images: items.length,
        seconds,
        gates,
        byCondition: report.byCondition,
        // Per-item numbers only for the public dev split.
        ...(split === "dev" ? { items: report.items } : {}),
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n\n`);
  console.log(md);

  // An empty Hebrew aggregate means the loader or the OCR path is broken, not a pass.
  for (const c of ["clean", "degraded"] as const) {
    expect(report.byCondition[c].he.items, `no Hebrew text measured for ${c}`).toBeGreaterThan(0);
  }
  const failed = gates.filter((g) => g.verdict === "fail");
  const detail = failed.map((g) => `${g.script} ${g.condition}: CER ${((g.cer ?? 0) * 100).toFixed(2)}% > ${(g.max * 100).toFixed(0)}%`);
  expect(failed.length, `OCR CER gate (plan 7.5) failed on the ${split} split: ${detail.join("; ")}`).toBe(0);
});
