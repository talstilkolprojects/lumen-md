/**
 * Plan W1.26 — the import wizard's building blocks: names, archive paths,
 * source detection, CSV and date parsing, MIME, Bear syntax, link counting.
 */
import { describe, expect, it } from "vitest";
import { claimPath, mdDest, relativeTo, safeName, safePath } from "../storage/import/names";
import { cleanArchivePath, detectImportSource, stripWrapper } from "../storage/import/convert";
import { databaseBase, notionDate, parseCsv, typeColumn } from "../storage/import/notion";
import { enexDate } from "../storage/import/evernote";
import { journalDate, pageName } from "../storage/import/logseq";
import { parseMhtml } from "../storage/import/htmlNotes";
import { bearToMarkdown } from "../storage/import/bear";
import { linkStats, linkTargets } from "../storage/import/links";
import { md5Hex } from "../storage/import/md5";
import { splitFrontmatter, withFrontmatter } from "../storage/import/frontmatter";
import { parseBase, propertyLabel } from "../views/bases/base";

const enc = new TextEncoder();

describe("names", () => {
  it("keeps Hebrew and every script; replaces only what a file system refuses", () => {
    expect(safeName("סיכום: פגישה/שבועית?")).toBe("סיכום- פגישה-שבועית-");
    expect(safeName(`\u{200f}שלום\u{200e} עולם`)).toBe("שלום עולם");
    expect(safeName("...hidden")).toBe("hidden");
    expect(safeName("CON")).toBe("CON-");
    expect(safeName("   ")).toBe("Untitled");
    expect([...safeName("א".repeat(300))].length).toBe(120);
    // NFC: a precomposed and a decomposed "é" are one name.
    expect(safeName("cafe\u{301}")).toBe("caf\u{e9}");
  });

  it("safePath keeps folders and lower-cases the extension", () => {
    expect(safePath("תיקייה/שם:קובץ.PNG")).toBe("תיקייה/שם-קובץ.png");
  });

  it("claimPath numbers a taken name, case-insensitively", () => {
    const taken = new Set<string>();
    expect(claimPath(taken, "a/Note.md")).toBe("a/Note.md");
    expect(claimPath(taken, "a/note.md")).toBe("a/note 2.md");
    expect(claimPath(taken, "a/Note.md")).toBe("a/Note 3.md");
  });

  it("relative paths and link destinations with spaces", () => {
    expect(relativeTo("pages/Project", "assets/board.png")).toBe("../../assets/board.png");
    expect(mdDest("a b/c (1).png")).toBe("<a b/c (1).png>");
    expect(mdDest("plain.png")).toBe("plain.png");
  });
});

describe("archives", () => {
  it("a path in the archive never climbs out of the import (zip slip)", () => {
    expect(cleanArchivePath("../../etc/passwd")).toBe("etc/passwd");
    expect(cleanArchivePath("a\\b\\..\\c.md")).toBe("a/c.md");
    expect(cleanArchivePath("/./")).toBeNull();
  });

  it("drops only the archive's own top folder, never a Bear note bundle", () => {
    const m = (paths: string[]) => new Map(paths.map((p) => [p, new Uint8Array()]));
    expect([...stripWrapper(m(["V/a.md", "V/b/c.md"])).keys()]).toEqual(["a.md", "b/c.md"]);
    expect([...stripWrapper(m(["N.textbundle/text.md", "N.textbundle/info.json"])).keys()]).toEqual(["N.textbundle/text.md", "N.textbundle/info.json"]);
    expect([...stripWrapper(m(["a.md", "V/b.md"])).keys()]).toEqual(["a.md", "V/b.md"]);
  });

  it("detects each source from its files", () => {
    expect(detectImportSource([".obsidian/app.json", "a.md"])).toBe("obsidian");
    expect(detectImportSource(["logseq/config.edn", "pages/a.md"])).toBe("logseq");
    expect(detectImportSource(["Notebook.enex"])).toBe("evernote");
    expect(detectImportSource(["A.textbundle/text.md"])).toBe("bear");
    expect(detectImportSource(["Page.mht"])).toBe("onenote");
    expect(detectImportSource(["Keep/a.json", "Keep/a.html"])).toBe("keep");
    expect(detectImportSource([`Page ${"ab".repeat(16)}.md`])).toBe("notion");
    expect(detectImportSource(["iCloud/a.html"])).toBe("appleNotes");
    expect(detectImportSource(["a.md", "b/c.md"])).toBe("lumen");
  });
});

describe("Notion", () => {
  it("CSV: quotes, doubled quotes, newlines in a field, a BOM", () => {
    expect(parseCsv('\u{feff}Name,Notes\n"A, B","say ""hi""\nline 2"\r\nC,\n')).toEqual([
      ["Name", "Notes"],
      ["A, B", 'say "hi"\nline 2'],
      ["C", ""],
    ]);
  });

  it("dates as Notion writes them", () => {
    expect(notionDate("January 31, 2024")).toBe("2024-01-31");
    expect(notionDate("@March 5, 2023 2:30 PM")).toBe("2023-03-05T14:30");
    expect(notionDate("December 1, 2022 12:05 AM")).toBe("2022-12-01T00:05");
    expect(notionDate("2024/1/2")).toBe("2024-01-02");
    expect(notionDate("soon")).toBeNull();
  });

  it("a column's cells are typed together: checkbox, number, date, relation, text", () => {
    expect(typeColumn(["Yes", "No", ""])).toEqual([true, false, null]);
    expect(typeColumn(["1,200", "3.5"])).toEqual([1200, 3.5]);
    expect(typeColumn(["Yes", "maybe"])).toEqual(["Yes", "maybe"]);
    expect(typeColumn(["Dune (Dune%2005.md), Emma (https://www.notion.so/Emma-1)"])).toEqual([["[[Dune]]", "[[Emma]]"]]);
  });

  it("the .base of a database has the same columns, in order", () => {
    const text = databaseBase({ title: "ספרים", columns: ["שם", "Author", "Due date"] }, "Imported/x/ספרים");
    const p = parseBase(text);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.base.views[0].order.map((id) => propertyLabel(p.base, id))).toEqual(["שם", "Author", "Due date"]);
    expect(p.base.filters).toEqual({ and: ['file.inFolder("Imported/x/ספרים")', 'file.ext == "md"'] });
  });
});

describe("dates and names of the other sources", () => {
  it("Evernote dates", () => {
    expect(enexDate("20240131T101500Z")).toBe("2024-01-31T10:15:00Z");
    expect(enexDate("garbage")).toBeUndefined();
  });

  it("Logseq journals and namespaces", () => {
    expect(journalDate("2024_01_31")).toBe("2024-01-31");
    expect(journalDate("Jan 31st, 2024")).toBe("2024-01-31");
    expect(journalDate("Feb 2nd, 2024")).toBe("2024-02-02");
    expect(journalDate("Project")).toBeNull();
    expect(pageName("a___b___c")).toBe("a/b/c");
    expect(pageName("a%2Fb")).toBe("a/b");
    expect(pageName("100%")).toBe("100%");
  });
});

describe("MIME (OneNote .mht)", () => {
  it("decodes quoted-printable UTF-8 (Hebrew) and base64 parts", () => {
    const parts = parseMhtml(
      ['Content-Type: multipart/related; boundary="B"', "", "--B", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "<p>=D7=A9=D7=9C=\r\n=D7=95=D7=9D</p>", "--B", "Content-Location: file:///x/img.png", "Content-Transfer-Encoding: base64", "Content-Type: image/png", "", btoa("abc"), "--B--"].join("\r\n"),
    );
    expect(parts.map((p) => p.type)).toEqual(["text/html", "image/png"]);
    expect(new TextDecoder().decode(parts[0].data)).toBe("<p>שלום</p>");
    expect(new TextDecoder().decode(parts[1].data)).toBe("abc");
    expect(parts[1].location).toBe("file:///x/img.png");
  });
});

describe("Bear syntax", () => {
  it("highlights and closed tags, code untouched", () => {
    expect(bearToMarkdown("::hi:: #two words# `::x::`\n```\n::y::\n```")).toBe("==hi== #two-words `::x::`\n```\n::y::\n```");
  });
});

describe("links", () => {
  it("finds wikilinks, embeds and relative Markdown links; not in code, not URLs", () => {
    const md = "[[a]] ![[b.png|200]] [[c#h|x]] [x](d.md) ![](<e f.png>) [w](https://example.com) [s](#top)\n`[[no]]`\n```\n[[no]]\n```\n";
    expect(linkTargets(md).map((l) => l.target)).toEqual(["a", "b.png", "c", "d.md", "e f.png"]);
  });

  it("resolves like Obsidian: by name, by path suffix, relative for Markdown links", () => {
    const notes = new Map([
      ["pages/Project/Alpha.md", "[[Meeting]] [[Project/Alpha]] [x](../../assets/a.png) [[missing]]"],
      ["pages/meeting.md", "[up](Project/Alpha.md)"],
    ]);
    const s = linkStats({ notes, attachments: new Map([["assets/a.png", new Uint8Array()]]) });
    expect([s.total, s.resolved]).toEqual([5, 4]);
    expect(s.unresolved).toEqual([{ path: "pages/Project/Alpha.md", target: "missing" }]);
  });
});

describe("md5 and frontmatter", () => {
  it("md5 matches the RFC 1321 vectors", () => {
    expect(md5Hex(enc.encode(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(enc.encode("message digest"))).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex(enc.encode("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("imported properties fill in, the note's own win, empty ones are left out, broken YAML is left alone", () => {
    expect(withFrontmatter({ created: "2024-01-01", tags: [], x: null }, "# t\n")).toBe("---\ncreated: 2024-01-01\n---\n\n# t\n");
    const merged = withFrontmatter({ a: 1, b: 2 }, "---\nb: mine\n---\nbody\n");
    expect(splitFrontmatter(merged).props).toEqual({ a: 1, b: "mine" });
    expect(withFrontmatter({ a: 1 }, "---\n: [\n---\nbody")).toBe("---\n: [\n---\nbody");
  });
});
