/**
 * W6.47 — scanned PDF pages read by the on-device OCR (../ai/ocr.ts), with
 * a hidden text layer laid over the page image (W1.18's line boxes), so a
 * scanned page is searched, selected and highlighted like a page with text.
 *
 * What OCR found is kept per PDF, so the next open (and the highlights made
 * on it) does not wait for OCR again: in IndexedDB, keyed by the SHA-256 of
 * the PDF's bytes (the same file on another path or device hits the same
 * entry), inside the vault's encryption boundary (../storage/vault/
 * restStore.ts: sealed in an encrypted vault, nothing written while locked).
 */

import { createStore, del, get, set } from "idb-keyval";
import type { PlacedLine, TextLayerSpan } from "../ai/ocrLayout";
import { forStore, fromStore } from "../storage/vault/restStore";
import type { PdfDocument } from "./pdfjs";

/** One recognised page: its text, and the line boxes when OCR returned them. */
export interface OcrPage {
  /** The page text search and highlights run on; with `spans`, exactly the layer's text. */
  text: string;
  /** Lines as fractions of the page (left, top, width, height), in reading order. */
  spans?: TextLayerSpan[];
}

/** The text a layer of `spans` holds: each line and a newline (what `layerText` reads back). */
export function spansText(spans: readonly TextLayerSpan[]): string {
  return spans.map((s) => `${s.text}\n`).join("");
}

/** The OCR result as a page: the text layer's text when there are lines, else the plain text. */
export function ocrPageOf(
  r: { text: string; lines?: readonly PlacedLine[] },
  width: number,
  height: number,
  toSpans: (placed: readonly PlacedLine[], width: number, height: number) => TextLayerSpan[],
): OcrPage {
  const spans = r.lines?.length ? toSpans(r.lines, width, height).filter((s) => s.text.trim()) : [];
  return spans.length ? { text: spansText(spans), spans } : { text: r.text };
}

/**
 * Pixel scale the page is rendered at for OCR: 72 dpi × 2 = 144 dpi, as the
 * reader always did. Measured on the 20 scanned Hebrew pages
 * (scripts/ocr/scanned-he/measure.mjs): CER 13.5% at 144 dpi, 20.9% at 216, on
 * tesseract's lines alone; 12.2% at 144 dpi through the app's whole path.
 */
export const OCR_SCALE = 2;

/** Render page `page` of `doc` and read it with the on-device OCR. */
export async function ocrPdfPage(doc: PdfDocument, page: number): Promise<OcrPage> {
  const p = await doc.getPage(page);
  const viewport = p.getViewport({ scale: OCR_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await p.render({ canvas, viewport }).promise;
  const [{ ocrImage }, { textLayerSpans }] = await Promise.all([import("../ai/ocr"), import("../ai/ocrLayout")]);
  return ocrPageOf(await ocrImage(canvas), canvas.width, canvas.height, textLayerSpans);
}

// ── What OCR found, kept per PDF ─────────────────────────────────────────

const LABEL = "pdf-ocr";
let store: ReturnType<typeof createStore> | null = null;
const db = () => (store ??= createStore("lumen-pdf-ocr", "pages"));

/** The key a PDF's OCR is kept under: SHA-256 of its bytes, hex. */
export async function pdfFingerprint(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Stored = Record<number, OcrPage>;

function valid(v: unknown): v is Stored {
  if (!v || typeof v !== "object") return false;
  return Object.entries(v).every(([k, p]) => /^\d+$/.test(k) && !!p && typeof (p as OcrPage).text === "string" && ((p as OcrPage).spans === undefined || Array.isArray((p as OcrPage).spans)));
}

/** The pages of this PDF read before (page number → page); empty when none or unreadable. */
export async function loadOcrPages(fingerprint: string): Promise<Stored> {
  try {
    const v = await fromStore<Stored>(LABEL, await get(fingerprint, db()));
    return valid(v) ? v : {};
  } catch {
    return {};
  }
}

/** Keep one more page of this PDF. Never throws: without the cache the page is just read again next time. */
export async function saveOcrPage(fingerprint: string, page: number, value: OcrPage): Promise<void> {
  try {
    const next = { ...(await loadOcrPages(fingerprint)), [page]: value };
    const stored = await forStore(LABEL, next);
    if (stored === undefined) return; // locked vault: write nothing
    await set(fingerprint, stored, db());
  } catch {
    /* why: quota or private mode — OCR runs again next time */
  }
}

/** Forget one PDF's OCR (tests, and a user who asks). */
export async function dropOcrPages(fingerprint: string): Promise<void> {
  await del(fingerprint, db()).catch(() => undefined);
}
