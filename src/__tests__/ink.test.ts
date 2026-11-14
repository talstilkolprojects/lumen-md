/**
 * Handwriting in a note (plan W5.27): the ink block's Markdown form
 * round-trips byte for byte, stays a valid CommonMark HTML block next to
 * Hebrew and English text, is placed by the text's direction, and the palm
 * rejection / eraser rules hold.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Html } from "mdast";
import {
  cropInk,
  findInkBlocks,
  fmt,
  inkBlockAt,
  parseInk,
  placementStyle,
  replaceInkBlock,
  roundPoint,
  textDirAt,
  toInsertion,
  toMarkdown,
  type Ink,
} from "../ink/inkModel";
import { strokeOutline } from "../ink/inkPath";
import { PalmGate, PALM_MS, isEraser } from "../ink/palmGate";
import { strokesHit } from "../ink/eraser";
import { splitBlocks } from "../renderer/blocks";

const DIR = join(__dirname, "fixtures", "ink");
const GOLDENS = readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const mdast = (md: string) => unified().use(remarkParse).parse(md) as Root;

function line(n: number, pen: boolean): Ink["strokes"][number] {
  const points = [];
  for (let i = 0; i < n; i++) points.push(roundPoint(20 + i * 3.37, 40 + Math.cos(i / 4) * 9.123, pen ? 0.2 + i / (2 * n) : 0.5));
  return { points, size: 4, color: "#1D4ED8", simulated: !pen };
}

describe("ink goldens (W5.27): the note is valid Markdown and round-trips", () => {
  it("has the goldens", () => {
    expect(GOLDENS).toEqual(["en-side.md", "hand-svg.md", "he-block.md", "mixed.md"]);
  });

  for (const f of GOLDENS) {
    it(`${f}: every ink block parses and serializes back to the same bytes`, () => {
      const md = read(f);
      const blocks = findInkBlocks(md);
      expect(blocks.length).toBeGreaterThan(0);
      let rebuilt = md;
      for (const b of [...blocks].reverse()) {
        const ink = parseInk(md.slice(b.start, b.end));
        expect(ink?.id).toBe(b.id);
        rebuilt = replaceInkBlock(rebuilt, b, ink!);
      }
      expect(rebuilt).toBe(md);
    });

    it(`${f}: CommonMark reads each ink as one HTML block, and the text around it is unchanged`, () => {
      const md = read(f);
      const tree = mdast(md);
      const html = tree.children.filter((n): n is Html => n.type === "html" && n.value.includes("data-lumen-ink"));
      const blocks = findInkBlocks(md);
      expect(html.map((h) => h.value)).toEqual(blocks.map((b) => md.slice(b.start, b.end)));
      // The same document without the ink blocks has the same other nodes.
      let bare = md;
      for (const b of [...blocks].reverse()) bare = bare.slice(0, b.start) + bare.slice(b.end);
      const kinds = (r: Root) => r.children.filter((n) => !(n.type === "html" && n.value.includes("data-lumen-ink"))).map((n) => n.type);
      expect(kinds(tree)).toEqual(kinds(mdast(bare)));
    });

    it(`${f}: the incremental preview keeps each ink in one block`, () => {
      const md = read(f);
      const { blocks } = splitBlocks(md, { preview: true });
      for (const ink of findInkBlocks(md)) {
        expect(blocks.some((b) => b.start <= ink.start && b.end >= ink.end)).toBe(true);
      }
    });
  }

  it("mixed.md: an ink-looking SVG inside a code fence is not an ink block", () => {
    const ids = findInkBlocks(read("mixed.md")).map((b) => b.id);
    expect(ids).toEqual(["mx03aaaa", "mx04bbbb"]);
  });

  it("hand-svg.md: a path without pen samples is kept verbatim", () => {
    const md = read("hand-svg.md");
    const [b] = findInkBlocks(md);
    const ink = parseInk(md.slice(b.start, b.end))!;
    expect(ink.strokes).toEqual([{ points: [], simulated: true, size: 0, color: "#1f2937", d: "M10,10 L110,50 L100,55 Z" }]);
    expect(cropInk(ink)).toBe(ink);
  });

  it("mixed.md: quotes, & and <> in the label are escaped and come back", () => {
    const md = read("mixed.md");
    const [b] = findInkBlocks(md);
    expect(md.slice(b.start, b.end)).toContain('aria-label="סקיצה &quot;ראשונה&quot; &amp; &lt;שנייה&gt;"');
    expect(parseInk(md.slice(b.start, b.end))!.label).toBe('סקיצה "ראשונה" & <שנייה>');
  });
});

describe("ink model (W5.27)", () => {
  const drawn = (): Ink => ({ id: "t1", width: 700, height: 400, dir: "rtl", placement: "block", label: "כתב יד", strokes: [line(40, true), line(25, false)] });

  it("a drawn ink survives toMarkdown → parseInk unchanged (after cropping)", () => {
    const ink = cropInk(drawn());
    const back = parseInk(toMarkdown(ink))!;
    expect(back).toEqual({ ...ink, strokes: ink.strokes.map((s) => ({ ...s, color: s.color.toLowerCase() })) });
    expect(toMarkdown(back)).toBe(toMarkdown(ink));
  });

  it("cropping fits the box to the strokes with 8 units of margin, and is stable", () => {
    const ink = cropInk(drawn());
    const xs = ink.strokes.flatMap((s) => s.points.map((p) => p.x - s.size / 2));
    const ys = ink.strokes.flatMap((s) => s.points.map((p) => p.y - s.size / 2));
    expect(Math.abs(Math.min(...xs) - 8)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(Math.min(...ys) - 8)).toBeLessThanOrEqual(0.5);
    expect(ink.width).toBeLessThan(700);
    expect(cropInk(ink)).toEqual(ink);
  });

  it("the block has no blank line and starts with a complete <svg …> tag alone on its line", () => {
    const md = toMarkdown(cropInk(drawn()));
    expect(md).not.toMatch(/\n[ \t]*\n/);
    expect(md.split("\n")[0]).toMatch(/^<svg [^<>]*>$/);
    expect(md.endsWith("</svg>")).toBe(true);
    expect(toInsertion(cropInk(drawn()))).toBe(`\n\n${md}\n\n`);
  });

  it("pressure is stored for a pen and left out for simulated strokes", () => {
    const md = toMarkdown(cropInk(drawn()));
    const pts = [...md.matchAll(/data-ink-pts="([^"]*)"/g)].map((m) => m[1].split(" ")[0].split(",").length);
    expect(pts).toEqual([3, 2]);
  });

  it("pressure changes the outline (a pen stroke is not a constant-width line)", () => {
    const pen = line(30, true);
    const flat = { ...pen, points: pen.points.map((p) => ({ ...p, p: 0.5 })) };
    expect(strokeOutline(pen)).not.toBe(strokeOutline(flat));
    expect(strokeOutline(pen)).toMatch(/^M[\d.,-]+ Q.* T.*Z$/);
    // A tap is a dot, not an empty path.
    expect(strokeOutline({ points: [{ x: 5, y: 5, p: 0.5 }], size: 4, simulated: false })).toMatch(/^M[\d.,-]+ .+Z$/);
  });

  it("placement: own line at the start edge, or beside the text at the end edge, by the text's direction", () => {
    expect(placementStyle({ dir: "rtl", placement: "block" })).toContain("margin-left:auto");
    expect(placementStyle({ dir: "ltr", placement: "block" })).toContain("margin-right:auto");
    expect(placementStyle({ dir: "rtl", placement: "side" })).toContain("float:left");
    expect(placementStyle({ dir: "ltr", placement: "side" })).toContain("float:right");
    for (const s of [placementStyle({ dir: "rtl", placement: "side" }), placementStyle({ dir: "ltr", placement: "block" })]) {
      // The preview's sanitizer keeps it (no url(), no fixed position).
      expect(s).not.toMatch(/url\(|position/);
    }
  });

  it("the text direction comes from the paragraph before the cursor", () => {
    const md = "---\ntitle: notes\n---\n\nשלום עולם\n\nHello world\n\n";
    expect(textDirAt(md, md.indexOf("Hello"), "ltr")).toBe("rtl");
    expect(textDirAt(md, md.length, "rtl")).toBe("ltr");
    expect(textDirAt("", 0, "rtl")).toBe("rtl");
    expect(textDirAt("\n\n1234\n\nمرحبا", 2, "ltr")).toBe("rtl");
  });

  it("finds the block under the cursor; an emptied ink is removed with its blank lines", () => {
    const md = read("he-block.md");
    const [b] = findInkBlocks(md);
    expect(inkBlockAt(md, b.start + 10)?.id).toBe("he01blok");
    expect(inkBlockAt(md, 3)).toBeNull();
    const ink = parseInk(md.slice(b.start, b.end))!;
    expect(replaceInkBlock(md, b, { ...ink, strokes: [] })).toBe(
      "# שיעור 3: מבוא לאלגוריתמים\n\nהמרצה הסביר את רעיון החיפוש הבינארי.\n\nבסוף השיעור: תרגיל בית לשבוע הבא.\n",
    );
  });

  it("not an ink: other SVGs, a missing size, a broken sample list", () => {
    expect(parseInk('<svg viewBox="0 0 10 10"></svg>')).toBeNull();
    expect(parseInk('<svg data-lumen-ink="1"></svg>')).toBeNull();
    const bad = parseInk('<svg data-lumen-ink="1" width="10" height="10">\n<path fill="#000000" d="M0,0Z" data-ink-size="2" data-ink-pts="1,2,3 4,5"/>\n</svg>')!;
    // Mixed sample shapes: not trusted as samples, the drawn path is kept.
    expect(bad.strokes).toEqual([{ points: [], simulated: true, size: 0, color: "#000000", d: "M0,0Z" }]);
  });

  it("numbers are written short and stable", () => {
    expect([fmt(1), fmt(1.25), fmt(-0.01), fmt(10.04), fmt(0.456, 2)]).toEqual(["1", "1.3", "0", "10", "0.46"]);
  });
});

describe("palm rejection (W5.27)", () => {
  const pen = { pointerId: 1, pointerType: "pen" };
  const touch = (id: number) => ({ pointerId: id, pointerType: "touch" });

  it("a finger draws until a pen is used; then only with the 'draw with a finger' choice", () => {
    const g = new PalmGate();
    expect(g.down(touch(10), 0).draw).toBe(true);
    g.up(touch(10), 10);
    expect(g.down(pen, 100).draw).toBe(true);
    g.up(pen, 200);
    expect(g.down(touch(11), 200 + PALM_MS + 1).draw).toBe(false);
    g.up(touch(11), 2000);
    g.fingerDraws = true;
    expect(g.down(touch(12), 3000).draw).toBe(true);
  });

  it("a touch while the pen is down, or just after it lifts, is a palm", () => {
    const g = new PalmGate();
    g.fingerDraws = true;
    g.down(pen, 0);
    expect(g.down(touch(20), 5)).toEqual({ draw: false, cancel: [] });
    g.up(touch(20), 6);
    g.up(pen, 100);
    expect(g.down(touch(21), 100 + PALM_MS - 1).draw).toBe(false);
    g.up(touch(21), 700);
    expect(g.down(touch(22), 100 + PALM_MS + 50).draw).toBe(true);
  });

  it("the palm that landed first is cancelled when the pen comes down", () => {
    const g = new PalmGate();
    expect(g.down(touch(30), 0).draw).toBe(true);
    expect(g.down(pen, 20)).toEqual({ draw: true, cancel: [30] });
  });

  it("a second finger (pinch, scroll) cancels the first finger's stroke", () => {
    const g = new PalmGate();
    expect(g.down(touch(40), 0).draw).toBe(true);
    expect(g.down(touch(41), 30)).toEqual({ draw: false, cancel: [40] });
  });

  it("a mouse always draws; the pen's eraser end erases", () => {
    const g = new PalmGate();
    g.down(pen, 0);
    expect(g.down({ pointerId: 50, pointerType: "mouse" }, 1).draw).toBe(true);
    expect(isEraser({ pointerType: "pen", buttons: 32, button: -1 })).toBe(true);
    expect(isEraser({ pointerType: "pen", buttons: 1, button: 5 })).toBe(true);
    expect(isEraser({ pointerType: "pen", buttons: 1, button: 0 })).toBe(false);
    expect(isEraser({ pointerType: "mouse", buttons: 32, button: 5 })).toBe(false);
  });
});

describe("stroke eraser (W5.27)", () => {
  it("removes only the strokes the eraser passes over", () => {
    const a = { points: [roundPoint(0, 0, 0.5), roundPoint(100, 0, 0.5)], size: 4, color: "#000000", simulated: true };
    const b = { points: [roundPoint(0, 50, 0.5), roundPoint(100, 50, 0.5)], size: 4, color: "#000000", simulated: true };
    const dot = { points: [roundPoint(200, 200, 0.5)], size: 4, color: "#000000", simulated: true };
    const fixed = { points: [], size: 0, color: "#000000", simulated: true, d: "M0,0Z" };
    expect(strokesHit([a, b, dot, fixed], 50, 5, 4)).toEqual([0]);
    expect(strokesHit([a, b, dot, fixed], 50, 25, 4)).toEqual([]);
    expect(strokesHit([a, b, dot, fixed], 203, 200, 2)).toEqual([2]);
  });
});
