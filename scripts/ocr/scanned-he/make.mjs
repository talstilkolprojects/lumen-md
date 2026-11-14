/**
 * W6.47 — real scanned Hebrew PDFs for the PDF reader's OCR: a text page is
 * printed to PDF by Chromium, rasterised by poppler (pdftoppm), degraded the
 * way a desk scanner does (ImageMagick: a small skew, blur, speckle, grey
 * paper, JPEG), and wrapped back into an image-only PDF (img2pdf). The
 * ground truth is the text that was printed.
 *
 *   node scripts/ocr/scanned-he/make.mjs <out dir> [count=20]
 *
 * Needs: Playwright's Chromium, poppler-utils, ImageMagick, img2pdf.
 * Deterministic for a given count (seeded choices). Writes <out>/scan-NN.pdf,
 * <out>/scan-NN.txt (ground truth) and <out>/manifest.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url);
const { chromium } = require("playwright");
const [out = "scans", countArg = "20"] = process.argv.slice(2);
const COUNT = Number(countArg);
mkdirSync(out, { recursive: true });
const T = JSON.parse(readFileSync(join(here, "texts.json"), "utf8"));
let seed = 47;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const FONTS = ["DejaVu Sans", "FreeSerif", "FreeSans", "Liberation Serif"];
// skew degrees, blur sigma, speckle amount, dpi
const SCANS = [
  { skew: 0.4, blur: 0.4, noise: 0.008, dpi: 200 },
  { skew: -0.8, blur: 0.6, noise: 0.012, dpi: 200 },
  { skew: 1.2, blur: 0.8, noise: 0.02, dpi: 150 },
  { skew: 0, blur: 0.3, noise: 0.004, dpi: 300 },
];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
const manifest = [];
for (let i = 1; i <= COUNT; i++) {
  const id = `scan-${String(i).padStart(2, "0")}`;
  const font = FONTS[i % FONTS.length];
  const scan = SCANS[i % SCANS.length];
  const heading = pick(T.headings);
  const paras = [pick(T.paragraphs), pick(T.paragraphs)];
  if (paras[0] === paras[1]) paras[1] = T.paragraphs[(T.paragraphs.indexOf(paras[0]) + 1) % T.paragraphs.length];
  const extra = pick(T.extras);
  const html = `<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:'${font}';font-size:15pt;line-height:1.6;margin:0;padding:0;width:15cm">
<h1 style="font-size:20pt;margin:0 0 10pt">${esc(heading)}</h1>${paras.map((p) => `<p style="margin:0 0 10pt">${esc(p)}</p>`).join("")}<p style="margin:0">${esc(extra)}</p></body>`;
  await page.setContent(html);
  // The ground truth: the lines as the browser broke them.
  const truth = await page.evaluate(() => {
    const lines = [];
    for (const el of document.body.children) {
      const r = document.createRange();
      const text = el.textContent;
      let line = "";
      let top = null;
      for (let k = 0; k < text.length; k++) {
        r.setStart(el.firstChild, k);
        r.setEnd(el.firstChild, k + 1);
        const rect = r.getClientRects()[0];
        const y = rect ? Math.round(rect.top) : top;
        if (top !== null && y !== null && Math.abs(y - top) > 4 && line.trim()) {
          lines.push(line.trim());
          line = "";
        }
        if (y !== null) top = y;
        line += text[k];
      }
      if (line.trim()) lines.push(line.trim());
    }
    return lines.join("\n");
  });
  const textPdf = join(out, `${id}.text.pdf`);
  await page.pdf({ path: textPdf, format: "A4", margin: { top: "2.5cm", bottom: "2.5cm", left: "3cm", right: "3cm" } });
  const base = join(out, `${id}.raster`);
  execFileSync("pdftoppm", ["-r", String(scan.dpi), "-gray", "-png", "-singlefile", textPdf, base]);
  const jpg = join(out, `${id}.jpg`);
  execFileSync("convert", [
    `${base}.png`,
    "-background", "white", "-rotate", String(scan.skew),
    "-blur", `0x${scan.blur}`,
    "-attenuate", String(scan.noise * 10), "+noise", "Impulse",
    "-level", "0%,92%",
    "-fill", "#f2efe6", "-colorize", "4%",
    "-colorspace", "Gray",
    "-units", "PixelsPerInch", "-density", String(scan.dpi), "-quality", "70", jpg,
  ]);
  execFileSync("img2pdf", ["--output", join(out, `${id}.pdf`), jpg]);
  writeFileSync(join(out, `${id}.txt`), truth + "\n");
  manifest.push({ id, font, ...scan, chars: truth.replace(/\s/g, "").length });
}
await browser.close();
writeFileSync(join(out, "manifest.json"), JSON.stringify({ count: COUNT, items: manifest }, null, 2) + "\n");
console.log(`made ${COUNT} scanned pages in ${out}`);
