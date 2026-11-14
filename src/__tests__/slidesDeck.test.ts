/**
 * Plan W2.17 — slides: 10 golden notes give the right slides (titles,
 * direction, speaker notes, content), navigation follows the deck's
 * direction, and canvas frames become slides in arrow order.
 */
import { describe, it, expect } from "vitest";
import { framesToDeck, noteToDeck, slideForKey, splitNoteSlides, takeNotes, type CanvasElementLike } from "../slides/deck";
import { SLIDE_GOLDEN } from "./fixtures/slideNotes";

describe("note → slides: 10 golden notes (W2.17)", () => {
  it("there are 10", () => expect(SLIDE_GOLDEN).toHaveLength(10));
  for (const g of SLIDE_GOLDEN) {
    it(g.id, () => {
      const deck = noteToDeck(g.md, "Fallback");
      expect(deck.slides.map((s) => ({ title: s.title, dir: s.dir, notes: s.notes, first: s.markdown.split("\n")[0] }))).toEqual(g.slides);
      expect(deck.slides.map((s) => s.index)).toEqual(g.slides.map((_, i) => i));
      for (const s of deck.slides) expect(s.markdown).not.toMatch(/^(?:notes?|הערות)\s*:/im);
    });
  }

  it("the deck takes its title and direction from the frontmatter or its first slide", () => {
    expect(noteToDeck(SLIDE_GOLDEN[6].md)).toMatchObject({ title: "Deck", dir: "rtl" });
    expect(noteToDeck(SLIDE_GOLDEN[0].md)).toMatchObject({ title: "תוכנית הרבעון", dir: "rtl" });
    expect(noteToDeck(SLIDE_GOLDEN[1].md, "Talk").dir).toBe("ltr");
  });

  it("notes inside a code block are not notes; text before Note: stays", () => {
    expect(takeNotes("# A\n\n```\nNote: code\n```\nNote: real")).toEqual({ markdown: "# A\n\n```\nNote: code\n```", notes: "real" });
    expect(splitNoteSlides("a\n\n- - -\n\nb")).toEqual(["a", "b"]);
  });
});

describe("navigation (W2.17)", () => {
  it("arrows follow the deck's direction; other keys are the same both ways", () => {
    expect(slideForKey("ArrowRight", 2, 5, "ltr")).toBe(3);
    expect(slideForKey("ArrowRight", 2, 5, "rtl")).toBe(1);
    expect(slideForKey("ArrowLeft", 2, 5, "rtl")).toBe(3);
    expect(slideForKey(" ", 4, 5, "rtl")).toBe(4);
    expect(slideForKey("PageUp", 0, 5, "ltr")).toBe(0);
    expect(slideForKey("End", 0, 5, "ltr")).toBe(4);
    expect(slideForKey("Home", 3, 5, "rtl")).toBe(0);
    expect(slideForKey("x", 1, 5, "ltr")).toBeNull();
  });
});

const el = (id: string, type: string, x: number, y: number, w = 400, h = 300, extra: Partial<CanvasElementLike> = {}): CanvasElementLike => ({ id, type, x, y, width: w, height: h, ...extra });

describe("canvas frames → slides (W2.17)", () => {
  it("arrows give the order; unreached frames follow in reading order (right to left on a Hebrew canvas)", () => {
    const els = [
      el("f1", "frame", 0, 0, 400, 300, { name: "פתיחה" }),
      el("f2", "frame", 500, 0, 400, 300, { name: "בעיה" }),
      el("f3", "frame", 0, 400, 400, 300, { name: "פתרון" }),
      el("f4", "frame", 500, 400, 400, 300, { name: "סיכום" }),
      el("t1", "text", 20, 450, 100, 20, { text: "הערות: להדגים חי", frameId: "f3" }),
      el("t2", "text", 20, 30, 100, 20, { text: "שלום", frameId: "f1" }),
      // f1 → f3 (through an element inside f3), f3 → f4.
      el("a1", "arrow", 400, 150, 10, 300, { startBinding: { elementId: "f1" }, endBinding: { elementId: "t1" } }),
      el("a2", "arrow", 400, 550, 100, 0, { startBinding: { elementId: "f3" }, endBinding: { elementId: "f4" } }),
    ];
    const deck = framesToDeck(els);
    // Reading order on a Hebrew canvas: top row right to left (f2, f1). f2 has no incoming arrow and comes first;
    // f1 starts the chain f1 → f3 → f4.
    expect(deck.map((s) => s.frameId)).toEqual(["f2", "f1", "f3", "f4"]);
    expect(deck.find((s) => s.frameId === "f3")).toMatchObject({ title: "פתרון", notes: "להדגים חי", noteElementIds: ["t1"], dir: "rtl" });
  });

  it("without arrows: reading order; LTR canvas left to right; deleted frames and no frames", () => {
    const els = [el("b", "frame", 500, 10, 400, 300, { name: "B" }), el("a", "frame", 0, 0, 400, 300, { name: "A" }), el("c", "frame", 0, 500, 400, 300, { name: "C" }), el("d", "frame", 0, 900, 10, 10, { isDeleted: true })];
    expect(framesToDeck(els).map((s) => s.title)).toEqual(["A", "B", "C"]);
    expect(framesToDeck([el("r", "rectangle", 0, 0)])).toEqual([]);
  });

  it("a cycle of arrows still lists every frame once", () => {
    const els = [el("a", "frame", 0, 0), el("b", "frame", 500, 0), el("x", "arrow", 0, 0, 1, 1, { startBinding: { elementId: "a" }, endBinding: { elementId: "b" } }), el("y", "arrow", 0, 0, 1, 1, { startBinding: { elementId: "b" }, endBinding: { elementId: "a" } })];
    expect(framesToDeck(els).map((s) => s.frameId)).toEqual(["a", "b"]);
  });
});
