/**
 * Scanning printed highlights (plan W7.2): the marker and pen detection on
 * synthetic photographed pages, and the text steps after OCR.
 */
import { describe, it, expect } from "vitest";
import { detectMarks, inkOf, rgbToHsv, type Box, type Pixels } from "../highlights/scan/detect";
import { cleanIsbn, groupPassages, joinLines, pageNumberOf, scannedBook } from "../highlights/scan/text";

/** mulberry32. */
function rng(seed: number) {
  return (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296 * n;
  };
}

const INK: Record<string, [number, number, number]> = { yellow: [250, 235, 60], green: [140, 230, 120], pink: [250, 130, 190], orange: [255, 170, 70], blue: [110, 190, 245] };

interface Page {
  px: Pixels;
  /** The lines that were marked, with their colour. */
  truth: Array<{ box: Box; color: string }>;
}

/**
 * A photographed page: off-white paper with a lighting gradient and noise,
 * lines of "words" (dark blocks with gaps, like print), some lines under a
 * highlighter (multiplied over the ink), some underlined with a pen.
 */
function page(seed: number, marking = true): Page {
  const r = rng(seed);
  const w = 900;
  const h = 1200;
  const data = new Uint8ClampedArray(w * h * 4);
  const light = 0.82 + r(0.15);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const shade = light - (x / w) * 0.08 - (y / h) * 0.05;
    const n = (r(1) - 0.5) * 18;
    const i = (y * w + x) * 4;
    data[i] = 250 * shade + n;
    data[i + 1] = 246 * shade + n;
    data[i + 2] = 236 * shade + n;
    data[i + 3] = 255;
  }
  const set = (x: number, y: number, c: [number, number, number], mul = false) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    if (mul) for (let k = 0; k < 3; k++) data[i + k] = (data[i + k] * c[k]) / 255;
    else for (let k = 0; k < 3; k++) data[i + k] = c[k];
  };
  const truth: Page["truth"] = [];
  const lineH = 22 + Math.floor(r(8));
  const gap = 16 + Math.floor(r(10));
  for (let y = 80; y + lineH < h - 80; y += lineH + gap) {
    // Words: dark blocks of letter strokes.
    const x0 = 60;
    const x1 = w - 60 - Math.floor(r(200));
    for (let x = x0; x < x1; ) {
      const word = 20 + Math.floor(r(70));
      for (let xx = x; xx < Math.min(x1, x + word); xx++) {
        if (xx % 5 === 0 || xx % 5 === 1) continue; // gaps between strokes
        const top = y + 4 + Math.floor(r(4));
        for (let yy = top; yy < y + lineH - 3; yy++) set(xx, yy, [30, 30, 35]);
      }
      x += word + 10;
    }
    const roll = marking ? r(1) : 1;
    if (roll < 0.22) {
      // Highlighter over part of the line (or all of it).
      const color = Object.keys(INK)[Math.floor(r(5))];
      const hx0 = x0 + Math.floor(r(1) < 0.5 ? 0 : r((x1 - x0) / 2));
      const hx1 = Math.min(x1 + 4, hx0 + 160 + Math.floor(r(x1 - hx0)));
      const tilt = r(1) - 0.5;
      for (let xx = hx0; xx < hx1; xx++) {
        const dy = Math.round(((xx - hx0) / Math.max(1, hx1 - hx0)) * tilt * 4);
        for (let yy = y - 2 + dy; yy < y + lineH + 2 + dy; yy++) set(xx, yy, INK[color], true);
      }
      truth.push({ box: { x0: hx0, y0: y, x1: hx1, y1: y + lineH }, color });
    } else if (roll < 0.32) {
      // A pen line under the line.
      const ux0 = x0 + Math.floor(r(100));
      const ux1 = Math.min(x1, ux0 + 200 + Math.floor(r(x1 - ux0)));
      const thick = 1 + Math.floor(r(3));
      for (let xx = ux0; xx < ux1; xx++) for (let t = 0; t < thick; t++) set(xx, y + lineH + 2 + t + Math.round(Math.sin(xx / 40)), [20, 30, 120]);
      truth.push({ box: { x0: ux0, y0: y, x1: ux1, y1: y + lineH }, color: "pen" });
    }
  }
  return { px: { width: w, height: h, data }, truth };
}

const vOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) / Math.max(1, Math.min(a.y1 - a.y0, b.y1 - b.y0));
const hOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) / Math.max(1, b.x1 - b.x0);

describe("marker colours", () => {
  it("HSV and the inks", () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 1, 1]);
    expect(inkOf(250, 235, 60)).toBe("yellow");
    expect(inkOf(140, 230, 120)).toBe("green");
    expect(inkOf(250, 130, 190)).toBe("pink");
    expect(inkOf(110, 190, 245)).toBe("blue");
    // Paper, print and grey shadows are not ink.
    expect(inkOf(245, 240, 230)).toBeNull();
    expect(inkOf(30, 30, 35)).toBeNull();
    expect(inkOf(120, 120, 120)).toBeNull();
  });
});

describe("30 synthetic photographed pages", () => {
  it("≥ 90 % of the marks are found, with their colour, and almost nothing else", () => {
    let marked = 0;
    let found = 0;
    let colourRight = 0;
    let spurious = 0;
    const byKind: Record<string, [number, number]> = {};
    for (let n = 0; n < 30; n++) {
      const { px, truth } = page(1000 + n);
      const marks = detectMarks(px, { rtl: n % 2 === 0 });
      marked += truth.length;
      for (const t of truth) {
        const hit = marks.find((m) => vOverlap(m.box, t.box) > 0.5 && hOverlap(m.box, t.box) > 0.6);
        const k = (byKind[t.color === "pen" ? "pen" : "marker"] ??= [0, 0]);
        k[0]++;
        if (hit) k[1]++;
        if (hit) {
          found++;
          if (hit.color === t.color) colourRight++;
        }
      }
      spurious += marks.filter((m) => !truth.some((t) => vOverlap(m.box, t.box) > 0.3)).length;
    }
    if (found / marked < 0.9) console.log("by kind", JSON.stringify(byKind), "spurious", spurious);
    expect(marked).toBeGreaterThan(150);
    expect(found / marked).toBeGreaterThanOrEqual(0.9);
    expect(colourRight / found).toBeGreaterThanOrEqual(0.9);
    expect(spurious / marked).toBeLessThan(0.1);
  });
  it("pages with nothing marked give nothing", () => {
    for (let n = 0; n < 5; n++) expect(detectMarks(page(5000 + n, false).px)).toEqual([]);
  });
});

describe("after OCR", () => {
  it("joins hyphenated Latin lines and keeps Hebrew and capitalised compounds", () => {
    expect(joinLines(["The quick brown fox jum-", "ped over the lazy dog ."])).toBe("The quick brown fox jumped over the lazy dog.");
    expect(joinLines(["Jean-", "Paul Sartre"])).toBe("Jean-Paul Sartre");
    expect(joinLines(["שלום לכם", "וברוכים הבאים"])).toBe("שלום לכם וברוכים הבאים");
    expect(joinLines(["בית\u05BE", "ספר"])).toBe("בית\u05BEספר");
    expect(joinLines(["  a  b ", "", "c"])).toBe("a b c");
  });
  it("finds the page number in the footer or header", () => {
    expect(pageNumberOf([{ text: "Chapter 3", y: 10 }, { text: "- 127 -", y: 1180 }], 1200)).toBe(127);
    expect(pageNumberOf([{ text: "עמ׳ 45", y: 1150 }], 1200)).toBe(45);
    expect(pageNumberOf([{ text: "12", y: 20 }], 1200)).toBe(12);
    expect(pageNumberOf([{ text: "In 1984 he wrote", y: 600 }], 1200)).toBeNull();
  });
  it("groups a mark that runs over lines into one passage", () => {
    const p = groupPassages([
      { text: "first part of a long", color: "yellow", box: { x0: 0, y0: 100, x1: 500, y1: 122 } },
      { text: "highlight that goes on", color: "yellow", box: { x0: 0, y0: 140, x1: 300, y1: 162 } },
      { text: "another one", color: "yellow", box: { x0: 0, y0: 400, x1: 200, y1: 422 } },
      { text: "a pen line", color: "pen", box: { x0: 0, y0: 440, x1: 200, y1: 462 } },
    ]);
    expect(p).toEqual([
      { text: "first part of a long highlight that goes on", color: "yellow" },
      { text: "another one", color: "yellow" },
      { text: "a pen line", color: "pen" },
    ]);
  });
  it("checks ISBNs and builds the book with stable ids and the page", () => {
    expect(cleanIsbn("978-965-07-1234-?")).toBeNull();
    expect(cleanIsbn("978-0-306-40615-7")).toBe("9780306406157");
    expect(cleanIsbn("0-306-40615-2")).toBe("0306406152");
    expect(cleanIsbn("0-306-40615-3")).toBeNull();
    const b = scannedBook({ title: "ספר", author: "מחבר", isbn: "9780306406157" }, [{ text: "קטע מודגש", color: "yellow" }, { text: " ", color: "pen" }], 12, new Date("2026-11-14T10:00:00Z"));
    expect(b.source).toBe("scan");
    expect(b.link).toBe("urn:isbn:9780306406157");
    expect(b.highlights).toHaveLength(1);
    expect(b.highlights[0]).toMatchObject({ text: "קטע מודגש", location: "p. 12", color: "yellow", created: "2026-11-14T10:00:00.000Z" });
    expect(scannedBook({ title: "ספר", author: "מחבר" }, [{ text: "קטע מודגש", color: "pink" }], null).highlights[0].id).toBe(b.highlights[0].id);
  });
});
