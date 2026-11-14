/**
 * The fixed parts of the .docx package (src/storage/exportDocx.ts): styles,
 * numbering, relationships, footnotes, settings, the page-number footer and
 * section properties, plus the namespaces and the XML escape both files use.
 * Split out of exportDocx.ts to keep it under the 800-line limit (W6.25);
 * moved as is.
 */
import { cmToTwips, lineTwips, type AcademicTemplate, type PageNumberFormat } from "./academicTemplates";

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";

export const BULLET_NUM_ID = 1; // numbering.xml <w:num> mapped to the bullet abstract
export const FIRST_ORDERED_NUM_ID = 2; // ordered lists allocate 2, 3, 4 … (restart each)
export const MAX_LIST_LEVEL = 8;

/** Escape text for use in XML text nodes and double-quoted attributes. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildStyles(academic?: AcademicTemplate): string {
  const headingSizes = [32, 28, 26, 24, 23, 22]; // half-points, H1..H6
  const headings = headingSizes
    .map((base, idx) => {
      // An academic document scales the headings from its body size (12 pt → 16, 14, 13 …).
      const sz = academic ? Math.round((base * academic.sizePt) / 11) : base;
      // A chapter (H1) starts on a new page where the guideline asks (CT_PPr: keepNext, pageBreakBefore).
      const pageBreak = academic?.chapterOnNewPage && idx === 0 ? "<w:pageBreakBefore/>" : "";
      // Complex-script bold and size so a Hebrew heading is bold and sized too.
      const rPr = academic ? `<w:b/><w:bCs/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : `<w:b/><w:sz w:val="${sz}"/>`;
      // An academic heading keeps its spacing single and does not justify.
      const spacing = academic ? `<w:spacing w:before="240" w:after="120" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="start"/>` : `<w:spacing w:before="240" w:after="60"/>`;
      return (
        `<w:style w:type="paragraph" w:styleId="Heading${idx + 1}">` +
        `<w:name w:val="heading ${idx + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
        `<w:pPr><w:keepNext/>${pageBreak}${spacing}<w:outlineLvl w:val="${idx}"/></w:pPr>` +
        `<w:rPr>${rPr}</w:rPr></w:style>`
      );
    })
    .join("");

  const sz = academic ? academic.sizePt * 2 : 22;
  const defaults = academic
    ? `<w:rFonts w:ascii="${esc(academic.latinFont)}" w:hAnsi="${esc(academic.latinFont)}" w:cs="${esc(academic.hebrewFont)}"/>` +
      `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="en-US" w:bidi="he-IL"/>`
    : `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/>`;
  // CT_PPr order: spacing, ind, jc.
  const normalPPr = academic
    ? `<w:spacing w:after="0" w:line="${lineTwips(academic.lineSpacing)}" w:lineRule="auto"/>` +
      (academic.firstLineIndentCm ? `<w:ind w:firstLine="${cmToTwips(academic.firstLineIndentCm)}"/>` : "") +
      (academic.justify ? `<w:jc w:val="both"/>` : "")
    : `<w:spacing w:after="120"/>`;
  const fnSz = academic ? academic.footnoteSizePt * 2 : 20;
  const academicStyles = academic
    ? `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>` +
      `<w:pPr><w:spacing w:before="2400" w:after="480" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr>` +
      `<w:rPr><w:b/><w:bCs/><w:sz w:val="${sz + 16}"/><w:szCs w:val="${sz + 16}"/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="CoverLine"><w:name w:val="Cover Line"/><w:basedOn w:val="Normal"/>` +
      `<w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/>` +
      `<w:pPr><w:pageBreakBefore w:val="0"/><w:outlineLvl w:val="9"/></w:pPr></w:style>` +
      [1, 2, 3]
        .map(
          (l) =>
            `<w:style w:type="paragraph" w:styleId="TOC${l}"><w:name w:val="toc ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
            `<w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/><w:ind w:start="${(l - 1) * 360}" w:firstLine="0"/><w:jc w:val="start"/></w:pPr></w:style>`,
        )
        .join("") +
      // A bibliography entry: single spacing inside, a blank line between, a hanging indent (BIU).
      `<w:style w:type="paragraph" w:styleId="Bibliography"><w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/>` +
      `<w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:ind w:start="720" w:hanging="720"/><w:jc w:val="start"/></w:pPr></w:style>`
    : "";

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="${W}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>` +
    defaults +
    `</w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>` +
    `<w:pPr>${normalPPr}</w:pPr></w:style>` +
    headings +
    academicStyles +
    // Footnotes: single spacing, smaller, the mark superscript.
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:sz w:val="${fnSz}"/><w:szCs w:val="${fnSz}"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/>` +
    `<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>` +
    `<w:basedOn w:val="Normal"/><w:pPr><w:contextualSpacing/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="CCCCCC"/></w:pBdr>` +
    `<w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>` +
    `<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="Code"><w:name w:val="Code Char"/>` +
    `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr></w:style>` +
    `</w:styles>`
  );
}

export function buildNumbering(orderedNumIds: number[]): string {
  const bulletGlyphs = ["•", "◦", "▪"]; // • ◦ ▪
  const levels = (kind: "bullet" | "decimal") =>
    Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, l) => {
      const left = 720 * (l + 1);
      if (kind === "bullet") {
        const glyph = bulletGlyphs[l % bulletGlyphs.length];
        return (
          `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
          `<w:lvlText w:val="${esc(glyph)}"/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`
        );
      }
      return (
        `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
        `<w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`
      );
    }).join("");

  const abstracts =
    `<w:abstractNum w:abstractNumId="0">${levels("bullet")}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1">${levels("decimal")}</w:abstractNum>`;

  const nums =
    `<w:num w:numId="${BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>` +
    orderedNumIds
      .map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/></w:num>`)
      .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="${W}">${abstracts}${nums}</w:numbering>`
  );
}

export interface ExtraRel {
  id: string;
  type: string;
  target: string;
}

export function buildDocumentRels(hyperlinks: { id: string; target: string }[], extra: ExtraRel[]): string {
  const links = hyperlinks
    .map(
      (h) =>
        `<Relationship Id="${h.id}" Type="${R}/hyperlink" Target="${esc(h.target)}" TargetMode="External"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>` +
    extra.map((e) => `<Relationship Id="${e.id}" Type="${R}/${e.type}" Target="${e.target}"/>`).join("") +
    links +
    `</Relationships>`
  );
}

/** word/footnotes.xml: the two separators Word expects, then the notes. */
export function buildFootnotes(notes: { xml: string }[]): string {
  const sep = (type: string, id: number, el: string) =>
    `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${el}/></w:r></w:p></w:footnote>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:footnotes xmlns:w="${W}" xmlns:r="${R}" xmlns:m="${M}">` +
    sep("separator", -1, "separator") +
    sep("continuationSeparator", 0, "continuationSeparator") +
    notes.map((n) => n.xml).join("") +
    `</w:footnotes>`
  );
}

/** word/settings.xml: update fields on open (the table of contents), the footnote separators (CT_Settings order). */
export function buildSettings(updateFields: boolean, footnotes: boolean): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:settings xmlns:w="${W}">` +
    (updateFields ? `<w:updateFields w:val="true"/>` : "") +
    (footnotes ? `<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>` : "") +
    `</w:settings>`
  );
}

/** A footer with the page number, centred (each section's pgNumType sets the format). */
export function buildPageFooter(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `</w:p></w:ftr>`
  );
}

export const FOOTER_REL = "rId3";

/** A section's properties (CT_SectPr order: footerReference, pgSz, pgMar, pgNumType, bidi). */
export function sectPrXml(t: AcademicTemplate | null, rtl: boolean, numbering: PageNumberFormat, restart: boolean): string {
  const m = t?.marginsCm;
  const mar = m
    ? `<w:pgMar w:top="${cmToTwips(m.top)}" w:right="${cmToTwips(m.right)}" w:bottom="${cmToTwips(m.bottom)}" w:left="${cmToTwips(m.left)}" w:header="708" w:footer="708" w:gutter="0"/>`
    : `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>`;
  const footer = numbering !== "none" ? `<w:footerReference w:type="default" r:id="${FOOTER_REL}"/>` : "";
  const pgNum = numbering !== "none" ? `<w:pgNumType w:fmt="${numbering}"${restart ? ' w:start="1"' : ""}/>` : "";
  return `<w:sectPr>${footer}<w:pgSz w:w="11906" w:h="16838"/>${mar}${pgNum}${rtl ? "<w:bidi/>" : ""}</w:sectPr>`;
}

/** An empty paragraph that ends a section: the section's properties ride on it. */
export function sectionBreak(sectPr: string): string {
  return `<w:p><w:pPr>${sectPr}</w:pPr></w:p>`;
}
