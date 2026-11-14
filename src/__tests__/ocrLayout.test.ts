/**
 * Plan W1.18 — page layout for Hebrew OCR (src/ai/ocrLayout.ts): columns are
 * read right to left on a Hebrew page, a heading above the columns comes
 * first, the text layer keeps reading order and logical text, and the word
 * order metric counts what the acceptance asks. Boxes are synthetic: x grows
 * to the right.
 */
import { describe, it, expect } from "vitest";
import { columnCount, defaultGutter, isRtlPage, layoutLines, layoutText, lineDir, lineOrderAccuracy, readingOrder, splitAtGutters, textLayerSpans, type LayoutLine } from "../ai/ocrLayout";
import type { Box } from "../ai/ocrMixed";

const b = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });
const ln = (text: string, bbox: Box): LayoutLine => ({ text: `${text}\n`, words: [], bbox });

describe("isRtlPage / lineDir", () => {
  it("decides the page's direction by its letters and a line's by its first strong letter", () => {
    expect(isRtlPage(["שלום עולם", "Zoom"])).toBe(true);
    expect(isRtlPage(["Hello world", "של"])).toBe(false);
    expect(isRtlPage(["123"])).toBe(false);
    expect(lineDir("ב-Zoom מחר")).toBe("rtl");
    expect(lineDir("Zoom בקרוב")).toBe("ltr");
    expect(lineDir("12:30 פגישה")).toBe("rtl");
  });
});

describe("readingOrder", () => {
  // A page 1000 wide: a heading across the top, two columns below, a footer across the bottom.
  const boxes = [
    b(100, 400, 470, 430), // 0: left column, line 1
    b(530, 100, 900, 130), // 1: right column, line 1
    b(100, 440, 470, 470), // 2: left column, line 2
    b(530, 140, 900, 170), // 3: right column, line 2
    b(200, 20, 900, 60), // 4: heading
    b(530, 400, 900, 430), // 5: right column, line 3 (after a paragraph gap)
    b(100, 100, 470, 130), // 6: left column, line 0
    b(100, 900, 900, 930), // 7: footer
  ];

  it("reads the heading, then the right column, then the left one, then the footer (Hebrew)", () => {
    const order = readingOrder(boxes, { rtl: true, minGutter: 45 }).map((o) => o.index);
    expect(order).toEqual([4, 1, 3, 5, 6, 0, 2, 7]);
  });

  it("reads the left column first on a Latin page", () => {
    const order = readingOrder(boxes, { rtl: false, minGutter: 45 }).map((o) => o.index);
    expect(order).toEqual([4, 6, 0, 2, 1, 3, 5, 7]);
  });

  it("keeps a single column top to bottom, whatever its lines' widths", () => {
    const one = [b(300, 200, 900, 230), b(100, 100, 900, 130), b(600, 150, 900, 180)];
    expect(readingOrder(one, { rtl: true, minGutter: 45 }).map((o) => o.index)).toEqual([1, 2, 0]);
  });

  it("does not take the space between words of one line for a gutter", () => {
    // Two boxes on the same row, 20 px apart, with the gutter at 45: one line's parts, read right to left.
    const row = [b(100, 100, 480, 130), b(500, 100, 900, 130)];
    expect(readingOrder(row, { rtl: true, minGutter: 45 }).map((o) => o.index)).toEqual([1, 0]);
  });
});

describe("layoutLines / layoutText", () => {
  it("orders a two-column Hebrew page and separates the columns with a blank line", () => {
    const lines = [ln("שמאל א", b(100, 100, 470, 130)), ln("ימין א", b(530, 100, 900, 130)), ln("שמאל ב", b(100, 140, 470, 170)), ln("ימין ב", b(530, 140, 900, 170)), ln("כותרת", b(300, 20, 900, 60))];
    const placed = layoutLines(lines, lines.map((l) => l.text));
    expect(placed.map((p) => p.text)).toEqual(["כותרת", "ימין א", "ימין ב", "שמאל א", "שמאל ב"]);
    expect(columnCount(placed)).toBe(2);
    expect(layoutText(placed)).toBe("כותרת\nימין א\nימין ב\n\nשמאל א\nשמאל ב");
  });

  it("uses the fixed logical text it is given, drops empty lines, and takes the words' box without a line box", () => {
    const words = [{ text: "Zoom", bbox: b(100, 10, 160, 30), confidence: 90, symbols: [] }, { text: "ב-", bbox: b(170, 10, 190, 30), confidence: 90, symbols: [] }];
    const lines: LayoutLine[] = [{ text: "Zoom ב-\n", words }, ln("", b(0, 50, 10, 60))];
    const placed = layoutLines(lines, ["ב-Zoom", ""]);
    expect(placed).toEqual([{ text: "ב-Zoom", bbox: b(100, 10, 190, 30), column: 0 }]);
  });
});

describe("textLayerSpans", () => {
  it("gives each line a span in page fractions, in reading order, with its direction", () => {
    const placed = layoutLines([ln("Zoom בקרוב", b(100, 100, 470, 130)), ln("פגישה ב-Zoom", b(530, 100, 900, 130))], ["Zoom בקרוב", "פגישה ב-Zoom"]);
    const spans = textLayerSpans(placed, 1000, 500);
    expect(spans.map((s) => [s.text, s.dir])).toEqual([
      ["פגישה ב-Zoom", "rtl"],
      ["Zoom בקרוב", "ltr"],
    ]);
    expect(spans[0]).toMatchObject({ left: 0.53, top: 0.2, height: 0.06 });
    expect(spans[0].width).toBeCloseTo(0.37, 5);
    expect(textLayerSpans(placed, 0, 500)).toEqual([]);
  });
});

describe("lineOrderAccuracy", () => {
  it("counts a line right when the words it shares with its best match come in order", () => {
    const ref = "בדיקת Wi-Fi ו-Bluetooth.\nקובץ ה-PDF מצורף";
    expect(lineOrderAccuracy(ref, ref)).toEqual({ correct: 2, total: 2 });
    // A misread word is not an order error.
    expect(lineOrderAccuracy(ref, "בדיקת Wi-Fi ו-Bluetooth.\nקובץ ה-PDE מצורף")).toEqual({ correct: 2, total: 2 });
    // Visual order of a Latin run is.
    expect(lineOrderAccuracy(ref, "בדיקת ו-Bluetooth Wi-Fi\nקובץ ה-PDF מצורף")).toEqual({ correct: 1, total: 2 });
  });

  it("counts lines read out of order, and lines mostly not found, as wrong", () => {
    const ref = "שורה ראשונה כאן\nשורה שנייה שם\nשלישית לגמרי אחרת";
    expect(lineOrderAccuracy(ref, "שורה שנייה שם\nשורה ראשונה כאן\nשלישית לגמרי אחרת")).toEqual({ correct: 2, total: 3 });
    expect(lineOrderAccuracy(ref, "שורה ראשונה כאן\nשורה שנייה שם")).toEqual({ correct: 2, total: 3 });
  });
});

describe("splitAtGutters", () => {
  const w = (text: string, x0: number, x1: number) => ({ text, bbox: b(x0, 10, x1, 30), confidence: 90, symbols: [] });

  it("cuts a line tesseract ran across a gutter, right piece first on a Hebrew page", () => {
    const l: LayoutLine = { text: "ימי של המגמה\n", words: [w("ימי", 860, 900), w("של", 420, 450), w("המגמה", 340, 410)] };
    const gutter = defaultGutter([l]);
    expect(gutter).toBe(30);
    const out = splitAtGutters([l], gutter, true);
    expect(out.map((x) => x.text)).toEqual(["ימי\n", "של המגמה\n"]);
    expect(out[1].words.map((x) => x.text)).toEqual(["של", "המגמה"]);
  });

  it("leaves a line with ordinary word spaces alone", () => {
    const l: LayoutLine = { text: "של המגמה\n", words: [w("של", 420, 450), w("המגמה", 340, 410)] };
    expect(splitAtGutters([l], 30, true)).toEqual([l]);
  });
});
