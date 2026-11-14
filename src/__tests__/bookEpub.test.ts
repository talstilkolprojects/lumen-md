/**
 * Book assembly (plan W5.8): a Hebrew RTL EPUB 3 package and the print
 * document. Structure checks here; the full epubcheck 5.3 run and the PDF
 * are in docs/src/content/docs/writing/book.md ("How it was checked").
 */
import { describe, it, expect } from "vitest";
import { buildEpub, chapterXhtml, epubDate, type EpubBook } from "../book/epub";
import { bookPrintDocument } from "../book/print";
import { unzip } from "../storage/zip";

const chapter = (i: number) => ({
  title: `פרק ${i}`,
  html: `<p>זהו פרק ${i}. ראו <a href="Other%20note.md">פתק אחר</a>, <a href="https://example.com">אתר</a> ו<a href="#fn-1">הערה</a>.</p><img src="pics/a.png" alt="תמונה"><img src="missing.png" alt="חסרה"><ul><li><input type="checkbox" checked disabled> נעשה</li></ul><script>alert(1)</script><p id="fn-1">הערה</p><p id="1st">x</p>`,
  lang: "he",
  dir: "rtl" as const,
});

const book = (n: number): EpubBook => ({
  title: "ספר הבדיקה",
  author: "נועה כהן",
  lang: "he",
  dir: "rtl",
  identifier: "urn:uuid:12345678-1234-5123-8123-123456789abc",
  modified: new Date("2026-11-12T10:20:30.456Z"),
  chapters: Array.from({ length: n }, (_, i) => chapter(i + 1)),
  font: { family: "Frank Ruhl Libre", files: [{ bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1]), weight: 400 }] },
  assets: async (src) => (src === "pics/a.png" ? { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" } : null),
  labels: { contents: "תוכן העניינים", titlePage: "עמוד השער" },
});

const files = (bytes: Uint8Array): Promise<Map<string, Uint8Array>> => unzip(bytes.slice().buffer);
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe("EPUB 3 of a Hebrew book (W5.8)", () => {
  it("starts with a stored mimetype, then the package; RTL page progression; nav, title page, font", async () => {
    const bytes = await buildEpub(book(3));
    // The first entry is `mimetype`, stored, at offset 30 of the file.
    expect(text(bytes.slice(30, 38))).toBe("mimetype");
    expect(text(bytes.slice(38, 58))).toBe("application/epub+zip");
    const f = await files(bytes);
    const opf = text(f.get("OEBPS/content.opf"));
    expect(opf).toContain('<spine page-progression-direction="rtl">');
    expect(opf).toContain("<dc:language>he</dc:language>");
    expect(opf).toContain("<dc:creator>נועה כהן</dc:creator>");
    expect(opf).toContain('<meta property="dcterms:modified">2026-11-12T10:20:30Z</meta>');
    expect(opf).toContain('properties="nav"');
    expect(opf).toContain('media-type="font/woff2"');
    expect(opf).toContain('href="images/img1.png" media-type="image/png"');
    // Every manifest item is in the zip, and every chapter is in the spine.
    for (const m of opf.matchAll(/href="([^"]+)"/g)) expect(f.has(`OEBPS/${m[1]}`), m[1]).toBe(true);
    expect((opf.match(/<itemref /g) ?? []).length).toBe(3 + 2);
    const nav = text(f.get("OEBPS/nav.xhtml"));
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('dir="rtl"');
    expect((nav.match(/<li><a href="ch\d{3}\.xhtml">/g) ?? []).length).toBe(3);
    expect(text(f.get("OEBPS/book.css"))).toContain('@font-face { font-family: "Frank Ruhl Libre"; src: url("fonts/font1.woff2")');
  });

  it("each chapter is well-formed XHTML in Hebrew, right to left, with nothing an EPUB may not hold", async () => {
    const f = await files(await buildEpub(book(2)));
    const ch = text(f.get("OEBPS/ch001.xhtml"));
    expect(ch).toMatch(/<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" xmlns:epub="http:\/\/www\.idpf\.org\/2007\/ops" lang="he" xml:lang="he" dir="rtl">/);
    const parsed = new DOMParser().parseFromString(ch, "application/xhtml+xml");
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(ch).not.toContain("<script");
    expect(ch).not.toContain("<input");
    expect(ch).toContain("☑");
    // A link into the vault is text; the web and the in-chapter anchor stay.
    expect(ch).not.toContain("Other%20note.md");
    expect(ch).toContain('href="https://example.com"');
    expect(ch).toContain('href="#fn-1"');
    // An image the vault has is embedded; a missing one is its alt text.
    expect(ch).toContain('src="images/img1.png"');
    expect(ch).not.toContain("missing.png");
    expect(ch).toContain("חסרה");
    // XML ids may not start with a digit.
    expect(ch).toContain('id="x-1st"');
  });

  it("dates and ids are what epubcheck wants", async () => {
    expect(epubDate(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03:04:05Z");
    const images = new Map();
    expect(await chapterXhtml("", images, undefined)).toBe("");
  });

  it("assembles 30 chapters in well under 10 s", async () => {
    const start = performance.now();
    const bytes = await buildEpub(book(30));
    expect(performance.now() - start).toBeLessThan(10_000);
    const f = await files(bytes);
    expect([...f.keys()].filter((k) => /^OEBPS\/ch\d{3}\.xhtml$/.test(k))).toHaveLength(30);
  });
});

describe("print document of a Hebrew book (W5.8)", () => {
  it("title page, contents, each chapter on a new page, page numbers, Hebrew RTL", () => {
    const html = bookPrintDocument({ title: "ספר", author: "נועה", lang: "he", dir: "rtl", chapters: [chapter(1), chapter(2)], labels: { contents: "תוכן העניינים" }, fonts: [{ family: "Frank Ruhl Libre", url: "fonts/frank.woff2", weight: 400 }] });
    expect(html).toMatch(/^<!doctype html>\n<html lang="he" dir="rtl">/);
    expect(html).toContain("section.chapter { break-before: page; }");
    expect(html).toContain("@bottom-center { content: counter(page);");
    expect(html).toContain('<a href="#chapter-2">פרק 2</a>');
    expect(html).toContain('<section class="chapter" id="chapter-1" lang="he" dir="rtl">');
    expect(html).toContain('src: url("fonts/frank.woff2")');
  });
});
