/**
 * W6.47 — a stand-in for a tesseract.js worker that runs the tesseract CLI
 * (5.x), so the scanned-page measurement (./measure.mjs) can run the app's
 * own OCR path, `recognizeWithMixedFix` in src/ai/ocr.ts (gutters, the
 * mixed Hebrew/Latin re-read of src/ai/ocrMixed.ts, the reading order of
 * src/ai/ocrLayout.ts), without WebAssembly. It answers the two calls that
 * path makes:
 *  - `recognize(png, {}, { blocks: true })`: the page, as blocks →
 *    paragraphs → lines → words → symbols, with boxes and confidences, from
 *    tesseract's hOCR with character boxes;
 *  - `recognize(png, { rectangle })`: one rectangle (a word), cropped with
 *    ImageMagick (no margin added, as tesseract.js's rectangle) and read on
 *    its own.
 * The image is the path of a PNG file.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const bboxOf = (title) => {
  const m = /(?:x_)?bbox(?:es)? (\d+) (\d+) (\d+) (\d+)/.exec(title);
  return m ? { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] } : { x0: 0, y0: 0, x1: 0, y1: 0 };
};

/** Parse tesseract's hOCR (with `hocr_char_boxes=1`) into tesseract.js's block tree. */
export function parseHocr(hocr) {
  const blocks = [];
  let block = null;
  let par = null;
  let line = null;
  let word = null;
  const re = /<span class='(ocr_line|ocr_caption|ocr_header|ocr_textfloat|ocrx_word|ocrx_cinfo)'[^>]*title=(?:"([^"]*)"|'([^']*)')[^>]*>([^<]*)|<(div|p) class='(ocr_carea|ocr_par)'/g;
  for (const m of hocr.matchAll(re)) {
    if (m[6] === "ocr_carea") blocks.push((block = { paragraphs: [] }));
    else if (m[6] === "ocr_par") block?.paragraphs.push((par = { lines: [] }));
    else if (m[1] === "ocrx_word") {
      const title = m[2] ?? m[3];
      word = { text: "", bbox: bboxOf(title), confidence: Number(/x_wconf (\d+)/.exec(title)?.[1] ?? 0), symbols: [] };
      line?.words.push(word);
    } else if (m[1] === "ocrx_cinfo") {
      const title = m[2] ?? m[3];
      const text = unescape(m[4]);
      word?.symbols.push({ text, bbox: bboxOf(title), confidence: Number(/x_conf ([\d.]+)/.exec(title)?.[1] ?? 0) });
      if (word) word.text += text;
    } else if (m[1]) {
      line = { text: "", words: [], bbox: bboxOf(m[2] ?? m[3]) };
      par?.lines.push(line);
    }
  }
  for (const b of blocks) for (const p of b.paragraphs) for (const l of p.lines) {
    l.words = l.words.filter((w) => w.text.trim());
    l.text = `${l.words.map((w) => w.text).join(" ")}\n`;
  }
  return blocks.map((b) => ({ paragraphs: b.paragraphs.filter((p) => p.lines.some((l) => l.words.length)).map((p) => ({ lines: p.lines.filter((l) => l.words.length) })) })).filter((b) => b.paragraphs.length);
}

/**
 * A worker for `langs` ("heb+eng", "heb", "eng") in page segmentation mode
 * `psm` (6 = one block, tesseract.js's default; 8 = one word, the app's
 * single-word workers).
 */
export function cliWorker(langs, psm, tessdata) {
  const tmp = mkdtempSync(join(tmpdir(), "tess-cli-"));
  let n = 0;
  const run = (png, extra) => execFileSync("tesseract", [png, "stdout", "-l", langs, "--oem", "1", "--psm", String(psm), "--tessdata-dir", tessdata, ...extra], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  return {
    async recognize(png, options = {}) {
      const r = options.rectangle;
      if (r) {
        const crop = join(tmp, `c${n++}.png`);
        execFileSync("convert", [png, "-crop", `${Math.round(r.width)}x${Math.round(r.height)}+${Math.round(r.left)}+${Math.round(r.top)}`, "+repage", crop]);
        const tsv = run(crop, ["-c", "tessedit_create_tsv=1"]);
        const words = tsv.split("\n").slice(1).map((row) => row.split("\t")).filter((c) => c[0] === "5" && c[11]?.trim());
        const text = words.map((c) => c[11]).join(" ");
        const confidence = words.length ? words.reduce((s, c) => s + Number(c[10]), 0) / words.length : 0;
        return { data: { text, confidence, blocks: null } };
      }
      const blocks = parseHocr(run(png, ["-c", "hocr_char_boxes=1", "-c", "tessedit_create_hocr=1"]));
      const words = blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
      const confidence = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
      const text = blocks.map((b) => b.paragraphs.map((p) => p.lines.map((l) => l.text).join("")).join("\n")).join("\n");
      return { data: { text, confidence, blocks } };
    },
    async setParameters() {},
    async terminate() {},
  };
}
