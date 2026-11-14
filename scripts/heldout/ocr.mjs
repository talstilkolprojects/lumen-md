/**
 * ocr-he of the held-out evaluator (plan W6.17): render each line in
 * Chromium with one of four Fontsource fonts that eval/golden/ocr-he does
 * not use, then read it with the app's own pipeline (tesseract.js +
 * src/ai/ocr.ts's mixed-direction fix) and score it with src/ai/ocrCer.ts.
 *
 * The images exist only in the scratch folder the caller deletes; each one
 * carries the set's canary in a tEXt chunk. The fonts are the npm tarballs
 * pinned (version + sha256) when the bundle was built.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pngWithText } from "../golden/sets/ocr.mjs";
import { round } from "../lib/heldout.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The newest version of each font package and its tarball's sha256 (at build time, on a host with npm access). */
export async function pinFonts(fonts, cache) {
  const out = [];
  for (const f of fonts) {
    const meta = await (await fetch(`https://registry.npmjs.org/@fontsource/${f.pkg}/latest`, { signal: AbortSignal.timeout(30_000) })).json();
    const tgz = await fontTarball(f.pkg, meta.version, null, cache);
    out.push({ ...f, version: meta.version, sha256: createHash("sha256").update(readFileSync(tgz)).digest("hex") });
  }
  return out;
}

async function fontTarball(pkg, version, sha, cache) {
  mkdirSync(join(cache, "fonts"), { recursive: true });
  const file = join(cache, "fonts", `${pkg}-${version}.tgz`);
  if (!existsSync(file)) {
    const r = await fetch(`https://registry.npmjs.org/@fontsource/${pkg}/-/${pkg}-${version}.tgz`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`@fontsource/${pkg}@${version}: HTTP ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  if (sha && createHash("sha256").update(readFileSync(file)).digest("hex") !== sha) throw new Error(`@fontsource/${pkg}@${version}: the tarball's sha256 changed since the bundle was built`);
  return file;
}

async function fontFaces(fonts, cache) {
  const rules = [];
  for (const f of fonts) {
    const tgz = await fontTarball(f.pkg, f.version, f.sha256, cache);
    const dir = join(cache, "fonts", `x-${f.pkg}-${f.version}`);
    for (const sub of ["hebrew", "latin"]) {
      const woff = `package/files/${f.pkg}-${sub}-400-normal.woff2`;
      if (!existsSync(join(dir, woff))) {
        mkdirSync(dir, { recursive: true });
        spawnSync("tar", ["-xzf", tgz, "-C", dir, woff], { encoding: "utf8" });
      }
      if (!existsSync(join(dir, woff))) continue; // a family without a Latin subset
      rules.push(`@font-face{font-family:'${f.family}';font-weight:400;src:url(data:font/woff2;base64,${readFileSync(join(dir, woff)).toString("base64")}) format('woff2');}`);
    }
  }
  return rules.join("\n");
}

/** Render, read and score; returns CER per condition and in all (numbers only). */
export async function renderAndRead(items, { fonts, canary, cache, dir }) {
  const { chromium } = await import("@playwright/test");
  const css = await fontFaces(fonts, cache);
  const browser = await chromium.launch();
  const images = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 400 }, deviceScaleFactor: 1 });
    for (const [i, it] of items.entries()) {
      const degraded = it.condition === "degraded";
      const style = `font-family:'${it.font}';font-size:${it.size}px;white-space:pre;color:#111;${degraded ? "filter:blur(0.7px) contrast(0.75);transform:rotate(0.8deg);" : ""}`;
      await page.setContent(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${css}html,body{margin:0;background:#fff}</style></head><body><div id="box" style="display:inline-block;padding:18px 24px;background:#fff"><div style="${style}">${esc(it.text)}</div></div></body></html>`);
      await page.evaluate(async (fam) => {
        await document.fonts.load(`400 16px '${fam}'`, "אבג");
        await document.fonts.ready;
      }, it.font);
      const file = join(dir, `${i}.png`);
      writeFileSync(file, pngWithText(await page.locator("#box").screenshot({ animations: "disabled" }), canary));
      images.push({ file, it });
    }
  } finally {
    await browser.close();
  }
  const require = createRequire(import.meta.url);
  const T = require("tesseract.js");
  const { tsImport } = await import("tsx/esm/api");
  const { buildReport } = await tsImport(join(ROOT, "src/ai/ocrCer.ts"), import.meta.url);
  const { recognizeWithMixedFix } = await tsImport(join(ROOT, "src/ai/ocr.ts"), import.meta.url);
  const opts = { langPath: join(ROOT, "public/tesseract/lang"), gzip: true };
  const main = await T.createWorker(["heb", "eng"], T.OEM.LSTM_ONLY, opts);
  const heb = await T.createWorker(["heb"], T.OEM.LSTM_ONLY, opts);
  await heb.setParameters({ tessedit_pageseg_mode: T.PSM.SINGLE_WORD });
  const inputs = [];
  try {
    for (const { file, it } of images) inputs.push({ id: it.id, condition: it.condition, reference: it.text, hypothesis: (await recognizeWithMixedFix(main, heb, readFileSync(file), null)).text });
  } finally {
    await main.terminate();
    await heb.terminate();
  }
  const report = buildReport(inputs);
  const rate = (c) => (c && c.length ? round(c.edits / c.length) : null);
  const by = Object.fromEntries(["clean", "degraded"].map((k) => [k, { cerHe: rate(report.byCondition[k].he), cerAll: rate(report.byCondition[k].all) }]));
  return { n: items.length, ...by, cer: rate(["clean", "degraded"].reduce((a, k) => ({ edits: a.edits + report.byCondition[k].all.edits, length: a.length + report.byCondition[k].all.length }), { edits: 0, length: 0 })) };
}
