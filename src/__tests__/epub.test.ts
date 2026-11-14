/**
 * Plan W1.14 — EPUB books: the ZIP reader, the package / spine / TOC
 * (EPUB 3 nav and EPUB 2 NCX), RTL, chapters with the book's own resources
 * inlined and nothing remote or scripted left, scoped CSS, highlights as
 * W3C Web Annotations in `<book>.epub.md`, text ranges, reader settings, and
 * reading mode's highlight-in-the-note.
 */
import { describe, it, expect } from "vitest";
import { readZip } from "../epub/zip";
import { writeZip } from "./helpers/zipWriter";
import { makeEpub } from "./helpers/epubFixture";
import { loadChapter, openEpub, resolveHref, scopeCss } from "../epub/epub";
import {
  anchorEpubAnnotation,
  createEpubAnnotation,
  describeEpubAnnotation,
  epubHighlightLink,
  parseEpubFragment,
  readEpubNote,
  upsertEpubNote,
  withEpubNote,
  EPUB_NOTE_START,
} from "../epub/annotations";
import { chapterText, markOffsets, rangeToOffsets } from "../epub/textRange";
import { loadPrefs, savePrefs } from "../epub/readerPrefs";
import { addHighlight, clipInfo, markHighlights } from "../epub/ReadingMode";

const LABELS = { title: "Highlights — Test Book", chapter: (n: number, label: string) => (label ? `ch. ${n}: ${label}` : `ch. ${n}`), empty: "_No highlights yet._" };

describe("ZIP reader (W1.14)", () => {
  it("reads stored and deflated entries, by normalised path", async () => {
    for (const deflate of [false, true]) {
      const z = readZip(await writeZip([["mimetype", "application/epub+zip"], ["A/b.txt", "שלום ".repeat(50)]], { deflate }));
      expect([...z.entries.keys()]).toEqual(["mimetype", "A/b.txt"]);
      expect(await z.text("./A/x/../b.txt")).toBe("שלום ".repeat(50));
      expect(z.entries.get("A/b.txt")?.method).toBe(deflate ? 8 : 0);
    }
  });

  it("refuses what isn't a ZIP", () => {
    expect(() => readZip(new TextEncoder().encode("not a zip at all, sorry"))).toThrow("not a ZIP file");
  });
});

describe("EPUB package and TOC (W1.14)", () => {
  it("EPUB 3: metadata, spine, nested nav TOC", async () => {
    const book = await openEpub(await makeEpub({ deflate: true }));
    expect(book).toMatchObject({ title: "Test Book", author: "Ada", language: "en", rtl: false });
    expect(book.spine.map((s) => s.href)).toEqual(["OEBPS/text/ch1.xhtml", "OEBPS/text/ch2.xhtml"]);
    expect(book.toc.map((e) => [e.label, e.chapter])).toEqual([["Chapter One", 0], ["Chapter Two", 1]]);
    expect(book.toc[0].children[0]).toMatchObject({ label: "Chapter One · 1", href: "OEBPS/text/ch1.xhtml#top", chapter: 0 });
  });

  it("EPUB 2 Hebrew: NCX TOC, right-to-left from the spine", async () => {
    const book = await openEpub(await makeEpub({ version: 2, hebrew: true }));
    expect(book).toMatchObject({ title: "ספר בדיקה", language: "he", rtl: true });
    expect(book.toc.map((e) => e.label)).toEqual(["פרק ראשון", "פרק שני"]);
  });

  it("resolves hrefs relative to their file, percent-decoded, with fragments", () => {
    expect(resolveHref("OEBPS/text/ch1.xhtml", "../img/a%20b.png#x")).toEqual({ path: "OEBPS/img/a b.png", fragment: "x" });
    expect(resolveHref("OEBPS/text/ch1.xhtml", "#top")).toEqual({ path: "OEBPS/text/ch1.xhtml", fragment: "top" });
  });
});

describe("EPUB chapters (W1.14): local resources only, nothing scripted", () => {
  it("inlines the image and the font, drops remote references, scripts and handlers; chapter links stay inside", async () => {
    const book = await openEpub(await makeEpub());
    const c = await loadChapter(book, 0);
    expect(c.html).toContain('src="data:image/png;base64,');
    expect(c.html).not.toMatch(/https?:\/\/example\.com\/track/);
    expect(c.html).not.toMatch(/<script|onclick|window\.__epub/);
    expect(c.html).toContain('data-epub-href="OEBPS/text/ch2.xhtml#top"');
    expect(c.html).toContain('data-external="https://example.com/"');
    expect(c.html).not.toContain('href="https://');
    expect(c.css.join("\n")).toContain("url(\"data:font/woff2;base64,");
    expect(c.css.join("\n")).not.toMatch(/https?:|@import/);
    expect(c.lang).toBe("en");
  });

  it("CSS is scoped to the chapter: body / html become the scope, @font-face kept, @page dropped", () => {
    const out = scopeCss("@charset \"utf-8\"; body { margin: 0 } html body p, h1 { color: red } @media (min-width: 1px) { .a > b { x: y } } @font-face { font-family: F } @page { margin: 1in }", ".epub-chapter");
    expect(out).toContain(".epub-chapter{ margin: 0 }");
    expect(out).toContain(".epub-chapter p, .epub-chapter h1{ color: red }");
    expect(out).toContain("@media (min-width: 1px){.epub-chapter .a > b{ x: y }");
    expect(out).toContain("@font-face{ font-family: F }");
    expect(out).not.toContain("@page");
  });
});

describe("EPUB highlights (W1.14): the PDF reader's W3C model", () => {
  const text = "In the beginning was the word. This is the first sentence.";
  const a = createEpubAnnotation({ id: "0f1e2d3c-0000-4000-8000-000000000000", source: "books/test.epub", chapter: 2, text, start: 31, end: 58, now: new Date("2026-11-10T00:00:00Z") });

  it("targets the chapter with a quote and a position", () => {
    expect(describeEpubAnnotation(a)).toMatchObject({ chapter: 2, quote: { exact: "This is the first sentence.", prefix: "In the beginning was the word. " }, position: { start: 31, end: 58 } });
    expect(epubHighlightLink("books/test.epub", a)).toBe("books/test.epub#chapter=2&highlight=0f1e2d3c");
    expect(parseEpubFragment("#chapter=2&highlight=0f1e2d3c")).toEqual({ chapter: 2, highlight: "0f1e2d3c" });
  });

  it("re-anchors after the chapter's text changed around it", () => {
    expect(anchorEpubAnnotation(a, `Preface.  ${text}`)).toMatchObject({ start: 41, end: 68, match: "exact" });
    expect(anchorEpubAnnotation(a, "Something else entirely, nothing like it.")).toBeNull();
  });

  it("the companion note keeps the user's text, reads back strictly, refuses a broken block", () => {
    const md = upsertEpubNote("# My notes\n\nKeep this.\n", "books/test.epub", [withEpubNote(a, "a note")], LABELS, () => "Chapter Two");
    expect(md.startsWith("# My notes\n\nKeep this.")).toBe(true);
    expect(md).toContain("- [[books/test.epub#chapter=2&highlight=0f1e2d3c|ch. 2: Chapter Two]] “This is the first sentence.” — a note");
    expect(readEpubNote(md)).toHaveLength(1);
    expect(readEpubNote(md.replace("\"type\": \"Annotation\"", "\"type\": \"Broken\""))).toBeNull();
    expect(readEpubNote(`${EPUB_NOTE_START}\nno end`)).toBeNull();
    expect(readEpubNote("# Just a note")).toEqual([]);
    expect(upsertEpubNote(null, "books/test.epub", [], LABELS)).toContain("_No highlights yet._");
  });
});

describe("chapter text ranges (W1.14)", () => {
  it("selection ↔ offsets, and marks across element boundaries", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Hello <b>bright</b> world</p><p>again</p>";
    document.body.appendChild(root);
    expect(chapterText(root)).toBe("Hello bright worldagain");
    const r = document.createRange();
    r.setStart(root.querySelector("b")!.firstChild!, 2);
    r.setEnd(root.querySelectorAll("p")[0].lastChild!, 3);
    expect(rangeToOffsets(root, r)).toEqual({ start: 8, end: 15 });
    const marks = markOffsets(root, 8, 15, { "data-highlight": "x" });
    expect(marks.map((m) => m.textContent)).toEqual(["ight", " wo"]);
    expect(chapterText(root)).toBe("Hello bright worldagain");
    root.remove();
  });
});

describe("reader settings (W1.14)", () => {
  it("per document, clamped, defaults when storage is empty or corrupt", () => {
    const kv = new Map<string, string>();
    const s = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v) };
    expect(loadPrefs("a.epub", s)).toEqual({ theme: "light", fontSize: 18, width: 66, chapter: 0 });
    savePrefs("a.epub", { theme: "sepia", fontSize: 99, width: 10, chapter: 3 }, s);
    expect(loadPrefs("a.epub", s)).toEqual({ theme: "sepia", fontSize: 32, width: 40, chapter: 3 });
    expect(loadPrefs("b.epub", s).theme).toBe("light");
    kv.set("lumen.reader:a.epub", "{");
    expect(loadPrefs("a.epub", s).theme).toBe("light");
  });
});

describe("reading mode for clips (W1.14)", () => {
  const clip = `---\ntitle: "Story"\nsource: "https://example.com/story"\nclipped: "2026-11-10"\n---\n\n# Story\n\nThe quick brown fox jumps over the lazy dog.\n\nA [link](https://example.com) here and ==an old mark== too.\n`;

  it("reads the clip's source and date", () => {
    expect(clipInfo(clip)).toEqual({ source: "https://example.com/story", clipped: "2026-11-10" });
    expect(clipInfo("# plain")).toEqual({ source: null, clipped: null });
  });

  it("shows ==marks== as highlights, leaves {==critic==} alone", () => {
    expect(markHighlights("a ==b c== d {==e==}")).toBe("a {==b c==} d {==e==}");
  });

  it("marks a selected passage in the Markdown; refuses one across links or marks", () => {
    const out = addHighlight(clip, { exact: "brown fox jumps", prefix: "The quick ", suffix: " over" });
    expect(out).toContain("The quick ==brown fox jumps== over the lazy dog.");
    expect(out?.startsWith("---\ntitle")).toBe(true);
    expect(addHighlight(clip, { exact: "link here" })).toBeNull();
    expect(addHighlight(clip, { exact: "an old mark" })).toBeNull();
    expect(addHighlight(clip, { exact: "not in the note at all" })).toBeNull();
  });
});
