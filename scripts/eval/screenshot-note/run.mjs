#!/usr/bin/env node
/**
 * Screenshot to note, measured (plan W7.16).
 *
 *   node scripts/eval/screenshot-note/run.mjs make <dir>
 *       Renders the 50 fixtures (cases.mjs) to <dir>/<id>.png in Chromium
 *       (Playwright), with the repo's Assistant font (OFL).
 *   node scripts/eval/screenshot-note/run.mjs measure <dir> [--engine ollama|tesseract-cli|gold] [--model qwen3-vl:2b] [--json out.json]
 *       Runs each screenshot through the engine and the app's own clean-up and
 *       guard (src/ai/screenshotNote.ts toNoteMarkdown), then reports CER per
 *       language (src/ai/ocrCer.ts on the text a reader sees), tables right,
 *       seconds per screenshot, and requests that left this machine.
 *       ollama: the real model (owner step: a Mac M1 with `ollama pull qwen3-vl:2b`).
 *       tesseract-cli: the fallback path's engine (Tesseract 5 on the app's models).
 *       gold: the gold text itself, to check the measuring (CER 0, tables 100%).
 *
 * Targets (plan): CER ≤ 5%, tables right ≥ 80%, ≤ 6 s per screenshot on an M1, 0 network requests.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { cases, page } from "./cases.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
};

async function make(dir) {
  const require = createRequire(join(ROOT, "package.json"));
  const { chromium } = require("playwright");
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 800, height: 600 } });
  const p = await ctx.newPage();
  await p.route("**/*", (route) => route.abort());
  const font = pathToFileURL(join(ROOT, "public/fonts/reading/assistant.woff2")).href;
  for (const c of cases()) {
    await p.setContent(page(c, font), { waitUntil: "load" });
    await p.evaluate(() => document.fonts.ready);
    await p.locator(".win").screenshot({ path: join(dir, `${c.id}.png`) });
  }
  await browser.close();
  writeFileSync(join(dir, "cases.json"), JSON.stringify(cases().map(({ id, lang, kind, gold }) => ({ id, lang, kind, gold })), null, 1) + "\n");
  console.log(`screenshot-note: ${cases().length} screenshots in ${dir}`);
}

function tesseractCli() {
  const tess = mkdtempSync(join(tmpdir(), "shot-tessdata-"));
  for (const l of ["heb", "eng"]) writeFileSync(join(tess, `${l}.traineddata`), gunzipSync(readFileSync(join(ROOT, `public/tesseract/lang/${l}.traineddata.gz`))));
  return async (file) => {
    const r = spawnSync("tesseract", [file, "stdout", "-l", "heb+eng", "--tessdata-dir", tess, "--oem", "1", "--psm", "6"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr.slice(0, 200));
    return r.stdout;
  };
}

function ollama(model, prompt) {
  const base = (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) throw new Error(`OLLAMA_HOST must be this machine (0 network requests): ${base}`);
  return async (file, lang) => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt(lang), images: [readFileSync(file).toString("base64")] }], options: { temperature: 0 } }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    return (await res.json()).message?.content ?? "";
  };
}

async function measure(dir) {
  const { tsImport } = await import("tsx/esm/api");
  const S = await tsImport("../../../src/ai/screenshotNote.ts", import.meta.url);
  const C = await tsImport("../../../src/ai/ocrCer.ts", import.meta.url);
  const items = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
  const engine = flag("--engine", "ollama");
  const model = flag("--model", S.SCREENSHOT_MODEL);
  const run = engine === "gold" ? null : engine === "tesseract-cli" ? tesseractCli() : ollama(model, S.screenshotPrompt);
  const rows = [];
  for (const it of items) {
    const t0 = performance.now();
    const raw = run ? await run(join(dir, `${it.id}.png`), it.lang) : it.gold;
    // The clean-up the app runs; the injection guard (which needs the app's i18n) is tested in screenshotNote.test.ts.
    const markdown = S.cleanScreenshotMarkdown(raw);
    const findings = [];
    const ms = performance.now() - t0;
    const cer = C.measureItem(S.plainText(it.gold), S.plainText(markdown));
    rows.push({ id: it.id, lang: it.lang, kind: it.kind, edits: cer.all.edits, length: cer.all.length, table: it.kind === "table" ? S.tableCorrect(markdown, it.gold) : null, codeBlock: it.kind === "error" || it.kind === "code" ? /```/.test(markdown) : null, findings: findings.length, ms: Math.round(ms) });
  }
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  const report = { engine, model: run && engine === "ollama" ? model : null, date: new Date().toISOString().slice(0, 10), n: rows.length, perLang: {}, tables: null, codeBlocks: null, secondsMax: Math.max(...rows.map((r) => r.ms)) / 1000, secondsMean: sum(rows, (r) => r.ms) / rows.length / 1000, rows };
  for (const lang of ["he", "en"]) {
    const rs = rows.filter((r) => r.lang === lang);
    report.perLang[lang] = { n: rs.length, cer: sum(rs, (r) => r.edits) / Math.max(1, sum(rs, (r) => r.length)) };
  }
  const t = rows.filter((r) => r.table !== null);
  report.tables = { right: t.filter((r) => r.table).length, of: t.length };
  const c = rows.filter((r) => r.codeBlock !== null);
  report.codeBlocks = { fenced: c.filter((r) => r.codeBlock).length, of: c.length };
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  console.log(`screenshot-note (${engine}${report.model ? " " + report.model : ""}): CER he ${pct(report.perLang.he.cer)}, en ${pct(report.perLang.en.cer)} (target ≤ 5%); tables right ${report.tables.right}/${report.tables.of} (target ≥ 80%); code fenced ${report.codeBlocks.fenced}/${report.codeBlocks.of}; ${report.secondsMean.toFixed(2)} s mean, ${report.secondsMax.toFixed(2)} s max (target ≤ 6 s on an M1)`);
  const out = flag("--json");
  if (out) writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
}

const [cmd, dir] = process.argv.slice(2);
if (cmd === "make" && dir) await make(dir);
else if (cmd === "measure" && dir) await measure(dir);
else {
  console.error("usage: run.mjs make <dir> | measure <dir> [--engine ollama|tesseract-cli|gold]");
  process.exit(2);
}
