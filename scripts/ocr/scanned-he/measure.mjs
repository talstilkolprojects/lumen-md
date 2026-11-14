/**
 * W6.47 — OCR of the scanned Hebrew pages (./make.mjs) the way the PDF
 * reader does it, measured: each scanned PDF is rendered at the reader's
 * OCR scale (pdftoppm, 72 dpi × scale), read with Tesseract's LSTM engine and
 * the same tessdata_fast Hebrew + English models the app ships
 * (public/tesseract/lang), through the app's own path, `recognizeWithMixedFix`
 * (src/ai/ocr.ts: gutters, the re-read of mixed Hebrew/Latin words in
 * src/ai/ocrMixed.ts with Hebrew-only and Latin-only single-word workers,
 * reading order), and compared with the printed text (CER, through
 * src/ai/ocrCer.ts). The engine is the tesseract CLI standing in for
 * tesseract.js (./tesseractCli.mjs). It also records, per page, the placed
 * lines the reader lays over the page and where one phrase of the printed
 * text really is on the scanned page (from the text PDF's word boxes,
 * carried through the scan's skew) — the fixture the highlight test
 * (src/__tests__/pdfOcrLayer.test.tsx) runs on.
 *
 *   npx tsx scripts/ocr/scanned-he/measure.mjs <scans dir> <out.json> [scale=2]
 *   RAW=1: tesseract's lines only, without the app's mixed-word pass (the first measurement)
 *   PSM=3: Tesseract's automatic page layout instead of the reader's 6; MEDIAN=1: a 3×3 median first
 *
 * Needs poppler-utils, ImageMagick and the tesseract CLI (5.x).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { measureItem } from "../../../src/ai/ocrCer.ts";
import { recognizeWithMixedFix } from "../../../src/ai/ocr.ts";
import { cliWorker } from "./tesseractCli.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const [dir, outFile, scaleArg = "2"] = process.argv.slice(2);
const SCALE = Number(scaleArg);
const MEDIAN = process.env.MEDIAN === "1";
/** Tesseract's page segmentation mode: 6 (one block of text) is tesseract.js's default, which the app runs with. */
const PSM = process.env.PSM ?? "6";
const RAW = process.env.RAW === "1";
const tmp = mkdtempSync(join(tmpdir(), "ocr-he-"));
const tessdata = join(tmp, "tessdata");
execFileSync("mkdir", ["-p", tessdata]);
for (const l of ["heb", "eng"]) writeFileSync(join(tessdata, `${l}.traineddata`), gunzipSync(readFileSync(join(root, `public/tesseract/lang/${l}.traineddata.gz`))));

const main = cliWorker("heb+eng", PSM, tessdata);
const heb = cliWorker("heb", 8, tessdata);
const latin = cliWorker("eng", 8, tessdata);

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const pageSize = (pdf) => {
  const m = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(execFileSync("pdfinfo", [pdf]).toString());
  return { w: Number(m[1]), h: Number(m[2]) };
};
const rev = (s) => [...s].reverse().join("");

const pages = [];
let edits = 0;
let length = 0;
for (const item of manifest.items) {
  const pdf = join(dir, `${item.id}.pdf`);
  const truth = readFileSync(join(dir, `${item.id}.txt`), "utf8").trim();
  const page = pageSize(pdf);
  const png = join(tmp, item.id);
  execFileSync("pdftoppm", ["-r", String(72 * SCALE), "-gray", "-png", "-singlefile", pdf, png]);
  // Tried and measured worse (41% at scale 3): a 3×3 median against speckle.
  if (MEDIAN) execFileSync("convert", [`${png}.png`, "-statistic", "median", "3x3", `${png}.png`]);
  let placed;
  if (RAW) {
    const tsv = execFileSync("tesseract", [`${png}.png`, "stdout", "-l", "heb+eng", "--oem", "1", "--psm", PSM, "--tessdata-dir", tessdata, "-c", "tessedit_create_tsv=1"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const lines = new Map();
    for (const row of tsv.split("\n").slice(1)) {
      const c = row.split("\t");
      if (c[0] !== "5" || !c[11]?.trim()) continue;
      const key = `${c[2]}/${c[3]}/${c[4]}`;
      const [x, y, w, h] = c.slice(6, 10).map(Number);
      const l = lines.get(key) ?? { words: [], bbox: { x0: Infinity, y0: Infinity, x1: 0, y1: 0 } };
      l.words.push(c[11]);
      l.bbox = { x0: Math.min(l.bbox.x0, x), y0: Math.min(l.bbox.y0, y), x1: Math.max(l.bbox.x1, x + w), y1: Math.max(l.bbox.y1, y + h) };
      lines.set(key, l);
    }
    placed = [...lines.values()].map((l) => ({ text: l.words.join(" "), bbox: l.bbox, column: 0 }));
  } else {
    // The app's path: the main heb+eng worker, and the single-word workers the mixed-word pass asks.
    const r = await recognizeWithMixedFix(main, heb, `${png}.png`, latin);
    placed = r.lines ?? [];
  }
  const hyp = placed.map((l) => l.text).join("\n");
  const m = measureItem(truth, hyp).all;
  edits += m.edits;
  length += m.length;

  // The phrase to highlight: three words of the first body line, and where they are.
  const words = truth.split("\n")[1].split(/\s+/).slice(1, 4);
  const xml = execFileSync("pdftotext", ["-bbox", join(dir, `${item.id}.text.pdf`), "-"]).toString();
  const boxes = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((x) => ({ x0: +x[1], y0: +x[2], x1: +x[3], y1: +x[4], w: rev(x[5]) }));
  const orig = pageSize(join(dir, `${item.id}.text.pdf`));
  // pdftotext lists a Hebrew line's words left to right (and each word's letters reversed).
  let hit = null;
  for (const seq of [words, [...words].reverse()]) {
    for (let i = 0; i + seq.length <= boxes.length && !hit; i++) if (seq.every((w, j) => boxes[i + j].w === w)) hit = boxes.slice(i, i + seq.length);
  }
  let truthBox = null;
  if (hit) {
    // The scan turned the page by `skew` degrees (clockwise, about its centre) on a larger canvas.
    const th = (item.skew * Math.PI) / 180;
    const pts = hit.flatMap((b) => [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]).map(([x, y]) => {
      const dx = x - orig.w / 2;
      const dy = y - orig.h / 2;
      return [page.w / 2 + dx * Math.cos(th) - dy * Math.sin(th), page.h / 2 + dx * Math.sin(th) + dy * Math.cos(th)];
    });
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    truthBox = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  const img = { w: Math.round(page.w * SCALE), h: Math.round(page.h * SCALE) };
  pages.push({ id: item.id, page, image: img, lines: placed, phrase: words.join(" "), truthBox, cer: { edits: m.edits, length: m.length } });
  console.log(`${item.id}  CER ${(m.edits / m.length * 100).toFixed(1)}%  lines ${placed.length}`);
}
const out = { scale: SCALE, psm: PSM, median: MEDIAN, path: RAW ? "tesseract lines" : "recognizeWithMixedFix (src/ai/ocr.ts)", engine: execFileSync("tesseract", ["--version"]).toString().split("\n")[0], models: "tessdata_fast heb+eng (public/tesseract/lang)", cer: edits / length, edits, length, pages };
writeFileSync(outFile, JSON.stringify(out) + "\n");
console.log(`CER ${(out.cer * 100).toFixed(2)}% over ${length} characters, ${pages.length} pages`);
