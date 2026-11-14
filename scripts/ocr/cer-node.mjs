#!/usr/bin/env node
/**
 * OCR CER on the ocr-he dev split in node (plan 7.5) — the same tesseract.js
 * models (public/tesseract/lang) and the same post-processing the app uses
 * (src/ai/ocr.ts → src/ai/ocrMixed.ts), scored by src/ai/ocrCer.ts. A fast
 * local check before the browser e2e (e2e/ocr-cer.spec.ts), which stays the
 * gate.
 *
 *   node scripts/ocr/cer-node.mjs [--raw] [--show]
 *
 * --raw: tesseract's text only (before ocrMixed), for comparison.
 * --show: print reference / output of the lines with Latin letters (dev data only).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const T = require("tesseract.js");
const raw = process.argv.includes("--raw");
const show = process.argv.includes("--show");
const { buildReport, formatReport, checkGates, measureItem } = await tsImport("../../src/ai/ocrCer.ts", import.meta.url);
const { recognizeWithMixedFix } = await tsImport("../../src/ai/ocr.ts", import.meta.url);

const opts = { langPath: join(ROOT, "public/tesseract/lang"), gzip: true, cachePath: process.env.TESS_CACHE };
const main = await T.createWorker(["heb", "eng"], T.OEM.LSTM_ONLY, opts);
const heb = raw ? null : await T.createWorker(["heb"], T.OEM.LSTM_ONLY, opts);
await heb?.setParameters({ tessedit_pageseg_mode: T.PSM.SINGLE_WORD });
const latin = raw ? null : await T.createWorker(["eng"], T.OEM.LSTM_ONLY, opts);
await latin?.setParameters({ tessedit_pageseg_mode: T.PSM.SINGLE_WORD });

const inputs = [];
const dir = join(ROOT, "eval/golden/ocr-he/dev");
for (const f of ["lines.json", "pages.json"]) {
  for (const it of JSON.parse(readFileSync(join(dir, f), "utf8")).items) {
    const img = readFileSync(join(dir, it.image));
    const text = raw ? (await main.recognize(img)).data.text : (await recognizeWithMixedFix(main, heb, img, latin)).text;
    inputs.push({ id: it.id, condition: it.condition, reference: it.text, hypothesis: text });
    if (show && /[A-Za-z]/.test(it.text)) {
      const en = measureItem(it.text, text).en;
      if (en.edits) {
        const latinLines = (s) => s.split("\n").filter((l) => /[A-Za-z]/.test(l)).join(" | ");
        console.error(`${it.id} (${it.condition}) en ${en.edits}/${en.length}\nR: ${latinLines(it.text)}\nH: ${latinLines(text.trim())}\n`);
      }
    }
  }
}
await main.terminate();
await heb?.terminate();
await latin?.terminate();
const report = buildReport(inputs);
console.log(formatReport(report, raw ? "tesseract only" : "with the mixed-direction fix"));
process.exitCode = checkGates(report).some((g) => g.verdict === "fail") ? 1 : 0;
