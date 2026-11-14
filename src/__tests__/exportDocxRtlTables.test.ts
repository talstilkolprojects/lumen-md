/**
 * Plan 9.8: a Hebrew pipe table opens in Word laid out from the right and
 * with its columns aligned as written. Word reads `w:jc` relative to the
 * paragraph's direction (`start` = leading edge: right in a `<w:bidi/>`
 * paragraph, left otherwise), so the writer resolves `:--` / `--:` against
 * each cell's direction and marks RTL tables `<w:bidiVisual/>`.
 *
 * The real check in Word is the owner's (plan 15.12); these tests read the
 * generated XML back.
 */
import { describe, expect, it } from "vitest";
import { markdownToDocxBytes, resolveJc } from "../storage/exportDocx";
import { unzip } from "../storage/zip";

const dec = new TextDecoder();

async function documentXml(md: string): Promise<string> {
  const files = await unzip((await markdownToDocxBytes(md)).buffer);
  return dec.decode(files.get("word/document.xml"));
}

/** The <w:tbl> elements of the document, in order; `n` of them are expected. */
function tables(doc: string, n: number): string[] {
  const all = doc.match(/<w:tbl>[^]*?<\/w:tbl>/g) ?? [];
  expect(all).toHaveLength(n);
  return all;
}

/** The cell paragraph holding `text`: its `<w:pPr>` content, or "" when it has none. */
function pPrOf(xml: string, text: string): string {
  const cell = (xml.match(/<w:tc>[^]*?<\/w:tc>/g) ?? []).find((c) => c.includes(`>${text}<`));
  if (!cell) throw new Error(`no cell with ${text}`);
  return cell.match(/<w:pPr>([^]*?)<\/w:pPr>/)?.[1] ?? "";
}

describe("resolveJc: physical alignment → Word's direction-relative justification", () => {
  it("in an LTR paragraph start is the left edge and end the right one", () => {
    expect(resolveJc("none", "ltr")).toBe("start");
    expect(resolveJc("left", "ltr")).toBe("start");
    expect(resolveJc("right", "ltr")).toBe("end");
    expect(resolveJc("center", "ltr")).toBe("center");
  });
  it("in an RTL paragraph start is the right edge and end the left one", () => {
    expect(resolveJc("none", "rtl")).toBe("start");
    expect(resolveJc("right", "rtl")).toBe("start");
    expect(resolveJc("left", "rtl")).toBe("end");
    expect(resolveJc("center", "rtl")).toBe("center");
  });
});

describe("DOCX: an RTL table", () => {
  const RTL = "| מוצר | מחיר | הערה | כמות |\n|---|--:|:--|:-:|\n| חלב | 5.90 | טרי | 2 |\n| Bread | 12 | fresh | 1 |\n";

  it("is laid out from the right (bidiVisual) and its cells follow the table when they have no strong text", async () => {
    const tbl = tables(await documentXml(RTL), 1)[0]!;
    expect(tbl).toMatch(/<w:tblPr><w:bidiVisual\/><w:tblW /);
    // A Hebrew cell: bidi, natural (start = right) alignment, nothing written.
    expect(pPrOf(tbl, "חלב")).toBe("<w:bidi/>");
    // A number in the price column (`--:`, physically right): the cell inherits the
    // table's RTL, where right is the leading edge → start, written as nothing.
    expect(pPrOf(tbl, "5.90")).toBe("<w:bidi/>");
    // The note column (`:--`, physically left): in an RTL cell left is the trailing edge → end.
    expect(pPrOf(tbl, "טרי")).toBe('<w:bidi/><w:jc w:val="end"/>');
    expect(pPrOf(tbl, "2")).toBe('<w:bidi/><w:jc w:val="center"/>');
  });

  it("resolves an English cell of the same table against its own LTR paragraph, so both land on the same side", async () => {
    const tbl = tables(await documentXml(RTL), 1)[0]!;
    expect(pPrOf(tbl, "Bread")).toBe("");
    // Note column, physically left: the leading edge of an LTR paragraph → start, nothing written.
    expect(pPrOf(tbl, "fresh")).toBe("");
    // The numbers in that row have no direction of their own: they follow the table, like every number in it.
    expect(pPrOf(tbl, "12")).toBe("<w:bidi/>");
    expect(pPrOf(tbl, "1")).toBe('<w:bidi/><w:jc w:val="center"/>');
  });

  it("a table of numbers follows the note's direction", async () => {
    const doc = await documentXml("# דוח\n\n| 1 | 2 |\n|---|--:|\n| 10 | 20 |\n");
    const tbl = tables(doc, 1)[0]!;
    expect(tbl).toContain("<w:bidiVisual/>");
    expect(pPrOf(tbl, "10")).toBe("<w:bidi/>");
    expect(pPrOf(tbl, "20")).toBe("<w:bidi/>"); // `--:` is the leading edge of an RTL cell
  });

  it("never writes the transitional left / right values", async () => {
    const doc = await documentXml(RTL + "\n| a | b |\n|:--|--:|\n| x | y |\n");
    expect(doc).not.toMatch(/<w:jc w:val="(left|right)"\/>/);
  });
});

describe("DOCX: an LTR table", () => {
  it("is not bidiVisual and resolves `:--` to start and `--:` to end", async () => {
    const tbl = tables(await documentXml("| Item | Price | Note |\n|:--|--:|:-:|\n| Milk | 5.90 | fresh |\n"), 1)[0]!;
    expect(tbl).not.toContain("<w:bidiVisual/>");
    expect(tbl).not.toContain("<w:bidi/>");
    expect(pPrOf(tbl, "Milk")).toBe("");
    expect(pPrOf(tbl, "5.90")).toBe('<w:jc w:val="end"/>');
    expect(pPrOf(tbl, "fresh")).toBe('<w:jc w:val="center"/>');
  });
});

describe("DOCX: a mixed document", () => {
  it("gives each table its own direction, and each cell its own", async () => {
    const md = "# Notes\n\n| Item | Price |\n|:--|--:|\n| Milk | 5 |\n\nטבלה בעברית:\n\n| מוצר | מחיר |\n|:--|--:|\n| חלב | 5 |\n";
    const [en, he] = tables(await documentXml(md), 2) as [string, string];
    expect(en).not.toContain("<w:bidiVisual/>");
    expect(he).toContain("<w:bidiVisual/>");
    // The same `--:` price column: end in the English table, start (omitted) in the Hebrew one.
    expect(pPrOf(en, "5")).toBe('<w:jc w:val="end"/>');
    expect(pPrOf(he, "5")).toBe("<w:bidi/>");
    // The same `:--` first column: start (omitted) in English, end in Hebrew.
    expect(pPrOf(en, "Milk")).toBe("");
    expect(pPrOf(he, "חלב")).toBe('<w:bidi/><w:jc w:val="end"/>');
  });

describe("DOCX: table direction comes from visible, strong text only (Codex P2s, #263)", () => {
  it("a link's hidden URL does not make a neutral table in a Hebrew note LTR", async () => {
    const md = "# כותרת\n\n| 1 | 2 |\n|---|---|\n| [10](https://example.com) | 20 |\n";
    const tbl = tables(await documentXml(md), 1)[0]!;
    expect(tbl).toContain("<w:bidiVisual/>");
    expect(pPrOf(tbl, "20")).toBe("<w:bidi/>");
  });

  it("Arabic-Indic digits keep an English table LTR and their cell neutral", async () => {
    const md = "# Title\n\n| ١٢ | Item |\n|---|---|\n| ٣٤ | tea |\n";
    const tbl = tables(await documentXml(md), 1)[0]!;
    expect(tbl).not.toContain("<w:bidiVisual/>");
    expect(pPrOf(tbl, "٣٤")).toBe("");
  });
});
});
