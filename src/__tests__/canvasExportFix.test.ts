/**
 * Plan W1.16 — Hebrew in the canvas's SVG export. The input is what
 * Excalidraw 0.18 writes for a text element (renderer/staticSvgScene.ts:
 * one <text> per line, `direction` from the element's first strong
 * character, `text-anchor` "end" for right-aligned or RTL text, x = 0 /
 * width / width÷2), rebuilt here line for line. In a browser (the layout
 * checks need one) the fix must put every line inside its element's box,
 * where the canvas draws it, and embed a Hebrew face only when needed.
 */
import { describe, it, expect } from "vitest";
import { embedFontFaces, firstFamily, fixHebrewSvg, fixSvgTextDirection, hebrewFamilies, hebrewFontFaceCss } from "../canvas/exportFix";
import { isRtlText } from "../canvas/noteCards";

const SVG_NS = "http://www.w3.org/2000/svg";
type Align = "left" | "center" | "right";
interface TextEl {
  text: string;
  align: Align;
  width: number;
  family?: string;
}

/** Excalidraw 0.18's SVG for text elements, one under the other (staticSvgScene.ts, text branch). */
function excalidrawSvg(els: TextEl[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const w = Math.max(...els.map((e) => e.width)) + 40;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(els.length * 60 + 40));
  svg.setAttribute("viewBox", `0 0 ${w} ${els.length * 60 + 40}`);
  const defs = document.createElementNS(SVG_NS, "defs");
  const style = document.createElementNS(SVG_NS, "style");
  style.setAttribute("class", "style-fonts");
  style.textContent = "";
  defs.appendChild(style);
  svg.appendChild(defs);
  els.forEach((el, i) => {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("transform", `translate(20 ${20 + i * 60}) rotate(0 0 0)`);
    g.setAttribute("data-box", `${el.width}`);
    const lines = el.text.split("\n");
    const horizontalOffset = el.align === "center" ? el.width / 2 : el.align === "right" ? el.width : 0;
    const direction = isRtlText(el.text) ? "rtl" : "ltr";
    const textAnchor = el.align === "center" ? "middle" : el.align === "right" || direction === "rtl" ? "end" : "start";
    lines.forEach((line, k) => {
      const t = document.createElementNS(SVG_NS, "text");
      t.textContent = line;
      t.setAttribute("x", `${horizontalOffset}`);
      t.setAttribute("y", `${k * 25 + 18}`);
      t.setAttribute("font-family", `${el.family ?? "Excalifont"}, Xiaolai, Segoe UI Emoji`);
      t.setAttribute("font-size", "20px");
      t.setAttribute("fill", "#1e1e1e");
      t.setAttribute("text-anchor", textAnchor);
      t.setAttribute("style", "white-space: pre;");
      t.setAttribute("direction", direction);
      t.setAttribute("dominant-baseline", "alphabetic");
      g.appendChild(t);
    });
    svg.appendChild(g);
  });
  return svg;
}

/** Each line's horizontal extent in its element's coordinates, from the browser's layout. */
function extents(svg: SVGSVGElement): Array<{ line: string; left: number; right: number; width: number; box: number }> {
  document.body.appendChild(svg);
  const out = Array.from(svg.querySelectorAll("g[data-box]")).flatMap((g) =>
    Array.from(g.querySelectorAll("text")).map((t) => {
      const b = (t as SVGTextElement).getBBox();
      return { line: t.textContent ?? "", left: b.x, right: b.x + b.width, width: b.width, box: Number(g.getAttribute("data-box")) };
    }),
  );
  svg.remove();
  return out;
}

const SLACK = 1.5;
const inside = (e: { left: number; right: number; box: number }) => e.left >= -SLACK && e.right <= e.box + SLACK;

const CASES: TextEl[] = [
  { text: "שלום עולם", align: "left", width: 300 },
  { text: "שלום עולם", align: "right", width: 300 },
  { text: "שלום עולם", align: "center", width: 300 },
  { text: "Hello world", align: "right", width: 300 },
  { text: "Hello world", align: "left", width: 300 },
  { text: "סיכום Q3!\nNext steps: 3", align: "right", width: 300 },
  { text: "Agenda:\nתקציב 2026, שיווק", align: "left", width: 300 },
];

describe("SVG export of RTL text (W1.16)", () => {
  it("Excalidraw's own output puts right-aligned Hebrew outside its box (the bug)", () => {
    const before = extents(excalidrawSvg([CASES[1]]));
    expect(before[0].width).toBeGreaterThan(20);
    expect(inside(before[0])).toBe(false);
  });

  it("after the fix every line sits inside its box, on the side the canvas draws it", () => {
    const svg = excalidrawSvg(CASES);
    expect(fixSvgTextDirection(svg)).toBeGreaterThan(0);
    const after = extents(svg);
    expect(after).toHaveLength(9);
    for (const e of after) expect(inside(e), `${e.line}: ${e.left.toFixed(1)}–${e.right.toFixed(1)} of ${e.box}`).toBe(true);
    const byLine = (s: string) => after.find((e) => e.line === s)!;
    // Left-aligned lines start at the left edge, right-aligned end at the right edge, centred are centred.
    expect(byLine("שלום עולם").left).toBeLessThan(SLACK);
    expect(after[1].right).toBeGreaterThan(300 - SLACK);
    expect(Math.abs((after[2].left + after[2].right) / 2 - 150)).toBeLessThan(SLACK);
    expect(byLine("Next steps: 3").right).toBeGreaterThan(300 - SLACK);
    expect(byLine("תקציב 2026, שיווק").left).toBeLessThan(SLACK);
    // Each line has its own base direction (the "!" stays at the Hebrew line's end, on its left).
    const texts = Array.from(svg.querySelectorAll("text"));
    expect(texts.map((t) => t.getAttribute("direction"))).toEqual(["rtl", "rtl", "rtl", "ltr", "ltr", "rtl", "ltr", "ltr", "rtl"]);
    expect(fixSvgTextDirection(svg)).toBe(0);
  });

  it("embeds a Hebrew face (unicode-range) only for the families that draw Hebrew", async () => {
    const svg = excalidrawSvg([
      { text: "שלום", align: "left", width: 200 },
      { text: "Title", align: "left", width: 200, family: "Lilita One" },
      { text: "כותרת", align: "left", width: 200, family: "Lilita One" },
      { text: "code", align: "left", width: 200, family: "Cascadia" },
    ]);
    expect(hebrewFamilies(svg)).toEqual(["Excalifont", "Lilita One"]);
    const asked: boolean[] = [];
    const res = await fixHebrewSvg(svg, async (bold) => {
      asked.push(bold);
      return `data:font/woff2;base64,${bold ? "Qk9MRA==" : "UkVH"}`;
    });
    expect(res.families).toEqual(["Excalifont", "Lilita One"]);
    expect(asked).toEqual([false, true]);
    const css = svg.querySelector("style.style-fonts")!.textContent!;
    expect(css).toContain('font-family: "Excalifont"; src: url(data:font/woff2;base64,UkVH) format("woff2"); unicode-range: U+0590-05FF, U+FB1D-FB4F;');
    expect(css).toContain('font-family: "Lilita One"; src: url(data:font/woff2;base64,Qk9MRA==)');
    expect(css).not.toContain("Cascadia");

    const latin = excalidrawSvg([{ text: "Hello", align: "left", width: 200 }]);
    const none = await fixHebrewSvg(latin, async () => {
      throw new Error("must not load a font");
    });
    expect(none.families).toEqual([]);
    expect(latin.querySelector("style")!.textContent).toBe("");
  });

  it("creates the style block when the SVG has none; survives serialising", () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    embedFontFaces(svg, hebrewFontFaceCss([{ family: "Excalifont", src: "data:font/woff2;base64,AA==" }]));
    const out = new XMLSerializer().serializeToString(svg);
    expect(out).toMatch(/^<svg[^>]*><defs><style class="style-fonts">[\s\S]*unicode-range: U\+0590-05FF/);
    expect(firstFamily('"Comic Shanns", Xiaolai')).toBe("Comic Shanns");
    expect(firstFamily(null)).toBeNull();
  });
});
