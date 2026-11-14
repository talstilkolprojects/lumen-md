/**
 * T44 — exports keep the direction: DOCX paragraphs/runs, LaTeX via
 * XeLaTeX + polyglossia, EPUB language and page progression, the static
 * site's pages. (HTML export: exportStaticBlocks / textDirection tests.)
 */
import { describe, it, expect } from "vitest";
import { markdownToDocxBytes } from "../storage/exportDocx";
import { markdownToEpubBytes, markdownToLatex, markdownToStaticSiteBytes } from "../storage/exportFormats";
import { unzip } from "../storage/zip";

const dec = new TextDecoder();
const MIXED = "# כותרת בעברית\n\nפסקה בעברית עם word אחד.\n\nAn English paragraph.\n\n- פריט\n- item\n\n| א | b |\n|---|---|\n| שלום | hi |\n";

describe("DOCX", () => {
  it("marks Hebrew paragraphs bidi and Hebrew runs rtl; English stays plain", async () => {
    const files = await unzip((await markdownToDocxBytes(MIXED)).buffer);
    const doc = dec.decode(files.get("word/document.xml"));
    const paras = doc.match(/<w:p>.*?<\/w:p>/g) ?? [];
    const he = paras.find((p) => p.includes("פסקה בעברית"))!;
    const en = paras.find((p) => p.includes("An English paragraph"))!;
    expect(he).toContain("<w:bidi/>");
    expect(he).toMatch(/<w:rPr>[^]*?<w:rtl\/>[^]*?<\/w:rPr><w:t[^>]*>פסקה/);
    expect(en).not.toContain("<w:bidi/>");
    expect(en).not.toContain("<w:rtl/>");
    // heading, list item and table cell too
    expect(paras.find((p) => p.includes("כותרת בעברית"))).toMatch(/<w:pStyle w:val="Heading1"\/><w:bidi\/>/);
    expect(paras.find((p) => p.includes("פריט"))).toContain("<w:bidi/>");
    expect(doc).toMatch(/<w:p><w:pPr><w:bidi\/><\/w:pPr><w:r><w:rPr><w:b\/><w:rtl\/><\/w:rPr><w:t xml:space="preserve">א<\/w:t>/);
  });
});

describe("LaTeX", () => {
  it("uses XeLaTeX + polyglossia with Hebrew as the main language for a Hebrew note", () => {
    const tex = markdownToLatex(MIXED);
    expect(tex).toMatch(/xelatex/);
    expect(tex).toContain("\\usepackage{polyglossia}");
    expect(tex).toContain("\\setmainlanguage{hebrew}");
    expect(tex).not.toContain("inputenc");
    expect(tex).toContain("\\begin{english}An English paragraph.\\end{english}");
    expect(tex).toContain("\\item \\textenglish{item}");
  });
  it("keeps the plain pdflatex preamble for English-only notes", () => {
    const tex = markdownToLatex("# Title\n\nJust English.");
    expect(tex).toContain("\\usepackage[utf8]{inputenc}");
    expect(tex).not.toContain("polyglossia");
  });
  it("English note with a Hebrew quote: English main, Hebrew wrapped", () => {
    const tex = markdownToLatex("# Notes\n\nEnglish first.\n\nשורה בעברית.");
    expect(tex).toContain("\\setmainlanguage{english}");
    expect(tex).toContain("\\begin{hebrew}שורה בעברית.\\end{hebrew}");
  });
});

describe("LaTeX RTL language (review fixes)", () => {
  it("an English-first document with Arabic later is set up for Arabic", () => {
    const tex = markdownToLatex("Intro in English.\n\nمرحبا بالعالم");
    expect(tex).toContain("\\setotherlanguage{arabic}");
    expect(tex).toContain("\\arabicfont");
    expect(tex).not.toContain("hebrew");
  });
  it("routes presentation-form Arabic and Hebrew through XeLaTeX", () => {
    // U+FEF5.. Arabic presentation forms (as copied from some PDFs), U+FB2A Hebrew.
    expect(markdownToLatex("\uFE8D\uFEDF\uFECC\uFEAE\uFE91\uFEF4\uFE94")).toContain("polyglossia");
    expect(markdownToLatex("\uFB2A\uFB31")).toContain("polyglossia");
  });
});

describe("EPUB", () => {
  it("is Hebrew for a Hebrew note with Latin frontmatter keys", async () => {
    const files = await unzip((await markdownToEpubBytes("---\ntitle: x\ntags: [a]\n---\n\n# פרק\n\nשלום לכולם, זה ספר בעברית.", "ספר")).buffer);
    const opf = dec.decode(files.get("OEBPS/content.opf"));
    expect(opf).toContain("<dc:language>he</dc:language>");
  });
  it("declares Hebrew and right-to-left page progression", async () => {
    const files = await unzip((await markdownToEpubBytes(MIXED, "ספר")).buffer);
    const opf = dec.decode(files.get("OEBPS/content.opf"));
    expect(opf).toContain("<dc:language>he</dc:language>");
    expect(opf).toContain('<spine page-progression-direction="rtl">');
    const ch = dec.decode([...files.entries()].find(([k]) => k.endsWith("chapter1.xhtml"))![1]);
    expect(ch).toMatch(/<html [^>]*xml:lang="he" lang="he" dir="rtl"/);
  });
  it("stays English / ltr for an English book", async () => {
    const files = await unzip((await markdownToEpubBytes("# Hi\n\nText.", "Book")).buffer);
    const opf = dec.decode(files.get("OEBPS/content.opf"));
    expect(opf).toContain("<dc:language>en</dc:language>");
    expect(opf).not.toContain("page-progression-direction");
  });
});

describe("static site", () => {
  it("gives Hebrew pages lang=he dir=rtl", async () => {
    const files = await unzip((await markdownToStaticSiteBytes("# בית\n\nשלום לכולם.\n\n# About\n\nEnglish page.", "אתר")).buffer);
    const pages = [...files.entries()].filter(([k]) => k.endsWith(".html")).map(([, v]) => dec.decode(v));
    expect(pages.some((p) => /<html lang="he" dir="rtl">/.test(p))).toBe(true);
    expect(pages.some((p) => /<html lang="en" dir="ltr">/.test(p))).toBe(true);
  });
  it("is not fooled by an escaped neutral character before the RTL text", async () => {
    const files = await unzip((await markdownToStaticSiteBytes("# & שלום\n\nשלום לכולם.", "אתר")).buffer);
    const pages = [...files.entries()].filter(([k]) => k.endsWith(".html")).map(([, v]) => dec.decode(v));
    expect(pages.some((p) => p.includes("&amp;"))).toBe(true);
    expect(pages.every((p) => /<html lang="he" dir="rtl">/.test(p))).toBe(true);
  });
});
