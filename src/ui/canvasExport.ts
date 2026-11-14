/**
 * PNG / SVG / PDF export of a canvas with Hebrew that survives (plan W1.16).
 * Loaded with the canvas (it imports Excalidraw's export functions, already
 * in the canvas chunk).
 *
 * - Note cards (./noteCards) are drawn as their note's title and first
 *   lines, so the export shows what the canvas shows.
 * - SVG: Excalidraw's export, then ./exportFix (each line's direction and
 *   anchor; Assistant embedded for the Hebrew range).
 * - PNG: Excalidraw's canvas renderer (it aligns by physical side, so RTL
 *   lines are placed right), after the Hebrew faces the canvas CSS declares
 *   are loaded — otherwise the first export draws Hebrew in a system font.
 * - PDF: the fixed SVG printed on a page of its own size ("Save as PDF").
 *
 * Everything stays on the device: the fonts come from this origin.
 *
 * In src/ui, not src/canvas: it calls Excalidraw's exporters, and the canvas
 * modules import nothing from outside src/ (tldrawToExcalidraw.test).
 */

import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import { cardsForExport, noteExcerpt, notePathOf, noteTitle, type CardContent } from "../canvas/noteCards";
import { BOLD_FAMILIES, fixHebrewSvg } from "../canvas/exportFix";
import type { SceneAppState, SceneElement } from "../canvas/excalidrawScene";
import type { ExBinaryFile, ExcalidrawElement } from "../canvas/tldrawToExcalidraw";

export type ExportKind = "png" | "svg" | "pdf";

export interface ExportScene {
  elements: readonly SceneElement[];
  appState: SceneAppState;
  files: Record<string, ExBinaryFile>;
}

const HEBREW = /[֐-׿יִ-ﭏ]/;
const fontUrl = (bold: boolean) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/excalidraw/fonts/Assistant/Assistant-${bold ? "Bold" : "Regular"}.woff2`;

async function dataUrlOf(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^;,]*/, "data:font/woff2"));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Title and excerpt of every note card in the scene (read once each). */
export async function cardContents(elements: readonly SceneElement[], read: (path: string) => Promise<string | null>): Promise<Map<string, CardContent>> {
  const out = new Map<string, CardContent>();
  const paths = [...new Set(elements.map((e) => notePathOf(e as unknown as ExcalidrawElement)).filter((p): p is string => !!p))];
  await Promise.all(
    paths.map(async (p) => {
      const md = await read(p).catch(() => null);
      if (md !== null) out.set(p, { title: noteTitle(p, md), excerpt: noteExcerpt(md) });
    }),
  );
  return out;
}

/** Excalidraw family names (by font id) — the ones the canvas CSS gives a Hebrew face. */
const FAMILY_BY_ID: Record<number, string> = { 1: "Virgil", 3: "Cascadia", 5: "Excalifont", 6: "Nunito", 7: "Lilita One", 8: "Comic Shanns", 9: "Liberation Sans" };

/** Load the Hebrew faces of the families the scene's Hebrew text uses (the canvas CSS declares them). */
async function loadHebrewFaces(elements: readonly ExcalidrawElement[]): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const families = new Set<string>();
  for (const el of elements) if (el.type === "text" && HEBREW.test(el.text)) families.add(FAMILY_BY_ID[el.fontFamily] ?? "Excalifont");
  await Promise.all([...families].map((f) => document.fonts.load(`${BOLD_FAMILIES.has(f) ? "bold " : ""}20px "${f}"`, "אבג").catch(() => [])));
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  /** The fixed SVG element (SVG and PDF). */
  svg?: SVGSVGElement;
}

/** The scene as a PNG or an SVG (the PDF is the SVG, printed). */
export async function exportCanvas(kind: ExportKind, scene: ExportScene, name: string, read: (path: string) => Promise<string | null>): Promise<ExportResult> {
  const contents = await cardContents(scene.elements, read);
  const elements = cardsForExport(scene.elements as unknown as ExcalidrawElement[], (p) => contents.get(p) ?? null).filter((e) => !(e as { isDeleted?: boolean }).isDeleted);
  const appState = { ...scene.appState, exportBackground: true, exportWithDarkMode: false, exportEmbedScene: false } as Record<string, unknown>;
  const input = { elements: elements as never, appState: appState as never, files: scene.files as never, exportPadding: 16 };
  if (kind === "png") {
    await loadHebrewFaces(elements);
    const blob = await exportToBlob({ ...input, mimeType: "image/png", getDimensions: (w: number, h: number) => ({ width: w * 2, height: h * 2, scale: 2 }) });
    return { blob, fileName: `${name}.png` };
  }
  const svg = await exportToSvg(input);
  await fixHebrewSvg(svg, (bold) => dataUrlOf(fontUrl(bold)));
  const text = new XMLSerializer().serializeToString(svg);
  return { blob: new Blob([text], { type: "image/svg+xml" }), fileName: `${name}.svg`, svg };
}

export function download(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = result.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Print the fixed SVG on one page of its size, so "Save as PDF" gives the drawing with its Hebrew as text. */
export async function printSvgAsPdf(svg: SVGSVGElement, title: string): Promise<void> {
  const w = Number(svg.getAttribute("width")) || 1000;
  const h = Number(svg.getAttribute("height")) || 800;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;inset-inline-start:-10000px;inset-block-start:0;width:10px;height:10px;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  // Built with DOM calls (no HTML strings: the app enforces Trusted Types).
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent = `@page{size:${w}px ${h}px;margin:0}html,body{margin:0}svg{display:block;width:${w}px;height:${h}px}`;
  doc.head.appendChild(style);
  doc.body.appendChild(doc.importNode(svg, true));
  await doc.fonts?.ready;
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 60_000);
}
