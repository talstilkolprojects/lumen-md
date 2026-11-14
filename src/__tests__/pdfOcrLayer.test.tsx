/**
 * W6.47 — highlighting on scanned Hebrew PDFs. For each of 20 real scanned
 * pages (scripts/ocr/scanned-he: printed by Chromium, rasterised by poppler,
 * skewed, blurred and speckled), the fixture holds what the app's own OCR
 * path (`recognizeWithMixedFix`: Tesseract's LSTM with the app's models at
 * the reader's OCR scale, the gutter split and the re-read of mixed
 * Hebrew/Latin words) placed on the page. Those lines are laid over the page
 * exactly as the reader does (OcrTextLayer), a phrase of the printed text is
 * found in that layer the way the reader's search finds it on a scanned page
 * (findAll, loose), turned into a highlight, and the highlight must land on
 * the phrase where it really is on the scanned page (from the text PDF's word
 * boxes) and re-anchor from the saved annotation.
 * Plan acceptance: highlighting works on ≥ 18 of 20. Measured: 20 of 20
 * (19 exactly, scan-10 loosely: OCR read "איךר" for "איך"), CER 12.17%.
  */
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import fixture from "./fixtures/scanned-he/ocr.json";
import { OcrTextLayer } from "../pdf/OcrTextLayer";
import { ocrPageOf } from "../pdf/ocrPages";
import { textLayerSpans, type PlacedLine } from "../ai/ocrLayout";
import { anchorAnnotation, createPdfAnnotation, findAll, unionRect, type PageRect } from "../pdf/annotations";
import { layerText, offsetsToRange, rangePageRects } from "../pdf/textMap";

interface Page {
  id: string;
  page: { w: number; h: number };
  image: { w: number; h: number };
  lines: PlacedLine[];
  phrase: string;
  truthBox: PageRect | null;
}

const overlap = (a: PageRect, b: PageRect) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/** Does a highlight of `p.phrase` made on the OCR layer land on the phrase? */
function highlightLands(p: Page, scale: number): { ok: boolean; why: string } {
  const ocr = ocrPageOf({ text: "", lines: p.lines }, p.image.w, p.image.h, textLayerSpans);
  if (!ocr.spans || !p.truthBox) return { ok: false, why: "no lines" };
  const host = document.createElement("div");
  Object.assign(host.style, { position: "relative", width: `${p.page.w * scale}px`, height: `${p.page.h * scale}px` });
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<OcrTextLayer spans={ocr.spans!} pageHeightPx={p.page.h * scale} />));
    const layer = host.querySelector<HTMLElement>("[data-pdf-text=ocr-layer]")!;
    const text = layerText(layer);
    if (text !== ocr.text) return { ok: false, why: "layer text differs" };
    const hits = findAll(text, p.phrase, { loose: true });
    if (!hits.length) return { ok: false, why: `phrase not recognised: ${p.phrase}` };
    // The loose match must not find the phrase anywhere else on the page.
    if (hits.length > 1) return { ok: false, why: `phrase found ${hits.length} times` };
    const hit = hits[0];
    const range = offsetsToRange(layer, hit.start, hit.end);
    if (!range) return { ok: false, why: "no range" };
    const rect = unionRect(rangePageRects(range, host.getBoundingClientRect(), scale));
    if (!rect) return { ok: false, why: "no rect" };
    const t = p.truthBox;
    const covered = overlap(rect, t) / (t.width * t.height);
    if (covered < 0.5 || rect.width > t.width * 2.5) return { ok: false, why: `misplaced: covers ${(covered * 100).toFixed(0)}%` };
    // Saved and opened again: the highlight finds its text in the layer.
    const a = createPdfAnnotation({ id: "00000000-0000-4000-8000-000000000000", source: `${p.id}.pdf`, page: 1, text, start: hit.start, end: hit.end, rect });
    const again = anchorAnnotation(a, text);
    if (!again || again.start !== hit.start) return { ok: false, why: "does not re-anchor" };
    return { ok: true, why: "" };
  } finally {
    root.unmount();
    host.remove();
  }
}

describe("W6.47 highlights on 20 scanned Hebrew PDFs", () => {
  const pages = (fixture as { pages: Page[] }).pages;

  it("the fixture is 20 scanned pages, read at the reader's OCR scale", () => {
    expect(pages).toHaveLength(20);
    expect(pages.every((p) => p.truthBox)).toBe(true);
  });

  it("a highlight lands on the phrase in at least 18 of 20, at two zoom levels", () => {
    for (const scale of [1, 1.5]) {
      const results = pages.map((p) => ({ id: p.id, ...highlightLands(p, scale) }));
      const ok = results.filter((r) => r.ok).length;
      console.log(`scale ${scale}: ${ok}/20 ` + results.filter((r) => !r.ok).map((r) => `${r.id} ${r.why}`).join("; "));
      expect(ok).toBeGreaterThanOrEqual(18);
    }
  });
});
