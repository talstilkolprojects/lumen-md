/**
 * Plan W1.15 — all highlights in one place: the index over PDF and EPUB
 * sidecar notes and clipped pages, search (text, note, tags; case / niqqud
 * insensitive) under 100 ms for 5,000 highlights, filters, tags saved into
 * the sidecar as W3C tagging bodies (kept when the note changes, and the
 * EPUB chapter labels kept), and the export note whose links reopen each
 * highlight.
 */
import { describe, it, expect } from "vitest";
import { createPdfAnnotation, describeAnnotation, readAnnotationsNote, upsertAnnotationsNote, withNote } from "../pdf/annotations";
import { createEpubAnnotation, describeEpubAnnotation, readEpubNote, upsertEpubNote, withEpubNote } from "../epub/annotations";
import { allSources, allTags, buildIndex, cleanTag, exportNote, isClip, quoteBlock, retagItem, search, tagsOf, withTags, type HighlightItem } from "../highlights/hub";
import { existingChapterLabels, retagSidecar, type RetagLabels } from "../highlights/retag";

const NOW = new Date("2026-11-10T08:00:00Z");
const PDF_LABELS = { title: "Highlights — paper.pdf", page: (n: number) => `p. ${n}`, empty: "_No highlights yet._" };
const EPUB_LABELS = { title: "Highlights — Book", chapter: (n: number, label: string) => (label ? `ch. ${n}: ${label}` : `ch. ${n}`), empty: "_No highlights yet._" };
const LABELS: RetagLabels = { pdf: PDF_LABELS, epub: EPUB_LABELS };
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function vault() {
  const pageText = "Results show that the method works. השיטה עובדת היטב בעברית.";
  const pdf = [
    createPdfAnnotation({ id: uuid(1), source: "papers/paper.pdf", page: 3, text: pageText, start: 0, end: 34, now: NOW }),
    withNote(createPdfAnnotation({ id: uuid(2), source: "papers/paper.pdf", page: 5, text: pageText, start: 36, end: 52, now: NOW }), "חשוב לפרק 2", NOW),
  ];
  const chText = "In the beginning was the word. This is the first sentence.";
  const epub = [withTags(createEpubAnnotation({ id: uuid(3), source: "books/book.epub", chapter: 2, text: chText, start: 31, end: 58, now: NOW }), ["quotes"], NOW)];
  return [
    { path: "papers/paper.pdf.md", content: upsertAnnotationsNote("# My reading notes\n\nMine.\n", "papers/paper.pdf", pdf, PDF_LABELS) },
    { path: "books/book.epub.md", content: upsertEpubNote(null, "books/book.epub", epub, EPUB_LABELS, () => "Genesis") },
    { path: "clips/story.md", content: `---\ntitle: "Story"\nsource: "https://example.com/story"\nclipped: "2026-11-10"\ntags: [news, "longread"]\n---\n\n> ==a marked passage==\n\nBody with ==another mark== and {==critic==}.\n` },
    { path: "notes/plain.md", content: "# Plain\n\nA ==mark== in a note that is not a clip.\n" },
    { path: "papers/paper.pdf", content: "%PDF" },
  ];
}

describe("highlights index (W1.15)", () => {
  const items = buildIndex(vault());

  it("collects PDF, EPUB and clip highlights with their notes, tags and links", () => {
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ["pdf", "Results show that the method works"],
      ["pdf", "השיטה עובדת היטב"],
      ["epub", "This is the first sentence."],
      ["clip", "a marked passage"],
      ["clip", "another mark"],
    ]);
    expect(items[1]).toMatchObject({ note: "חשוב לפרק 2", location: 5, link: "papers/paper.pdf#page=5&highlight=00000002", notePath: "papers/paper.pdf.md" });
    expect(items[2]).toMatchObject({ tags: ["quotes"], location: 2, link: "books/book.epub#chapter=2&highlight=00000003" });
    expect(items[3]).toMatchObject({ source: "clips/story.md", tags: ["news", "longread"], link: "clips/story.md" });
    expect(isClip(vault()[3].content)).toBe(false);
  });

  it("searches the text, the note and tags; folds case and niqqud; filters by kind, document and tag", () => {
    expect(search(items, { text: "METHOD" }).map((i) => i.location)).toEqual([3]);
    expect(search(items, { text: "לפרק" }).map((i) => i.kind)).toEqual(["pdf"]);
    expect(search(items, { text: "הַשִּׁיטָה" })).toHaveLength(1);
    expect(search(items, { text: "#quotes" })).toHaveLength(1);
    expect(search(items, { kind: "clip" })).toHaveLength(2);
    expect(search(items, { source: "papers/paper.pdf" })).toHaveLength(2);
    expect(search(items, { tag: "#longread" })).toHaveLength(2);
    expect(search(items, { kind: "pdf", tag: "news" })).toHaveLength(0);
    expect(allTags(items)).toEqual([{ tag: "longread", count: 2 }, { tag: "news", count: 2 }, { tag: "quotes", count: 1 }]);
    expect(allSources(items).map((s) => [s.source, s.kind, s.count])).toEqual([["books/book.epub", "epub", 1], ["clips/story.md", "clip", 2], ["papers/paper.pdf", "pdf", 2]]);
  });

  it("5,000 highlights: a search takes under 100 ms", () => {
    const words = ["אור", "light", "שלום", "method", "ספר", "result", "מים", "data"];
    const big: HighlightItem[] = [];
    for (let i = 0; i < 5000; i++) {
      const text = Array.from({ length: 12 }, (_, j) => words[(i * 7 + j * 3) % words.length]).join(" ") + ` #${i}`;
      big.push(...buildIndex([{ path: `c/${i}.md`, content: `---\nclipped: "2026-11-10"\n---\n\n==${text}==\n` }]));
    }
    expect(big).toHaveLength(5000);
    const t0 = performance.now();
    const hits = search(big, { text: "אור method" });
    search(big, { text: "#4999" });
    search(big, { text: "nothing like this" });
    const ms = (performance.now() - t0) / 3;
    expect(hits.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100);
  });
});

describe("tags on highlights (W1.15)", () => {
  it("are W3C tagging bodies; a note edit keeps them, a tag edit keeps the note", () => {
    const a = withNote(createPdfAnnotation({ id: uuid(9), source: "p.pdf", page: 1, text: "abc def", start: 0, end: 3, now: NOW }), "my note", NOW);
    const tagged = withTags(a, ["one", "#two", " two ", "multi word"], NOW);
    expect(tagsOf(tagged)).toEqual(["one", "two", "multi-word"]);
    expect(describeAnnotation(tagged).note).toBe("my note");
    const renoted = withNote(tagged, "", NOW);
    expect(tagsOf(renoted)).toEqual(["one", "two", "multi-word"]);
    expect(describeAnnotation(renoted).note).toBe("");
    const e = withTags(createEpubAnnotation({ id: uuid(8), source: "b.epub", chapter: 1, text: "abc", start: 0, end: 3, now: NOW }), ["x"], NOW);
    expect(describeEpubAnnotation(e).note).toBe("");
    expect(tagsOf(withEpubNote(e, "n", NOW))).toEqual(["x"]);
    expect(cleanTag("  ")).toBeNull();
  });

  it("are saved in the sidecar: the user's text stays, the EPUB chapter labels stay", () => {
    const [pdfNote, epubNote] = vault();
    const items = buildIndex(vault());
    const pdfOut = retagSidecar(pdfNote.content, items[0], ["method", "results"], LABELS, NOW);
    expect(pdfOut.startsWith("# My reading notes\n\nMine.")).toBe(true);
    expect(tagsOf(readAnnotationsNote(pdfOut)!.find((a) => a.id === items[0].id)!)).toEqual(["method", "results"]);
    expect(existingChapterLabels(epubNote.content).get(2)).toBe("ch. 2: Genesis");
    const epubOut = retagSidecar(epubNote.content, items[2], [], LABELS, NOW);
    expect(epubOut).toContain("|ch. 2: Genesis]]");
    expect(tagsOf(readEpubNote(epubOut)![0])).toEqual([]);
    expect(() => retagSidecar("```json lumen-pdf-annotations\n[oops\n```", items[0], ["x"], LABELS)).toThrow("unreadable");
    expect(() => retagSidecar(pdfNote.content, { ...items[0], id: "urn:uuid:gone" }, ["x"], LABELS)).toThrow("not found");
    expect(() => retagSidecar("", items[3], ["x"], LABELS)).toThrow("clip");
    // The re-indexed sidecar shows the new tags.
    expect(buildIndex([{ path: pdfNote.path, content: pdfOut }])[0].tags).toEqual(["method", "results"]);
    expect(search([retagItem(items[0], ["fresh"])], { tag: "fresh" })).toHaveLength(1);
  });
});

describe("export and drag (W1.15)", () => {
  const items = buildIndex(vault());
  const where = (i: HighlightItem) => (i.kind === "pdf" ? `p. ${i.location}` : i.kind === "epub" ? `ch. ${i.location}` : "story");

  it("exports a note with a section per document and a link back to every highlight", () => {
    const md = exportNote(items, { title: "Highlights — 2026-11-10 (5)", where });
    expect(md.split("\n")[0]).toBe("# Highlights — 2026-11-10 (5)");
    expect(md).toContain("## [[books/book.epub]]\n\n> This is the first sentence.\n> — [[books/book.epub#chapter=2&highlight=00000003|ch. 2]] #quotes");
    expect(md).toContain("> השיטה עובדת היטב\n>\n> חשוב לפרק 2\n> — [[papers/paper.pdf#page=5&highlight=00000002|p. 5]]");
    expect(md).toContain("> — [[clips/story.md|story]] #news #longread");
    // Every highlight's link is in the note, once.
    for (const it of items.filter((i) => i.kind !== "clip")) expect(md.split(`[[${it.link}|`).length - 1).toBe(1);
    expect(md.indexOf("books/") < md.indexOf("clips/") && md.indexOf("clips/") < md.indexOf("papers/")).toBe(true);
  });

  it("a dragged highlight drops as a quote with its link", () => {
    expect(quoteBlock(items[0], "p. 3")).toBe("> Results show that the method works\n> — [[papers/paper.pdf#page=3&highlight=00000001|p. 3]]");
  });
});
