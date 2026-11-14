import { describe, it, expect } from "vitest";
import {
  NOTE_END,
  NOTE_START,
  anchorAnnotation,
  anchorTextQuote,
  companionNotePath,
  createPdfAnnotation,
  createTextQuoteSelector,
  describeAnnotation,
  encodeWikiPath,
  findAll,
  nextMatchIndex,
  highlightLinkTarget,
  normalizeWithMap,
  pageFragment,
  parseAnnotationsNote,
  parsePdfFragment,
  readAnnotationsNote,
  renderAnnotationsBlock,
  shortId,
  unionRect,
  upsertAnnotationsNote,
  withNote,
  type NoteLabels,
} from "../pdf/annotations";
import { boundaryOffset, layerText, offsetsToRange, pageTextFromItems, rangeToOffsets } from "../pdf/textMap";
import { resolveWikiTarget } from "../renderer/wikiLinks";

/** Plan 4.14 — PDF highlights as W3C Web Annotations, and finding them again. */

const PAGE = "Page two holds the passage to highlight.\nהמשפט בעברית לסימון בעמוד השני.\n\nLumen fixture, page 2 of 3.";
const at = (text: string, s: string) => {
  const start = text.indexOf(s);
  return { start, end: start + s.length };
};
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const labels: NoteLabels = { title: "Highlights — bilingual.pdf", page: (n) => `p. ${n}`, empty: "_No highlights yet._" };

describe("createTextQuoteSelector", () => {
  it("keeps the exact text and up to 32 characters of context on each side", () => {
    const { start, end } = at(PAGE, "passage to highlight");
    const q = createTextQuoteSelector(PAGE, start, end);
    expect(q).toEqual({
      type: "TextQuoteSelector",
      exact: "passage to highlight",
      prefix: "Page two holds the ",
      suffix: PAGE.slice(end, end + 32),
    });
    expect(q.suffix).toHaveLength(32);
  });

  it("omits empty context at the edges of the page, and orders reversed offsets", () => {
    const q = createTextQuoteSelector("hello world", 5, 0);
    expect(q).toEqual({ type: "TextQuoteSelector", exact: "hello", suffix: " world" });
  });
});

describe("anchorTextQuote", () => {
  const q = (() => {
    const { start, end } = at(PAGE, "passage to highlight");
    return createTextQuoteSelector(PAGE, start, end);
  })();

  it("finds the quote where it was", () => {
    expect(anchorTextQuote(PAGE, q)).toEqual({ ...at(PAGE, "passage to highlight"), match: "exact" });
  });

  it("uses prefix and suffix to pick between repeats of the same words", () => {
    const text = "the cat sat. the cat ran. the cat sat again";
    const second = createTextQuoteSelector(text, 13, 20);
    expect(anchorTextQuote(text, second)).toEqual({ start: 13, end: 20, match: "exact" });
    const third = createTextQuoteSelector(text, 26, 33);
    expect(anchorTextQuote(text, third)).toEqual({ start: 26, end: 33, match: "exact" });
  });

  it("still resolves when the text layer splits lines or spaces differently", () => {
    const changed = PAGE.replace("passage to highlight", "passage  to\nhighlight");
    const a = anchorTextQuote(changed, q);
    expect(a?.match).toBe("normalized");
    expect(changed.slice(a!.start, a!.end)).toBe("passage  to\nhighlight");
  });

  it("still resolves when text moved: a new line above shifts every offset", () => {
    const moved = `Running header, added later\n${PAGE}`;
    const a = anchorTextQuote(moved, q, at(PAGE, "passage").start);
    expect(a?.match).toBe("exact");
    expect(moved.slice(a!.start, a!.end)).toBe("passage to highlight");
  });

  it("still resolves when a few characters of the quote changed (approximate match)", () => {
    const typo = PAGE.replace("passage to highlight", "pasage to highlihgt");
    const a = anchorTextQuote(typo, q);
    expect(a?.match).toBe("fuzzy");
    expect(typo.slice(a!.start, a!.end)).toBe("pasage to highlihgt");
  });

  it("ignores Hebrew niqqud, bidi controls and case", () => {
    const { start, end } = at(PAGE, "בעברית לסימון");
    const hq = createTextQuoteSelector(PAGE, start, end);
    const pointed = PAGE.replace("בעברית", "בְּעִבְרִית").replace("לסימון", "‏לסימון");
    const a = anchorTextQuote(pointed, hq);
    expect(a?.match).toBe("normalized");
    expect(pointed.slice(a!.start, a!.end)).toBe("בְּעִבְרִית ‏לסימון");
    const upper = PAGE.toUpperCase();
    expect(upper.slice(anchorTextQuote(upper, q)!.start, anchorTextQuote(upper, q)!.end)).toBe("PASSAGE TO HIGHLIGHT");
  });

  it("doesn't match a short quote approximately (one edit would match almost anything)", () => {
    const text = "a b c d e f";
    expect(anchorTextQuote(text, { type: "TextQuoteSelector", exact: "x" })).toBeNull();
    expect(anchorTextQuote(text, { type: "TextQuoteSelector", exact: "a b c x" })).toBeNull();
  });

  it("gives up when the quote isn't on the page", () => {
    expect(anchorTextQuote(PAGE, { type: "TextQuoteSelector", exact: "a sentence that is not there at all" })).toBeNull();
    expect(anchorTextQuote(PAGE, { type: "TextQuoteSelector", exact: "" })).toBeNull();
  });

  it("anchors a long quote by its two ends", () => {
    const long = "word ".repeat(80) + "the end";
    const text = `intro ${long} outro`;
    const sel = createTextQuoteSelector(text, 6, 6 + long.length);
    const edited = text.replace("word word word", "word wrd word");
    const a = anchorTextQuote(edited, sel);
    expect(a?.match).toBe("fuzzy");
    expect(edited.slice(a!.start, a!.end).endsWith("the end")).toBe(true);
  });
});

describe("normalizeWithMap / findAll", () => {
  it("maps every folded character back to the original text", () => {
    const n = normalizeWithMap("  A­b  \n c ");
    expect(n.text).toBe("ab c");
    expect(n.map).toEqual([2, 4, 5, 9, 11]);
  });

  it("finds every match, case and spacing insensitively, as original offsets", () => {
    expect(findAll(PAGE, "PAGE")).toEqual([
      { start: 0, end: 4 },
      { start: PAGE.lastIndexOf("page"), end: PAGE.lastIndexOf("page") + 4 },
    ]);
    expect(findAll(PAGE, "בעמוד   השני")).toEqual([at(PAGE, "בעמוד השני")]);
    expect(findAll(PAGE, "   ")).toEqual([]);
  });
});

describe("Web Annotation records", () => {
  const { start, end } = at(PAGE, "passage to highlight");
  const ann = createPdfAnnotation({
    id: UUID,
    source: "papers/bilingual.pdf",
    page: 2,
    text: PAGE,
    start,
    end,
    rect: { left: 40.123, top: 60, width: 200.555, height: 18 },
    now: new Date("2026-10-20T10:00:00Z"),
  });

  it("is a W3C annotation: a page fragment (RFC 3778) refined by a quote, and by a position", () => {
    expect(ann["@context"]).toBe("http://www.w3.org/ns/anno.jsonld");
    expect(ann.id).toBe(`urn:uuid:${UUID}`);
    expect(ann.motivation).toBe("highlighting");
    expect(ann.target.source).toBe("papers/bilingual.pdf");
    expect(ann.target.selector[0]).toMatchObject({
      type: "FragmentSelector",
      conformsTo: "http://tools.ietf.org/rfc/rfc3778",
      value: "page=2&viewrect=40.12,60,200.56,18",
      refinedBy: { type: "TextQuoteSelector", exact: "passage to highlight", prefix: "Page two holds the " },
    });
    expect(ann.target.selector[1]).toMatchObject({ value: "page=2", refinedBy: { type: "TextPositionSelector", start, end } });
    expect(describeAnnotation(ann)).toMatchObject({ page: 2, rect: { left: 40.12, top: 60, width: 200.56, height: 18 }, note: "" });
  });

  it("re-anchors in the page's current text", () => {
    expect(anchorAnnotation(ann, `Header\n${PAGE}`)).toEqual({ start: start + 7, end: end + 7, match: "exact" });
  });

  it("carries a note as a TextualBody", () => {
    const noted = withNote(ann, "  check this  ", new Date("2026-10-21T00:00:00Z"));
    expect(noted.motivation).toBe("commenting");
    expect(noted.body).toEqual([{ type: "TextualBody", value: "check this", format: "text/plain", purpose: "commenting" }]);
    expect(noted.modified).toBe("2026-10-21T00:00:00.000Z");
    expect(withNote(noted, "").body).toBeUndefined();
  });

  it("links to the page and the highlight", () => {
    expect(shortId(ann.id)).toBe("123e4567");
    expect(highlightLinkTarget("papers/bilingual.pdf", ann)).toBe("papers/bilingual.pdf#page=2&highlight=123e4567");
    expect(parsePdfFragment("#page=2&highlight=123e4567")).toEqual({ page: 2, highlight: "123e4567", rect: null });
    expect(parsePdfFragment("page=0&highlight=<x>")).toEqual({ page: null, highlight: null, rect: null });
    expect(parsePdfFragment(pageFragment(3, { left: 1, top: 2, width: 3, height: 4 })).rect).toEqual({ left: 1, top: 2, width: 3, height: 4 });
    expect(parsePdfFragment(null)).toEqual({ page: null, highlight: null, rect: null });
  });

  it("unionRect covers every rect", () => {
    expect(unionRect([])).toBeNull();
    expect(unionRect([{ left: 10, top: 10, width: 5, height: 5 }, { left: 2, top: 12, width: 4, height: 10 }])).toEqual({ left: 2, top: 10, width: 13, height: 12 });
  });

  describe("the companion note", () => {
    it("is <file>.pdf.md", () => {
      expect(companionNotePath("papers/bilingual.pdf")).toBe("papers/bilingual.pdf.md");
    });

    it("is created with a readable list of links and the annotations as JSON", () => {
      const md = upsertAnnotationsNote(null, "papers/bilingual.pdf", [withNote(ann, "a *note* [x]")], labels);
      expect(md.startsWith("# Highlights — bilingual.pdf\n\n")).toBe(true);
      expect(md).toContain("- [[papers/bilingual.pdf#page=2&highlight=123e4567|p. 2]] “passage to highlight” — a \\*note\\* \\[x\\]");
      expect(md).toContain("```json lumen-pdf-annotations\n");
      const back = parseAnnotationsNote(md);
      expect(back).toHaveLength(1);
      expect(describeAnnotation(back[0]).note).toBe("a *note* [x]");
      expect(back[0].target.selector[0].refinedBy).toEqual(ann.target.selector[0].refinedBy);
    });

    it("keeps what the user wrote around the managed region", () => {
      const first = upsertAnnotationsNote(null, "a.pdf", [ann], labels);
      const mine = `# My reading notes\n\nThoughts first.\n\n${first.slice(first.indexOf(NOTE_START))}\nAfterwards.\n`;
      const second = { ...ann, id: "urn:uuid:ffffffff-0000-4000-8000-000000000000" };
      const next = upsertAnnotationsNote(mine, "a.pdf", [ann, second], labels);
      expect(next.startsWith("# My reading notes\n\nThoughts first.\n\n")).toBe(true);
      expect(next.endsWith("\nAfterwards.\n")).toBe(true);
      expect(next.split(NOTE_START)).toHaveLength(2);
      expect(parseAnnotationsNote(next).map((a) => a.id)).toEqual([ann.id, second.id]);
    });

    it("a note holding the end marker can't cut the region short (review #272)", () => {
      const tricky = withNote(ann, `see ${NOTE_END} here`, new Date("2026-10-21T00:00:00Z"));
      const second = { ...ann, id: "urn:uuid:eeeeeeee-0000-4000-8000-000000000000" };
      const md = upsertAnnotationsNote(null, "a.pdf", [tricky, second], labels);
      expect(md.split(NOTE_END)).toHaveLength(2);
      const back = parseAnnotationsNote(md);
      expect(back.map((a) => a.id)).toEqual([tricky.id, second.id]);
      // A second save keeps both, and the note text survives exactly.
      const again = parseAnnotationsNote(upsertAnnotationsNote(md, "a.pdf", back, labels));
      expect(again).toHaveLength(2);
      expect(JSON.stringify(again[0].body)).toContain(NOTE_END);
    });

    it("appends the region to a note that has none, and says when it is empty", () => {
      const md = upsertAnnotationsNote("Just my text.", "a.pdf", [], labels);
      expect(md.startsWith("Just my text.\n\n" + NOTE_START)).toBe(true);
      expect(md).toContain("_No highlights yet._");
      expect(md.trimEnd().endsWith(NOTE_END)).toBe(true);
      expect(parseAnnotationsNote(md)).toEqual([]);
    });

    it("lists highlights by page", () => {
      const p1 = createPdfAnnotation({ id: "aaaaaaaa-0000-4000-8000-000000000000", source: "a.pdf", page: 1, text: "x y", start: 0, end: 1 });
      const block = renderAnnotationsBlock("a.pdf", [ann, p1], labels);
      expect(block.indexOf("page=1")).toBeLessThan(block.indexOf("page=2&highlight"));
    });

    it("reads nothing from a broken or foreign block", () => {
      expect(parseAnnotationsNote("```json lumen-pdf-annotations\n{not json\n```")).toEqual([]);
      expect(parseAnnotationsNote('```json lumen-pdf-annotations\n[{"type":"Other"}]\n```')).toEqual([]);
      expect(parseAnnotationsNote(undefined)).toEqual([]);
    });
  });
});

describe("text layer ↔ offsets", () => {
  function layer(): HTMLDivElement {
    const el = document.createElement("div");
    el.innerHTML = '<span dir="ltr">Page two holds the passage to highlight.</span><br><span dir="rtl">המשפט בעברית לסימון בעמוד השני.</span><br><span>Lumen fixture</span>';
    document.body.appendChild(el);
    return el;
  }

  it("has the same text pdf.js text content gives", () => {
    const el = layer();
    const items: { str?: string; hasEOL?: boolean; type?: string }[] = [
      { str: "Page two holds the passage to highlight.", hasEOL: true },
      { str: "המשפט בעברית לסימון בעמוד השני.", hasEOL: true },
      { type: "beginMarkedContent" },
      { str: "Lumen fixture", hasEOL: false },
    ];
    expect(layerText(el)).toBe(pageTextFromItems(items));
    el.remove();
  });

  it("turns a selection into offsets and offsets back into the same text", () => {
    const el = layer();
    const text = layerText(el);
    const rtl = el.querySelectorAll("span")[1].firstChild as Text;
    const range = document.createRange();
    range.setStart(rtl, 6);
    range.setEnd(rtl, 19);
    const off = rangeToOffsets(el, range);
    expect(off).not.toBeNull();
    expect(text.slice(off!.start, off!.end)).toBe("בעברית לסימון");
    const back = offsetsToRange(el, off!.start, off!.end);
    expect(back?.toString()).toBe("בעברית לסימון");
    // Across the line break: the newline counts, the range spans both spans.
    const across = offsetsToRange(el, text.indexOf("highlight"), text.indexOf("המשפט") + 5);
    expect(across?.toString()).toBe("highlight.המשפט");
    expect(offsetsToRange(el, 5, 2)).toBeNull();
    el.remove();
  });

  it("clamps boundary points outside the layer to its ends", () => {
    const el = layer();
    const before = document.createElement("p");
    document.body.insertBefore(before, el);
    expect(boundaryOffset(el, before, 0)).toBe(0);
    expect(boundaryOffset(el, document.body, document.body.childNodes.length)).toBe(layerText(el).length);
    before.remove();
    el.remove();
  });
});

describe("wiki links to a PDF", () => {
  it("encode the characters that are wiki-link syntax, and resolve back", () => {
    const ann = createPdfAnnotation({ id: UUID, source: "a/draft#2 [v|1].pdf", page: 1, text: "hello", start: 0, end: 5 });
    const target = highlightLinkTarget("a/draft#2 [v|1].pdf", ann);
    expect(target).toBe("a/draft%232 %5Bv%7C1%5D.pdf#page=1&highlight=123e4567");
    expect(encodeWikiPath("100%.pdf")).toBe("100%25.pdf");
    const note = target.slice(0, target.indexOf("#"));
    expect(resolveWikiTarget(note, ["a/draft#2 [v|1].pdf.md", "a/draft#2 [v|1].pdf"])).toBe("a/draft#2 [v|1].pdf");
    expect(resolveWikiTarget("100%25.pdf", ["100%.pdf"])).toBe("100%.pdf");
  });

  it("resolve to the PDF, not to its companion note", () => {
    const paths = ["bilingual.pdf.md", "bilingual.pdf", "papers/x.pdf.md", "papers/x.pdf"];
    expect(resolveWikiTarget("bilingual.pdf", paths)).toBe("bilingual.pdf");
    expect(resolveWikiTarget("x.pdf", paths)).toBe("papers/x.pdf");
    expect(resolveWikiTarget("bilingual.pdf.md", paths)).toBe("bilingual.pdf.md");
  });
});

describe("nextMatchIndex", () => {
  it("goes forward to the first and back to the last match when none is current", () => {
    expect(nextMatchIndex(-1, 1, 3)).toBe(0);
    expect(nextMatchIndex(-1, -1, 3)).toBe(2);
  });

  it("steps and wraps around", () => {
    expect(nextMatchIndex(0, -1, 3)).toBe(2);
    expect(nextMatchIndex(2, 1, 3)).toBe(0);
    expect(nextMatchIndex(1, 1, 3)).toBe(2);
    expect(nextMatchIndex(5, -1, 3)).toBe(2);
    expect(nextMatchIndex(-1, 1, 0)).toBe(-1);
  });
});

describe("readAnnotationsNote (strict)", () => {
  const { start, end } = at(PAGE, "passage to highlight");
  const ann = createPdfAnnotation({ id: UUID, source: "a.pdf", page: 2, text: PAGE, start, end });
  const good = upsertAnnotationsNote("# Mine\n\ntext", "a.pdf", [ann], labels);

  it("reads a whole block, and [] for no note or a note without one", () => {
    expect(readAnnotationsNote(good)?.map((a) => a.id)).toEqual([ann.id]);
    expect(readAnnotationsNote(upsertAnnotationsNote(null, "a.pdf", [], labels))).toEqual([]);
    expect(readAnnotationsNote(null)).toEqual([]);
    expect(readAnnotationsNote("# Just my notes")).toEqual([]);
  });

  it("refuses a block that can't be read whole, so nothing is saved over it", () => {
    expect(readAnnotationsNote(good.replace('"type": "Annotation"', '"type": "Annotation",,'))).toBeNull();
    expect(readAnnotationsNote(good.slice(0, good.indexOf('"target"')))).toBeNull();
    expect(readAnnotationsNote(good.replace(NOTE_END, ""))).toBeNull();
    expect(readAnnotationsNote(good.replace('"type": "Annotation"', '"type": "Other"'))).toBeNull();
    expect(readAnnotationsNote("```json lumen-pdf-annotations\n{\"not\": \"a list\"}\n```")).toBeNull();
  });
});
