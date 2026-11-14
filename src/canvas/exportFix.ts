/**
 * Hebrew in canvas exports (plan W1.16). Two things go wrong with
 * Excalidraw 0.18's SVG export of right-to-left text, and this fixes both
 * on the exported <svg> before it is saved, rasterised or printed:
 *
 * 1. Position. Excalidraw writes each line with `direction` set from the
 *    whole element's first strong character and `text-anchor` "end" for
 *    right-aligned *or* RTL text. `text-anchor` is logical in SVG (it follows
 *    `direction`), so a right-aligned Hebrew line is anchored at its left end
 *    on the element's right edge and runs off the drawing — the text
 *    "disappears" from the export. A Latin line inside a Hebrew element gets
 *    the wrong side too. Here every line gets its own direction and the
 *    anchor that puts it where the canvas draws it (left, centre, right).
 *
 * 2. Glyphs. Excalidraw inlines its own fonts (subset to the characters
 *    used), and none of its hand-drawn faces has Hebrew; in the app the canvas
 *    CSS supplies Assistant for the Hebrew range, but a saved SVG has only
 *    what it carries, so a viewer falls back to whatever Hebrew font it has
 *    (or none). Here Assistant is embedded, limited by unicode-range to
 *    Hebrew, under each family the Hebrew lines use.
 *
 * DOM only (DOMParser / XMLSerializer work too); no Excalidraw import.
 */

import { isRtlText } from "./noteCards";

export const HEBREW_RANGE = "U+0590-05FF, U+FB1D-FB4F";
const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/;

/** Excalidraw's font-family strings start with its family name: `Excalifont, Xiaolai, Segoe UI Emoji`. */
export function firstFamily(fontFamily: string | null): string | null {
  const f = fontFamily?.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  return f || null;
}

type Align = "left" | "center" | "right";

/** Which side Excalidraw meant for a line, from what it wrote (x is 0 / width / width÷2 for left / right / centre). */
function physicalAlign(text: Element): Align {
  const anchor = text.getAttribute("text-anchor") ?? "start";
  if (anchor === "middle") return "center";
  const x = Number(text.getAttribute("x") ?? "0");
  // Excalidraw writes x = 0 for left-aligned text and x = width for right-aligned.
  return x > 0 ? "right" : "left";
}

const ANCHOR: Record<Align, Record<"ltr" | "rtl", string>> = {
  left: { ltr: "start", rtl: "end" },
  right: { ltr: "end", rtl: "start" },
  center: { ltr: "middle", rtl: "middle" },
};

/** Fix every text line's direction and anchor in place. → the number of lines changed. */
export function fixSvgTextDirection(svg: Element): number {
  let changed = 0;
  for (const text of Array.from(svg.getElementsByTagName("text"))) {
    const line = text.textContent ?? "";
    const align = physicalAlign(text);
    const dir = isRtlText(line) ? "rtl" : "ltr";
    const anchor = ANCHOR[align][dir];
    if (text.getAttribute("direction") !== dir || (text.getAttribute("text-anchor") ?? "start") !== anchor) {
      text.setAttribute("direction", dir);
      text.setAttribute("text-anchor", anchor);
      changed++;
    }
  }
  return changed;
}

/** The font families (Excalidraw names) of the lines that have Hebrew characters. */
export function hebrewFamilies(svg: Element): string[] {
  const out = new Set<string>();
  for (const text of Array.from(svg.getElementsByTagName("text"))) {
    if (!HEBREW.test(text.textContent ?? "")) continue;
    const f = firstFamily(text.getAttribute("font-family"));
    if (f) out.add(f);
  }
  return [...out];
}

export interface EmbeddedFace {
  family: string;
  /** A `data:font/woff2;base64,…` URL. */
  src: string;
  weight?: number;
}

/** `@font-face` rules for the Hebrew range under the given families (one font file can serve several). */
export function hebrewFontFaceCss(faces: readonly EmbeddedFace[]): string {
  return faces
    .map((f) => `@font-face { font-family: ${JSON.stringify(f.family)}; src: url(${f.src}) format("woff2");${f.weight ? ` font-weight: ${f.weight};` : ""} unicode-range: ${HEBREW_RANGE}; }`)
    .join("\n");
}

/** Add the rules to the SVG's font style block (Excalidraw's `<style class="style-fonts">`), creating it if missing. */
export function embedFontFaces(svg: Element, css: string): void {
  if (!css) return;
  const ns = svg.namespaceURI ?? "http://www.w3.org/2000/svg";
  const doc = svg.ownerDocument!;
  let style = Array.from(svg.getElementsByTagName("style")).find((s) => s.classList.contains("style-fonts")) ?? null;
  if (!style) {
    let defs = Array.from(svg.children).find((c) => c.localName === "defs") ?? null;
    if (!defs) {
      defs = doc.createElementNS(ns, "defs");
      svg.insertBefore(defs, svg.firstChild);
    }
    style = doc.createElementNS(ns, "style") as Element as HTMLStyleElement;
    style.setAttribute("class", "style-fonts");
    defs.appendChild(style);
  }
  // After Excalidraw's own faces: for Hebrew code points only these match, so the order doesn't matter.
  style.textContent = `${style.textContent ?? ""}\n${css}\n`;
}

/** Excalidraw's bold display face; every other family takes the regular weight. */
export const BOLD_FAMILIES = new Set(["Lilita One"]);

/**
 * The whole fix for one exported SVG: directions and anchors, then Assistant
 * for the Hebrew lines' families (`font(bold)` gives the font file as a data
 * URL; it is only asked for when there is Hebrew).
 */
export async function fixHebrewSvg(svg: Element, font: (bold: boolean) => Promise<string | null>): Promise<{ lines: number; families: string[] }> {
  const lines = fixSvgTextDirection(svg);
  const families = hebrewFamilies(svg);
  if (!families.length) return { lines, families };
  const faces: EmbeddedFace[] = [];
  const cache = new Map<boolean, string | null>();
  for (const family of families) {
    const bold = BOLD_FAMILIES.has(family);
    if (!cache.has(bold)) cache.set(bold, await font(bold));
    const src = cache.get(bold);
    if (src) faces.push({ family, src });
  }
  embedFontFaces(svg, hebrewFontFaceCss(faces));
  return { lines, families };
}
