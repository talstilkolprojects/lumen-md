#!/usr/bin/env node
/**
 * W8.4 — the CER of the 20 scanned Hebrew pages (./make.mjs) with tesseract.js
 * in Chromium, as users run it, against measure.mjs's CLI number.
 *
 * Same input as measure.mjs (each scanned PDF rendered by pdftoppm at the
 * reader's OCR scale, grey), same models (public/tesseract/lang, tessdata_fast
 * heb + eng), same path (src/ai/ocr.ts recognizeWithMixedFix with the main
 * heb+eng worker and the single-word Hebrew and Latin workers, as the app
 * creates them), same scoring (src/ai/ocrCer.ts measureItem on the line
 * texts). The only difference left is the engine: tesseract.js's WASM build
 * in a real browser instead of the Tesseract 5 CLI.
 *
 *   node scripts/ocr/scanned-he/browser-cer.mjs <scans dir> <out.json> [--cli <measure out.json>] [--scale 2]
 *
 * Gate (plan W8.4): browser CER ≤ CLI CER + 1 point; exit 1 otherwise.
 * Needs node_modules (tesseract.js, playwright with Chromium, esbuild, tsx) and poppler-utils.
 * Offline, no request leaves the page: everything is served from this checkout.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const require = createRequire(join(root, "package.json"));

/** The plan's gate: the browser may be at most one point worse than the CLI. */
export function browserGate(browserCer, cliCer, points = 1) {
  const gap = Math.round((browserCer - cliCer) * 10000) / 100;
  return { gap, pass: browserCer <= cliCer + points / 100 };
}

const flag = (args, name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);

async function main() {
  const args = process.argv.slice(2);
  const [dir, outFile] = args;
  if (!dir || !outFile) throw new Error("usage: browser-cer.mjs <scans dir> <out.json> [--cli measure.json] [--scale 2]");
  const SCALE = Number(flag(args, "--scale", "2"));
  let tess;
  try {
    tess = dirname(require.resolve("tesseract.js/package.json"));
  } catch {
    console.error("browser-cer: tesseract.js is not installed (npm ci first)");
    process.exit(2);
  }
  const core = dirname(require.resolve("tesseract.js-core/package.json"));
  const esbuild = require("esbuild");
  const { chromium } = require("playwright");
  const { measureItem } = await import("tsx/esm/api").then((m) => m.tsImport("../../../src/ai/ocrCer.ts", import.meta.url));

  // The page: the app's own OCR path, bundled, with the workers and models served from this checkout.
  const entry = join(mkdtempSync(join(tmpdir(), "browser-cer-")), "entry.ts");
  writeFileSync(entry, `
import Tesseract from "tesseract.js";
import { recognizeWithMixedFix } from ${JSON.stringify(join(root, "src/ai/ocr.ts"))};
const o = { workerPath: "/tess/worker.min.js", corePath: "/core/", langPath: "/lang", gzip: true, workerBlobURL: false };
(window as any).ocr = async (urls: string[]) => {
  const main = await Tesseract.createWorker(["heb", "eng"], Tesseract.OEM.LSTM_ONLY, o);
  const heb = await Tesseract.createWorker(["heb"], Tesseract.OEM.LSTM_ONLY, o);
  await heb.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD });
  const latin = await Tesseract.createWorker(["eng"], Tesseract.OEM.LSTM_ONLY, o);
  await latin.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD });
  const out: string[] = [];
  for (const u of urls) {
    const blob = await (await fetch(u)).blob();
    const r = await recognizeWithMixedFix(main as any, heb as any, blob, latin as any);
    out.push((r.lines ?? []).map((l: { text: string }) => l.text).join("\\n"));
  }
  await Promise.all([main.terminate(), heb.terminate(), latin.terminate()]);
  return out;
};
(window as any).ready = true;
`);
  const js = (await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", define: { "import.meta.env": "{}" }, logLevel: "error", nodePaths: [join(root, "node_modules")] })).outputFiles[0].text;

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const tmp = mkdtempSync(join(tmpdir(), "browser-cer-png-"));
  const pngs = new Map();
  for (const item of manifest.items) {
    const png = join(tmp, item.id);
    execFileSync("pdftoppm", ["-r", String(72 * SCALE), "-gray", "-png", "-singlefile", join(dir, `${item.id}.pdf`), png]);
    pngs.set(item.id, `${png}.png`);
  }

  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage();
  const outside = [];
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== "https://cer.test") {
      outside.push(u.href);
      return route.abort();
    }
    const file = (p) => route.fulfill({ body: readFileSync(p), contentType: p.endsWith(".js") ? "text/javascript" : p.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" });
    if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><script type="module" src="/t.js"></script>' });
    if (u.pathname === "/t.js") return route.fulfill({ contentType: "text/javascript", body: js });
    if (u.pathname.startsWith("/tess/")) return file(join(tess, "dist", u.pathname.slice(6)));
    if (u.pathname.startsWith("/core/")) return file(join(core, u.pathname.slice(6)));
    if (u.pathname.startsWith("/lang/")) return file(join(root, "public/tesseract/lang", u.pathname.slice(6)));
    if (u.pathname.startsWith("/scan/")) return file(pngs.get(u.pathname.slice(6)));
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("https://cer.test/");
  await page.waitForFunction(() => window.ready === true);
  const t0 = Date.now();
  const hyps = await page.evaluate((ids) => window.ocr(ids.map((id) => `/scan/${id}`)), manifest.items.map((i) => i.id));
  const seconds = (Date.now() - t0) / 1000;
  const version = await page.evaluate(() => navigator.userAgent);
  await browser.close();

  let edits = 0;
  let length = 0;
  const pages = manifest.items.map((item, i) => {
    const m = measureItem(readFileSync(join(dir, `${item.id}.txt`), "utf8").trim(), hyps[i]).all;
    edits += m.edits;
    length += m.length;
    return { id: item.id, cer: m.edits / m.length };
  });
  const tesseractJs = JSON.parse(readFileSync(join(tess, "package.json"), "utf8")).version;
  const out = { engine: `tesseract.js ${tesseractJs} (WASM) in ${version}`, path: "recognizeWithMixedFix (src/ai/ocr.ts)", models: "tessdata_fast heb+eng (public/tesseract/lang)", scale: SCALE, cer: edits / length, edits, length, seconds, requestsOutside: outside, pages };
  const cliFile = flag(args, "--cli");
  if (cliFile && existsSync(cliFile)) {
    const cli = JSON.parse(readFileSync(cliFile, "utf8"));
    out.cli = { engine: cli.engine, cer: cli.cer };
    out.gate = browserGate(out.cer, cli.cer);
  }
  writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
  console.log(`browser CER ${(out.cer * 100).toFixed(2)}% over ${length} characters, ${pages.length} pages, ${seconds.toFixed(0)} s${out.gate ? `; CLI ${(out.cli.cer * 100).toFixed(2)}%, gap ${out.gate.gap} points → ${out.gate.pass ? "PASS" : "FAIL"} (≤ +1)` : ""}; requests outside the page: ${outside.length}`);
  process.exit(out.gate && !out.gate.pass ? 1 : outside.length ? 1 : 0);
}

if (process.argv[1]?.endsWith("browser-cer.mjs")) await main();
