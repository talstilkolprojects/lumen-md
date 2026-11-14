/**
 * Plan W2.15 — importing highlights from Kindle, Kobo, Readwise and Zotero.
 * Acceptance: 4 golden files, 100% of the highlights imported and 0
 * duplicates when imported again; Zotero (local API): 50 highlights with a
 * link back to the item; nothing leaves the device (files are read here;
 * Zotero is asked on 127.0.0.1 by the desktop app — src-tauri/src/zotero_local.rs).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseKindleClippings, splitTitleAuthor } from "../highlights/import/kindle";
import { parseReadwiseCsv } from "../highlights/import/readwise";
import { koboRowsToReport, type KoboRow } from "../highlights/import/kobo";
import { importZotero, creatorsLine, type LocalGet } from "../highlights/import/zotero";
import { parseCsv } from "../highlights/import/csv";
import { highlightId, normText, type ImportReport } from "../highlights/import/model";
import { bookNotePath, mergeBookNote, readImportNote, safeName } from "../highlights/import/notes";
import { writeBooks } from "../highlights/import/runImport";
import { buildIndex, search } from "../highlights/hub";

const DIR = join(__dirname, "fixtures", "highlight-import");
const kindle = () => parseKindleClippings(readFileSync(join(DIR, "My Clippings.txt"), "utf8"));
const readwise = () => parseReadwiseCsv(readFileSync(join(DIR, "readwise.csv"), "utf8"));
const kobo = () => koboRowsToReport(JSON.parse(readFileSync(join(DIR, "kobo-rows.json"), "utf8")) as KoboRow[]);

/* A Zotero library behind a fake local API: 3 items, 53 annotations (50 with text, an image, an ink, an empty one). */
function zoteroLibrary(): { get: LocalGet; requests: string[] } {
  const items: Array<{ key: string; data: Record<string, unknown> }> = [
    { key: "BOOK0001", data: { key: "BOOK0001", itemType: "book", title: "Thinking, Fast and Slow", creators: [{ firstName: "Daniel", lastName: "Kahneman", creatorType: "author" }, { firstName: "Ed", lastName: "Itor", creatorType: "editor" }] } },
    { key: "ART00002", data: { key: "ART00002", itemType: "journalArticle", title: "על קריאה עמוקה", creators: [{ name: "רונית לוי", creatorType: "author" }] } },
    { key: "ATT00001", data: { key: "ATT00001", itemType: "attachment", parentItem: "BOOK0001", title: "Full Text PDF" } },
    { key: "ATT00002", data: { key: "ATT00002", itemType: "attachment", parentItem: "ART00002", title: "PDF" } },
    { key: "ATT00003", data: { key: "ATT00003", itemType: "attachment", title: "standalone-notes.pdf" } },
  ];
  const ann = (i: number, att: string, extra: Record<string, unknown>) => ({
    key: `ANN${String(i).padStart(5, "0")}`,
    data: { key: `ANN${String(i).padStart(5, "0")}`, itemType: "annotation", parentItem: att, annotationType: "highlight", annotationText: `Passage number ${i} of the text.`, annotationComment: "", annotationColor: "#ffd400", annotationPageLabel: String(10 + i), annotationSortIndex: `${String(i).padStart(5, "0")}|000100|00200`, tags: [], dateAdded: "2026-01-02T03:04:05Z", ...extra },
  });
  const annotations = [
    ...Array.from({ length: 30 }, (_, i) => ann(i + 1, "ATT00001", i === 0 ? { annotationComment: "System 1 vs 2", tags: [{ tag: "psychology" }] } : {})),
    ...Array.from({ length: 15 }, (_, i) => ann(i + 31, "ATT00002", { annotationText: `קטע מספר ${i + 1} במאמר.`, annotationType: i === 0 ? "underline" : "highlight" })),
    ...Array.from({ length: 4 }, (_, i) => ann(i + 46, "ATT00003", {})),
    ann(50, "ATT00001", { annotationType: "note", annotationText: "", annotationComment: "A note annotation on its own" }),
    ann(51, "ATT00001", { annotationType: "image", annotationText: "" }),
    ann(52, "ATT00001", { annotationType: "ink", annotationText: "" }),
    ann(53, "ATT00002", { annotationText: "", annotationComment: "" }),
  ];
  const requests: string[] = [];
  const get: LocalGet = async (path) => {
    requests.push(path);
    const u = new URL(path, "http://127.0.0.1:23119");
    expect(u.pathname).toBe("/api/users/0/items");
    const limit = Number(u.searchParams.get("limit") ?? 25);
    const start = Number(u.searchParams.get("start") ?? 0);
    const keys = u.searchParams.get("itemKey")?.split(",");
    const all = keys ? items.filter((x) => keys.includes(x.key)) : u.searchParams.get("itemType") === "annotation" ? annotations : [];
    return { status: 200, total: all.length, body: JSON.stringify(all.slice(start, start + limit)) };
  };
  return { get, requests };
}

const count = (r: ImportReport) => r.books.reduce((n, b) => n + b.highlights.length, 0);

describe("Kindle My Clippings.txt (W2.15)", () => {
  it("every highlight and note, in four books; bookmarks skipped; the edited highlight kept once", () => {
    const r = kindle();
    expect(r.books.map((b) => [b.title, b.author, b.highlights.length])).toEqual([
      ["Sapiens: A Brief History of Humankind", "Harari, Yuval Noah", 2],
      ["קיצור תולדות האנושות", "יובל נח הררי", 2],
      ["Der Process", "Kafka, Franz", 2],
      ["Notes (from a PDF)", "Personal Document", 1],
    ]);
    expect(r.skipped).toEqual({ bookmark: 2 });
    const sapiens = r.books[0].highlights;
    expect(sapiens[0]).toMatchObject({ text: "The Cognitive Revolution kick-started history about 70,000 years ago.", note: "Compare with Diamond.", location: "p. 12 · loc. 180–182", created: new Date(2016, 2, 10, 7, 45, 31).toISOString() }); // Kindle writes local time
    expect(sapiens[1].text).toBe("Fiction has enabled us not merely to imagine things, but to do so collectively.");
    const he = r.books[1].highlights;
    expect(he[1]).toMatchObject({ note: "להשוות לפרק 2.", location: "loc. 1500–1502" });
    expect(r.books[2].highlights.map((h) => [h.text, h.note])).toEqual([
      ["Jemand mußte Josef K. verleumdet haben.", ""],
      ["", "Eine Notiz ohne Markierung."],
    ]);
    expect(r.books[3].highlights[0]).toMatchObject({ text: "A highlight with only a page,\nover two lines.", location: "p. 3" });
  });

  it("title and author: the last bracket is the author", () => {
    expect(splitTitleAuthor("﻿Notes (from a PDF) (Personal Document)")).toEqual({ title: "Notes (from a PDF)", author: "Personal Document" });
    expect(splitTitleAuthor("No Author Here")).toEqual({ title: "No Author Here", author: "" });
  });
});

describe("Readwise CSV (W2.15)", () => {
  it("every row with text, quoted commas / quotes / newlines, tags; the same passage as Kindle has the same id", () => {
    const r = readwise();
    expect(count(r)).toBe(4);
    expect(r.skipped).toEqual({ empty: 1 });
    const sapiens = r.books.find((b) => b.title.startsWith("Sapiens"))!;
    expect(sapiens.highlights[1]).toMatchObject({ text: 'Readwise-only highlight, with a comma, and "quotes"\nand a second line.', tags: ["history", "favorite"], location: "loc. 2210" });
    expect(sapiens.highlights[0].id).toBe(kindle().books[0].highlights[0].id);
    expect(r.books.find((b) => b.author === "ג׳ון לנון")!.highlights[0]).toMatchObject({ note: "הערה בעברית", location: "p. 14", tags: ["ציטוטים"] });
    expect(() => parseReadwiseCsv("a,b\n1,2")).toThrow(/not a Readwise export/);
    expect(parseCsv('a,"b ""c"", d"\r\n\r\n1,2')).toEqual([["a", 'b "c", d'], ["1", "2"]]);
  });
});

describe("Kobo KoboReader.sqlite (W2.15)", () => {
  it("highlights and notes with chapter and progress; dog-ears and hidden entries skipped", () => {
    const r = kobo();
    expect(r.books.map((b) => [b.title, b.author, b.highlights.length])).toEqual([
      ["Dune", "Frank Herbert", 2],
      ["סיפור על אהבה וחושך", "עמוס עוז", 2],
    ]);
    expect(r.skipped).toEqual({ bookmark: 1, hidden: 1 });
    expect(r.books[0].highlights[1]).toMatchObject({ text: "The mystery of life isn't a problem to solve.", note: "Great line", location: "Book One: Dune · 50%", created: "2024-01-01T10:05:00.000Z" });
    expect(r.books[1].highlights[1]).toMatchObject({ text: "", note: "הערה בלי הדגשה", location: "פרק א · 40%" });
  });
});

describe("Zotero local API (W2.15)", () => {
  it("50 highlights with a link back to the item and the annotation; image / ink / empty skipped; only /api/ on the local library", async () => {
    const { get, requests } = zoteroLibrary();
    const r = await importZotero(get);
    expect(count(r)).toBe(50);
    expect(r.skipped).toEqual({ "image-annotation": 1, "ink-annotation": 1, empty: 1 });
    const book = r.books.find((b) => b.title === "Thinking, Fast and Slow")!;
    expect(book).toMatchObject({ author: "Daniel Kahneman", link: "zotero://select/library/items/BOOK0001" });
    expect(book.highlights).toHaveLength(31);
    expect(book.highlights[0]).toMatchObject({ text: "Passage number 1 of the text.", note: "System 1 vs 2", tags: ["psychology"], location: "p. 11", link: "zotero://open-pdf/library/items/ATT00001?page=11&annotation=ANN00001" });
    expect(book.highlights.find((h) => h.note === "A note annotation on its own")!.text).toBe("");
    const he = r.books.find((b) => b.title === "על קריאה עמוקה")!;
    expect(he).toMatchObject({ author: "רונית לוי", link: "zotero://select/library/items/ART00002" });
    expect(he.highlights).toHaveLength(15);
    expect(r.books.find((b) => b.title === "standalone-notes.pdf")!.link).toBe("zotero://select/library/items/ATT00003");
    expect(requests.every((p) => p.startsWith("/api/users/0/items?"))).toBe(true);
    expect(creatorsLine([{ name: "Org" }])).toBe("Org");
  });

  it("pages through more than 100 annotations, and reports a disabled API", async () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ key: `K${i}`, data: { key: `K${i}`, itemType: "annotation", parentItem: "ATT", annotationType: "highlight", annotationText: `t${i}`, annotationSortIndex: `${i}|0|0` } }));
    const att = { key: "ATT", data: { key: "ATT", itemType: "attachment", title: "x.pdf" } };
    const seen: string[] = [];
    const r = await importZotero(async (path) => {
      seen.push(path);
      const u = new URL(path, "http://127.0.0.1");
      const start = Number(u.searchParams.get("start"));
      const all = u.searchParams.get("itemKey") ? [att] : many;
      return { status: 200, total: all.length, body: JSON.stringify(all.slice(start, start + 100)) };
    });
    expect(count(r)).toBe(230);
    expect(seen.filter((p) => p.includes("itemType=annotation"))).toHaveLength(3);
    await expect(importZotero(async () => ({ status: 403, total: null, body: "Local API is not enabled" }))).rejects.toMatchObject({ name: "ZoteroUnavailable", reason: "disabled" });
  });
});

describe("notes in the vault: one per book, 0 duplicates on re-import (W2.15)", () => {
  async function importAll(vault: Map<string, string>, reports: ImportReport[]) {
    const totals = [];
    for (const r of reports)
      totals.push(
        await writeBooks(r, async (path, update) => {
          vault.set(path, update(vault.get(path) ?? null));
        }),
      );
    return totals;
  }

  it("all four sources: 100% written; again: nothing added, nothing changed", async () => {
    const vault = new Map<string, string>();
    const zotero = await importZotero(zoteroLibrary().get);
    const reports = [kindle(), kobo(), readwise(), zotero];
    const first = await importAll(vault, reports);
    // Kindle 7 + Kobo 4 + Readwise 4 (1 is the Kindle passage: same entry) + Zotero 50.
    expect(first.map((t) => t.added)).toEqual([7, 4, 3, 50]);
    expect(first[2].unchanged).toBe(1);
    const snapshot = new Map(vault);
    const again = await importAll(vault, [kindle(), kobo(), readwise(), await importZotero(zoteroLibrary().get)]);
    expect(again.map((t) => [t.added, t.updated])).toEqual([[0, 0], [0, 0], [0, 0], [0, 0]]);
    expect(vault).toEqual(snapshot);
    const ids = [...vault.values()].flatMap((md) => readImportNote(md).entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(64);
    expect([...vault.keys()]).toContain("Highlights/קיצור תולדות האנושות — יובל נח הררי.md");
  });

  it("the hub lists every imported highlight, searchable in Hebrew without niqqud", async () => {
    const vault = new Map<string, string>();
    await importAll(vault, [kindle(), kobo()]);
    const items = buildIndex([...vault].map(([path, content]) => ({ path, content })));
    expect(items.filter((i) => i.kind === "import")).toHaveLength(11);
    const hit = search(items, { text: "בראשית" });
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ note: "להשוות לפרק 2.", where: "loc. 1500–1502" });
  });

  it("an extended highlight replaces the shorter one; your writing outside the entries stays; a changed note updates", () => {
    const book = kindle().books[0];
    const first = mergeBookNote(null, book).content;
    const mine = first.replace("# Sapiens", "# Sapiens\n\nMy own summary.").replace("<!-- /hl -->", "<!-- /hl -->\n\nA thought of mine between entries.");
    const longer = { ...book, highlights: [{ ...book.highlights[1], id: highlightId(book.title, book.author, book.highlights[1].text + " More."), text: book.highlights[1].text + " More." }] };
    const r = mergeBookNote(mine, longer);
    expect([r.added, r.updated]).toEqual([0, 1]);
    expect(r.content).toContain("My own summary.");
    expect(r.content).toContain("A thought of mine between entries.");
    expect(r.content).toContain("collectively. More.");
    expect(readImportNote(r.content).entries).toHaveLength(2);
    const noteChanged = { ...book, highlights: [{ ...book.highlights[0], note: "Changed my mind." }] };
    const r2 = mergeBookNote(r.content, noteChanged);
    expect([r2.added, r2.updated]).toEqual([0, 1]);
    expect(readImportNote(r2.content).entries[0].note).toBe("Changed my mind.");
  });

  it("file names keep Hebrew and drop what a vault path can't hold", () => {
    expect(bookNotePath({ title: "A/B: C?", author: "" })).toBe("Highlights/A B C.md");
    expect(safeName("  ..hidden  ")).toBe("hidden");
    expect(safeName("")).toBe("Untitled");
    expect(normText("בְּרֵאשִׁית  ‏")).toBe("בראשית");
  });
});
