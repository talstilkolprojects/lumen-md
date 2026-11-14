/**
 * Israeli academic submission templates in the Word export (plan W5.16).
 *
 * Golden files: the document, styles, settings and footer parts of a
 * one-chapter Hebrew seminar paper, per institution, under
 * fixtures/academic/golden/. A change to the writer that moves a byte shows
 * up as a diff there. Regenerate on purpose with
 * `UPDATE_ACADEMIC_GOLDEN=1 npx vitest run src/__tests__/exportDocxAcademic.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docxPartsForTest, markdownToDocxBytes } from "../storage/exportDocx";
import { ACADEMIC_TEMPLATES, academicTemplate, cmToTwips, lineTwips, splitCover } from "../storage/academicTemplates";
import { unzip } from "../storage/zip";
import { seminarMarkdown } from "./fixtures/academic/seminar";

const GOLDEN = join(__dirname, "fixtures", "academic", "golden");
const UPDATE = !!process.env.UPDATE_ACADEMIC_GOLDEN;

/** One element per line, so a golden diff points at the paragraph that moved. */
function pretty(xml: string): string {
  return xml.replace(/(<w:(?:p|tbl|tr|style|footnote|sectPr|lvl)[ >])/g, "\n$1").trim() + "\n";
}

function academicParts(id: string, md = seminarMarkdown(1)) {
  const template = academicTemplate(id)!;
  return docxPartsForTest(md, { academic: { template, cover: splitCover(md).cover } });
}

describe("academic templates: the data", () => {
  it("has five institutions, each with a source guideline", () => {
    expect(ACADEMIC_TEMPLATES.map((t) => t.id)).toEqual(["huji", "biu", "haifa", "openu", "tau"]);
    for (const t of ACADEMIC_TEMPLATES) {
      expect(t.source).toMatch(/^https:\/\/[a-z0-9.-]+\.ac\.il\//);
      expect(t.institution.he).toMatch(/[֐-׿]/);
      expect(t.hebrewFont).toBe("David");
    }
  });

  it("converts centimetres and spacing to Word units", () => {
    expect(cmToTwips(2.54)).toBe(1440);
    expect(cmToTwips(3)).toBe(1701);
    expect(cmToTwips(2)).toBe(1134);
    expect(lineTwips(1.5)).toBe(360);
    expect(lineTwips(2)).toBe(480);
  });

  it("reads the cover from the frontmatter, Hebrew keys and quotes included", () => {
    const { cover, body, institution } = splitCover('---\nכותרת: "עבודה על כתיבה"\nמרצה: ד״ר לוי\nstudent_id: 123\ninstitution: biu\nunrelated: x\n---\n# פרק\n');
    expect(cover).toEqual({ title: "עבודה על כתיבה", lecturer: "ד״ר לוי", studentId: "123" });
    expect(institution).toBe("biu");
    expect(body).toBe("# פרק\n");
    expect(splitCover("# no frontmatter").cover).toEqual({});
  });
});

describe("academic templates: the guideline rules in the XML", () => {
  it.each(ACADEMIC_TEMPLATES.map((t) => [t.id, t] as const))("%s: margins, fonts, size and spacing", (_id, t) => {
    const parts = academicParts(t.id);
    const doc = parts["word/document.xml"];
    const styles = parts["word/styles.xml"];
    const m = t.marginsCm;
    expect(doc).toContain(`<w:pgMar w:top="${cmToTwips(m.top)}" w:right="${cmToTwips(m.right)}" w:bottom="${cmToTwips(m.bottom)}" w:left="${cmToTwips(m.left)}"`);
    expect(doc).toContain('<w:pgSz w:w="11906" w:h="16838"/>'); // A4
    expect(styles).toContain(`<w:rFonts w:ascii="${t.latinFont}" w:hAnsi="${t.latinFont}" w:cs="${t.hebrewFont}"/>`);
    expect(styles).toContain(`<w:sz w:val="${t.sizePt * 2}"/><w:szCs w:val="${t.sizePt * 2}"/>`);
    expect(styles).toContain(`w:line="${lineTwips(t.lineSpacing)}" w:lineRule="auto"`);
    expect(styles.includes('<w:jc w:val="both"/>')).toBe(t.justify);
    expect(styles.includes("<w:pageBreakBefore/>")).toBe(t.chapterOnNewPage);
  });

  it("three sections: an unnumbered title page, the table of contents, the body from 1", () => {
    const doc = academicParts("openu")["word/document.xml"];
    const sects = doc.match(/<w:sectPr>.*?<\/w:sectPr>/g)!;
    expect(sects).toHaveLength(3);
    expect(sects[0]).not.toContain("footerReference");
    expect(sects[1]).toContain('<w:pgNumType w:fmt="lowerRoman" w:start="1"/>');
    expect(sects[2]).toContain('<w:pgNumType w:fmt="decimal" w:start="1"/>');
    for (const s of sects) expect(s).toContain("<w:bidi/>"); // a Hebrew paper: right-to-left sections
  });

  it("front matter in Hebrew letters when asked", () => {
    const md = seminarMarkdown(1);
    const parts = docxPartsForTest(md, { academic: { template: academicTemplate("biu")!, cover: {}, frontNumbering: "hebrew1" } });
    expect(parts["word/document.xml"]).toContain('<w:pgNumType w:fmt="hebrew1" w:start="1"/>');
  });

  it("title page from the cover fields, in the document's language", () => {
    const doc = academicParts("biu")["word/document.xml"];
    const cover = doc.slice(0, doc.indexOf("<w:sectPr>"));
    for (const s of ["אוניברסיטת בר־אילן", "כלים דיגיטליים בכתיבה אקדמית בעברית", "קורס: סמינר בחקר הכתיבה (12-345)", "מרצה: ד״ר רונית כהן", "מגיש/ה: ישראל ישראלי", "ת״ז: 012345678"]) expect(cover).toContain(s);
    expect(cover).toContain('<w:pStyle w:val="Title"/><w:bidi/>');
  });

  it("table of contents: Word's TOC field over headings 1–3, updated on open", () => {
    const parts = academicParts("haifa");
    expect(parts["word/document.xml"]).toContain('<w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText>');
    expect(parts["word/document.xml"]).toContain('<w:pStyle w:val="TOC2"/><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">1.1 רקע</w:t>');
    expect(parts["word/settings.xml"]).toContain('<w:updateFields w:val="true"/>');
    expect(parts["word/footer1.xml"]).toContain(" PAGE ");
    expect(parts["word/_rels/document.xml.rels"]).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"');
  });

  it("bibliography: a new page, hanging-indent entries, no bullets", () => {
    const doc = academicParts("biu")["word/document.xml"];
    const bib = doc.slice(doc.indexOf("ביבליוגרפיה</w:t>") - 200);
    expect(bib).toContain('<w:pStyle w:val="Heading1"/><w:pageBreakBefore/><w:bidi/>');
    expect(bib.match(/<w:pStyle w:val="Bibliography"\/>/g)).toHaveLength(3);
    expect(bib).not.toContain("<w:numPr>");
  });

  it("links in an academic document take ids after the footer", () => {
    const parts = academicParts("tau", "# פרק\n\nראו [האתר](https://example.com/a).\n");
    expect(parts["word/document.xml"]).toContain('<w:hyperlink r:id="rId4">');
    expect(parts["word/_rels/document.xml.rels"]).toContain('Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a"');
  });
});

describe("footnotes (every export)", () => {
  const md = "פסקה עם הערה.[^a] ועוד אחת.[^b] וחוזרת.[^a] ואחת בלי הגדרה.[^zz]\n\n[^b]: Second, with a [link](https://example.com).\n[^a]: הערה ראשונה, *נטויה*.\n  המשך ההערה.\n";

  it("numbers notes in reference order and removes the definitions from the body", () => {
    const parts = docxPartsForTest(md);
    const doc = parts["word/document.xml"];
    expect(doc.match(/<w:footnoteReference w:id="(\d)"\/>/g)).toEqual(['<w:footnoteReference w:id="1"/>', '<w:footnoteReference w:id="2"/>', '<w:footnoteReference w:id="1"/>']);
    expect(doc).toContain("[^zz]"); // no definition: kept as written
    expect(doc).not.toContain("הערה ראשונה");
    const notes = parts["word/footnotes.xml"];
    expect(notes).toContain('<w:footnote w:type="separator" w:id="-1">');
    expect(notes).toContain('<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/><w:bidi/></w:pPr>');
    expect(notes).toContain("המשך ההערה");
    expect(notes).toContain("<w:i/><w:iCs/><w:rtl/>");
    expect(notes).toContain('<w:footnote w:id="2"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>');
    expect(notes).toContain("link (https://example.com)");
    expect(parts["[Content_Types].xml"]).toContain('PartName="/word/footnotes.xml"');
    expect(parts["word/settings.xml"]).toContain('<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>');
  });

  it("a note without footnotes keeps the six-part package", async () => {
    const files = await unzip((await markdownToDocxBytes("# Plain\n\ntext")).buffer as ArrayBuffer);
    expect([...files.keys()].sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/numbering.xml", "word/styles.xml"]);
  });

  it("a definition inside fenced code is code, not a note", () => {
    const doc = docxPartsForTest("```\n[^a]: not a note\n```\n")["word/document.xml"];
    expect(doc).toContain("[^a]: not a note");
  });
});

describe("golden DOCX XML per institution", () => {
  for (const t of ACADEMIC_TEMPLATES) {
    // The settings, footer and footnotes parts do not depend on the institution: one golden each.
    const shared = t.id === "biu" ? ["word/settings.xml", "word/footer1.xml", "word/footnotes.xml"] : [];
    for (const part of ["word/document.xml", "word/styles.xml", ...shared]) {
      it(`${t.id} ${part}`, () => {
        const got = pretty(academicParts(t.id)[part]);
        const file = join(GOLDEN, `${t.id}.${part.replace("word/", "")}`);
        if (UPDATE) {
          mkdirSync(GOLDEN, { recursive: true });
          writeFileSync(file, got);
        }
        expect(existsSync(file)).toBe(true);
        expect(got).toBe(readFileSync(file, "utf8"));
      });
    }
  }
});
