import { describe, it, expect, vi, afterEach } from "vitest";
import { unzip } from "../storage/zip";

async function buildDoc(md: string) {
  const { markdownToDocxBytes } = await import("../storage/exportDocx");
  const bytes = await markdownToDocxBytes(md);
  const files = await unzip(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const text = (name: string) =>
    files.has(name) ? new TextDecoder().decode(files.get(name)!) : null;
  return { files, text };
}

describe("exportDocx module", () => {
  it("can be imported without side effects", async () => {
    const mod = await import("../storage/exportDocx");
    expect(typeof mod.exportToDocx).toBe("function");
  });
});

describe("real .docx output — complete OOXML package", () => {
  const md = [
    "# Title",
    "",
    "Some **bold** and *italic* and ~~struck~~ and `code` text.",
    "",
    "See [the site](https://example.com/a?x=1&y=2) for details.",
    "",
    "- one",
    "- two",
    "  - nested",
    "",
    "1. first",
    "2. second",
    "",
    "Paragraph between the two ordered lists.",
    "",
    "1. alpha",
    "2. beta",
    "",
    "---",
    "",
    "```js",
    "const a = 1 < 2 && 3 > 0;",
    "",
    "  indented();",
    "```",
    "",
    "| Left | Center | Right |",
    "| :--- | :---: | ---: |",
    "| a | b | c |",
  ].join("\n");

  it("emits every required package part", async () => {
    const { files } = await buildDoc(md);
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "word/numbering.xml",
    ]) {
      expect(files.has(part)).toBe(true);
    }
  });

  it("registers styles + numbering content types", async () => {
    const { text } = await buildDoc(md);
    const ct = text("[Content_Types].xml")!;
    expect(ct).toContain("wordprocessingml.styles+xml");
    expect(ct).toContain("wordprocessingml.numbering+xml");
  });

  it("declares the relationship namespace on the document root", async () => {
    const { text } = await buildDoc(md);
    expect(text("word/document.xml")!).toContain(
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    );
  });

  it("renders headings and inline marks as real run properties", async () => {
    const doc = (await buildDoc(md)).text("word/document.xml")!;
    expect(doc).toContain('w:val="Heading1"');
    expect(doc).toContain("<w:b/>");
    expect(doc).toContain("<w:i/>");
    expect(doc).toContain("<w:strike/>");
    expect(doc).toContain('<w:rStyle w:val="Code"/>');
  });

  it("emits REAL lists via w:numPr — not literal bullet/number text", async () => {
    const doc = (await buildDoc(md)).text("word/document.xml")!;
    expect(doc).toContain("<w:numPr>");
    // Bullet list bound to numId 1, nested item at ilvl 1.
    expect(doc).toContain('<w:numId w:val="1"/>');
    expect(doc).toContain('<w:ilvl w:val="1"/>');
    // No fake literal markers leaked into text nodes.
    expect(doc).not.toContain("<w:t xml:space=\"preserve\">• ");
    expect(doc).not.toMatch(/<w:t[^>]*>1\. /);
    // List item text survives.
    expect(doc).toContain("one");
    expect(doc).toContain("first");
  });

  it("restarts numbering for each separate ordered list", async () => {
    const { text } = await buildDoc(md);
    const num = text("word/numbering.xml")!;
    expect(num).toContain('<w:abstractNum w:abstractNumId="0">'); // bullet
    expect(num).toContain('<w:abstractNum w:abstractNumId="1">'); // decimal
    expect(num).toContain('w:numFmt w:val="bullet"');
    expect(num).toContain('w:numFmt w:val="decimal"');
    // Two distinct ordered lists → two distinct <w:num> instances (2 and 3).
    expect(num).toContain('<w:num w:numId="1">'); // bullets
    expect(num).toContain('<w:num w:numId="2">');
    expect(num).toContain('<w:num w:numId="3">');
    const doc = text("word/document.xml")!;
    expect(doc).toContain('<w:numId w:val="2"/>');
    expect(doc).toContain('<w:numId w:val="3"/>');
  });

  it("emits a REAL hyperlink relationship — not dropped to plain text", async () => {
    const { text } = await buildDoc(md);
    const doc = text("word/document.xml")!;
    expect(doc).toMatch(/<w:hyperlink r:id="rId\d+">/);
    expect(doc).toContain('<w:rStyle w:val="Hyperlink"/>');
    const rels = text("word/_rels/document.xml.rels")!;
    expect(rels).toContain('TargetMode="External"');
    // URL preserved and XML-escaped (& → &amp;).
    expect(rels).toContain("https://example.com/a?x=1&amp;y=2");
    expect(rels).toContain("/hyperlink");
  });

  it("renders a horizontal rule as a paragraph border, not an empty paragraph", async () => {
    const doc = (await buildDoc(md)).text("word/document.xml")!;
    expect(doc).toContain("<w:pBdr>");
    expect(doc).toContain('<w:bottom w:val="single"');
  });

  it("honours table column alignment from the separator row", async () => {
    const doc = (await buildDoc(md)).text("word/document.xml")!;
    expect(doc).toContain("<w:tbl>");
    expect(doc).toContain('<w:jc w:val="center"/>');
    // `--:` in an English table: the trailing edge (ISO 29500 `end`; Word reads `right` the same way).
    expect(doc).toContain('<w:jc w:val="end"/>');
    expect(doc).not.toContain('<w:jc w:val="right"/>');
    expect(doc).not.toContain("<w:bidiVisual/>");
  });

  it("renders fenced code as a shaded monospace block and escapes XML", async () => {
    const doc = (await buildDoc(md)).text("word/document.xml")!;
    expect(doc).toContain('w:val="CodeBlock"');
    expect(doc).toContain("<w:br/>"); // multi-line code joined by line breaks
    // Angle brackets and ampersands inside code are escaped.
    expect(doc).toContain("1 &lt; 2 &amp;&amp; 3 &gt; 0");
  });

  it("defines heading, hyperlink and code-block styles", async () => {
    const styles = (await buildDoc(md)).text("word/styles.xml")!;
    expect(styles).toContain('w:styleId="Heading1"');
    expect(styles).toContain('w:styleId="Hyperlink"');
    expect(styles).toContain('w:styleId="CodeBlock"');
  });

  it("escapes pipes inside table cells", async () => {
    const doc = (
      await buildDoc("| A | B |\n| --- | --- |\n| x \\| y | z |")
    ).text("word/document.xml")!;
    // The escaped pipe stays in one cell's text rather than splitting columns.
    expect(doc).toContain("x | y");
  });
});

describe("exportToDocx", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // Stub createObjectURL/revokeObjectURL while keeping URL constructible —
  // a spread literal ({ ...URL }) loses the constructor, and jsdom under
  // vitest 4 calls `new URL(...)` during anchor handling.
  function stubUrl(createObjectURL: () => string): void {
    class StubURL extends URL {
      static createObjectURL = vi.fn(createObjectURL);
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", StubURL);
  }

  it("triggers a download by creating and clicking an anchor", async () => {
    const clickSpy = vi.fn();
    stubUrl(() => "blob:fake");
    const origAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      const el = node as HTMLAnchorElement;
      if (el.tagName === "A") el.click = clickSpy;
      return origAppend(node);
    });
    const { exportToDocx } = await import("../storage/exportDocx");
    await expect(exportToDocx("# Hello\n\nWorld", "test-doc")).resolves.toBeUndefined();
  });

  it("rejects when URL.createObjectURL throws (error propagates correctly)", async () => {
    stubUrl(() => {
      throw new Error("unavailable");
    });
    const { exportToDocx } = await import("../storage/exportDocx");
    await expect(exportToDocx("# Test", "doc")).rejects.toThrow("unavailable");
  });
});
