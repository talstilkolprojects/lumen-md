#!/usr/bin/env node
/**
 * Hebrew handwriting, measured (plan W7.11).
 *
 *   npx tsx scripts/eval/handwriting/run.mjs sheet <writer 1..20>
 *       The writer's collection note: consent line, then 15 `## n` headings
 *       with the line to write. The writer draws each line with the pen
 *       (W5.27) under its heading and sends the note back.
 *   npx tsx scripts/eval/handwriting/run.mjs collect <writer> <note.md> <items.jsonl>
 *       Appends the writer's lines ({writer, prompt, text, ink}) to a set file.
 *       Writers 16..20 are held out (W6.17): their file stays off the repo.
 *   npx tsx scripts/eval/handwriting/run.mjs measure <items.jsonl> --engine ollama|tesseract-cli [--model qwen3-vl:2b] [--json out.json]
 *       The image path: each ink drawn as a picture in Chromium, read by the
 *       engine, CER (src/ai/ocrCer.ts) against the prompt. Prints the
 *       published line and whether the path may be exposed.
 *
 * The ink path (an online recogniser on `inkSequence`) has no engine yet: no
 * open Hebrew one exists. It is measured the day one does; until then it is
 * not exposed. 0 network requests: Ollama must be on this machine.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { GATES, collectionSheet, exposed, handwritingPrompt, itemsFromNote, publishLine, splitOf } from "../../../src/ink/handwriting.ts";
import { toMarkdown } from "../../../src/ink/inkModel.ts";
import { measureItem } from "../../../src/ai/ocrCer.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const flag = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt);

async function renderPng(ink, file) {
  const require = createRequire(join(ROOT, "package.json"));
  const { chromium } = require("playwright");
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.route("**/*", (r) => r.abort());
  const svg = toMarkdown(ink).replace(/style="[^"]*"/, "");
  await page.setContent(`<!doctype html><body style="margin:0;background:#fff"><div id="i" style="display:inline-block;padding:12px">${svg}</div>`);
  await page.locator("#i").screenshot({ path: file });
  await browser.close();
}

function tesseractCli() {
  const tess = mkdtempSync(join(tmpdir(), "hw-tess-"));
  for (const l of ["heb", "eng"]) writeFileSync(join(tess, `${l}.traineddata`), gunzipSync(readFileSync(join(ROOT, `public/tesseract/lang/${l}.traineddata.gz`))));
  return async (png) => spawnSync("tesseract", [png, "stdout", "-l", "heb+eng", "--tessdata-dir", tess, "--oem", "1", "--psm", "7"], { encoding: "utf8" }).stdout;
}

function ollama(model) {
  const base = (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) throw new Error("OLLAMA_HOST must be this machine (0 network requests)");
  return async (png) => {
    // privacy-ledger: an eval script (not the app): Ollama on this machine only.
    const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: handwritingPrompt(), images: [readFileSync(png).toString("base64")] }], options: { temperature: 0 } }) });
    return (await res.json()).message?.content ?? "";
  };
}

async function measure(file) {
  const items = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const engineName = flag("--engine", "ollama");
  const model = flag("--model", "qwen3-vl:2b");
  const read = engineName === "tesseract-cli" ? tesseractCli() : ollama(model);
  const tmp = mkdtempSync(join(tmpdir(), "hw-png-"));
  let edits = 0;
  let length = 0;
  for (const [i, it] of items.entries()) {
    const png = join(tmp, `${i}.png`);
    await renderPng(it.ink, png);
    const m = measureItem(it.text, (await read(png)).trim()).all;
    edits += m.edits;
    length += m.length;
  }
  const result = { path: "image", engine: engineName === "ollama" ? `ollama ${model}` : "tesseract 5 CLI (baseline)", cer: length ? edits / length : 1, lines: items.length, date: new Date().toISOString().slice(0, 10) };
  const heldout = items.every((it) => splitOf(it.writer) === "heldout");
  console.log(publishLine(result) + (heldout ? "" : " [NOT the held-out set: development only]"));
  console.log(`exposed: image ${exposed(heldout ? [result] : []).image ? "yes" : "no"}, ink no (no engine) — bars: ink ${GATES.ink * 100}%, image ${GATES.image * 100}%`);
  const out = flag("--json");
  if (out) writeFileSync(out, JSON.stringify({ ...result, heldout }, null, 1) + "\n");
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === "sheet") process.stdout.write(collectionSheet(Number(a)));
else if (cmd === "collect") {
  const { items, missing } = itemsFromNote(Number(a), readFileSync(b, "utf8"));
  for (const it of items) appendFileSync(c, JSON.stringify(it) + "\n");
  console.log(`collect: writer ${a} (${splitOf(Number(a))}): ${items.length} lines${missing.length ? `, missing ${missing.join(", ")}` : ""} → ${c}`);
} else if (cmd === "measure") await measure(a);
else if (process.argv[1]?.endsWith("run.mjs")) {
  console.error("usage: run.mjs sheet <writer> | collect <writer> <note.md> <items.jsonl> | measure <items.jsonl> --engine ollama|tesseract-cli");
  process.exit(2);
}
