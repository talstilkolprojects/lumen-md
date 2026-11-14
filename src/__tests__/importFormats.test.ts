/**
 * Tests for the *new* import-format converters (LaTeX, RST, AsciiDoc,
 * Org, OPML, MHTML). The DOCX/CSV/JSON/XML/HTML converters were already
 * covered by `fileFormats.test.ts` — this file fills the gap.
 */

import { describe, it, expect } from "vitest";
import {
  latexToMarkdown,
  rstToMarkdown,
  adocToMarkdown,
  orgToMarkdown,
  opmlToMarkdown,
  mhtmlToMarkdown,
  legacyDocToMarkdown,
  pdfToMarkdown,
  mergePdfPageTexts,
  ipynbToMarkdown,
  wxrToMarkdown,
  confluenceToMarkdown,
  fountainToMarkdown,
  isSupportedFormat,
} from "../storage/fileFormats";
import { markdownToIpynb } from "../storage/exportFormats";

// jsdom's File doesn't implement .arrayBuffer(); mirror fsConvert's stand-in.
function docFile(bytes: Uint8Array | number[]): File {
  const arr = new Uint8Array(bytes);
  return {
    name: "legacy.doc",
    arrayBuffer: async () => arr.buffer,
    text: async () => new TextDecoder().decode(arr),
  } as unknown as File;
}

describe("latexToMarkdown", () => {
  it("strips preamble and document wrappers", () => {
    const tex = `\\documentclass{article}\n\\begin{document}\n\\section{Hi}\nbody\n\\end{document}\n`;
    const md = latexToMarkdown(tex);
    expect(md).not.toContain("\\documentclass");
    expect(md).not.toContain("\\begin{document}");
    expect(md).toContain("## Hi");
    expect(md).toContain("body");
  });
  it("converts \\textbf and \\textit to markdown emphasis", () => {
    const md = latexToMarkdown("\\textbf{bold} \\textit{em}");
    expect(md).toContain("**bold**");
    expect(md).toContain("*em*");
  });
  it("converts \\section/subsection/subsubsection to # / ## / ###", () => {
    const md = latexToMarkdown("\\section{S}\n\\subsection{SS}\n\\subsubsection{SSS}");
    expect(md).toContain("## S");
    expect(md).toContain("### SS");
    expect(md).toContain("#### SSS");
  });
});

describe("rstToMarkdown", () => {
  it("converts underlined headings", () => {
    const rst = "Hello\n=====\n\nbody";
    const md = rstToMarkdown(rst);
    expect(md).toContain("# Hello");
    expect(md).toContain("body");
  });
  it("converts double-backtick inline code", () => {
    expect(rstToMarkdown("see ``npm test``")).toContain("`npm test`");
  });
});

describe("adocToMarkdown", () => {
  it("converts = headings to #", () => {
    expect(adocToMarkdown("= Title")).toContain("# Title");
    expect(adocToMarkdown("== Sub")).toContain("## Sub");
  });
  it("converts ``inline`` to `inline`", () => {
    expect(adocToMarkdown("see ``foo``")).toContain("`foo`");
  });
});

describe("orgToMarkdown", () => {
  it("converts * Heading to # Heading", () => {
    expect(orgToMarkdown("* Top\n** Sub")).toContain("# Top");
    expect(orgToMarkdown("* Top\n** Sub")).toContain("## Sub");
  });
  it("converts =code= to `code`", () => {
    expect(orgToMarkdown("see =foo=")).toContain("`foo`");
  });
  it("converts /italic/ to *italic*", () => {
    expect(orgToMarkdown("be /careful/")).toContain("*careful*");
  });
});

describe("opmlToMarkdown", () => {
  it("renders nested outlines as bullets", () => {
    const opml = `<?xml version="1.0"?><opml><head><title>List</title></head><body>
      <outline text="root">
        <outline text="child"/>
      </outline>
    </body></opml>`;
    const md = opmlToMarkdown(opml);
    expect(md).toContain("# List");
    expect(md).toContain("- root");
    expect(md).toContain("- child");
  });
  it("includes RSS xmlUrl as a markdown link target", () => {
    const opml = `<?xml version="1.0"?><opml><head/><body>
      <outline text="Feed" xmlUrl="https://example.com/rss"/>
    </body></opml>`;
    expect(opmlToMarkdown(opml)).toContain("[Feed](https://example.com/rss)");
  });
});

describe("mhtmlToMarkdown", () => {
  it("falls through to htmlToMarkdown when no boundary header is present", () => {
    expect(mhtmlToMarkdown("<h1>Hi</h1><p>body</p>")).toContain("# Hi");
  });
  it("picks the text/html part out of a multipart envelope", () => {
    const text = `Content-Type: multipart/related; boundary="X"

--X
Content-Type: text/plain

ignore me
--X
Content-Type: text/html

<h1>Hello</h1><p>web archive</p>
--X--`;
    const md = mhtmlToMarkdown(text);
    expect(md).toContain("# Hello");
    expect(md).toContain("web archive");
    expect(md).not.toContain("ignore me");
  });
});

describe("legacyDocToMarkdown (honest, no binary garbage)", () => {
  it("returns an honest notice instead of dumping noise when nothing is readable", async () => {
    const garbage = new Uint8Array(256).fill(0);
    garbage.set([0x01, 0x02, 0x03, 0x7f, 0x80, 0xff], 10);
    const out = await legacyDocToMarkdown(docFile(garbage));
    expect(out).toContain("Legacy .doc");
    expect(out).toContain("No readable text could be recovered");
    // Crucially: the fallback ends with the notice — no binary was appended.
    expect(out.trimEnd().endsWith("legacy .doc file._")).toBe(true);
  });

  it("recovers embedded readable text from surrounding binary", async () => {
    const sentence = "This is a readable paragraph extracted from the document file.";
    const pad = new Uint8Array(24); // zero bytes around the text
    const body = new TextEncoder().encode(sentence);
    const out = await legacyDocToMarkdown(docFile([...pad, ...body, ...pad]));
    expect(out).toContain(sentence);
    expect(out).not.toContain("No readable text could be recovered");
  });

  it("reroutes a .doc that is really RTF to the RTF converter", async () => {
    const rtf = new TextEncoder().encode("{\\rtf1\\ansi Hello from RTF}");
    const out = await legacyDocToMarkdown(docFile(rtf));
    expect(out).toContain("Hello");
    expect(out).not.toContain("Legacy .doc"); // took the RTF path, not the fallback
  });
});

describe("pdfToMarkdown (real pdfjs-dist extraction)", () => {
  // Build a minimal but valid single-page text PDF with correct xref offsets.
  function buildPdf(text: string): Uint8Array {
    const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefStart = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return new TextEncoder().encode(pdf);
  }

  it("extracts text from a real PDF (no CDN, local worker fallback)", async () => {
    const out = await pdfToMarkdown(docFile(buildPdf("Hello PDF Lumen")));
    expect(out).toContain("Hello PDF Lumen");
  }, 30000);

  it("returns an honest notice for an unreadable PDF instead of crashing", async () => {
    const junk = new TextEncoder().encode("%PDF-1.4\nthis is not a valid pdf body");
    const out = await pdfToMarkdown(docFile(junk));
    expect(out).toMatch(/Couldn't read this PDF|no extractable text/i);
  }, 30000);

  it("OCRs each blank page of a mixed PDF, not only all-blank PDFs", async () => {
    const asked: number[] = [];
    const out = await mergePdfPageTexts(["Cover title", "", "3"], async (n) => {
      asked.push(n);
      return `scanned page ${n}`;
    });
    expect(asked).toEqual([2]);
    expect(out).toContain("Cover title");
    expect(out).toContain("scanned page 2");
    expect(out.indexOf("Cover title")).toBeLessThan(out.indexOf("scanned page 2"));
    expect(out).toMatch(/OCR/);
    // No OCR available (tests/node): the text pages, unchanged.
    expect(await mergePdfPageTexts(["a", "", "b"], null)).toBe("a\n\n---\n\nb");
    expect(await mergePdfPageTexts(["", ""], async () => "")).toMatch(/no extractable text/);
  });
});

describe("ipynbToMarkdown (Jupyter notebook import)", () => {
  const ESC = String.fromCharCode(27);
  const nb = JSON.stringify({
    metadata: { language_info: { name: "python" } },
    cells: [
      { cell_type: "markdown", source: ["# Title\n", "Some **text**."] },
      {
        cell_type: "code",
        source: "print('hi')",
        outputs: [
          { output_type: "stream", text: "hi\n" },
          { output_type: "execute_result", data: { "text/plain": "42" } },
        ],
      },
      {
        cell_type: "code",
        source: "1/0",
        outputs: [
          {
            output_type: "error",
            traceback: [`${ESC}[31mZeroDivisionError${ESC}[0m: division by zero`],
          },
        ],
      },
    ],
  });

  it("passes markdown cells through and fences code in the kernel language", () => {
    const md = ipynbToMarkdown(nb);
    expect(md).toContain("# Title");
    expect(md).toContain("Some **text**.");
    expect(md).toContain("```python\nprint('hi')\n```");
  });

  it("includes outputs and strips ANSI from error tracebacks", () => {
    const md = ipynbToMarkdown(nb);
    expect(md).toContain("hi");
    expect(md).toContain("42");
    expect(md).toContain("ZeroDivisionError: division by zero");
    expect(md).not.toContain(ESC + "[");
  });

  it("returns an honest notice for invalid JSON", () => {
    expect(ipynbToMarkdown("{ not json")).toContain("Invalid .ipynb");
  });
});

describe("wxrToMarkdown (WordPress export)", () => {
  const wxr = `<?xml version="1.0"?>
<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <item>
    <title>Hello Blog</title>
    <dc:creator>alice</dc:creator>
    <wp:post_type>post</wp:post_type>
    <wp:status>publish</wp:status>
    <content:encoded><![CDATA[<h2>Intro</h2><p>First <strong>post</strong>.</p>]]></content:encoded>
  </item>
  <item>
    <title>A Draft</title>
    <wp:post_type>post</wp:post_type>
    <wp:status>draft</wp:status>
    <content:encoded><![CDATA[<p>secret content</p>]]></content:encoded>
  </item>
  <item>
    <title>logo.png</title>
    <wp:post_type>attachment</wp:post_type>
    <wp:status>inherit</wp:status>
  </item>
</channel>
</rss>`;

  it("converts published posts, skipping drafts and attachments", () => {
    const md = wxrToMarkdown(wxr);
    expect(md).toContain("# Hello Blog");
    expect(md).toContain("by alice");
    expect(md).toContain("## Intro");
    expect(md).toContain("First **post**.");
    expect(md).not.toContain("secret content");
    expect(md).not.toContain("logo.png");
  });

  it("returns an honest notice when there are no published posts", () => {
    expect(wxrToMarkdown("<rss><channel></channel></rss>")).toContain(
      "No published WordPress posts",
    );
  });
});

describe("markdownToIpynb (export) ↔ ipynbToMarkdown round-trip", () => {
  const md = "# Title\n\nSome prose.\n\n```python\nprint('hi')\n```\n\nMore prose.";

  it("produces a valid nbformat-4 notebook with code + markdown cells", () => {
    const nb = JSON.parse(markdownToIpynb(md));
    expect(nb.nbformat).toBe(4);
    expect(nb.metadata.language_info.name).toBe("python");
    const types = nb.cells.map((c: { cell_type: string }) => c.cell_type);
    expect(types).toContain("markdown");
    expect(types).toContain("code");
    const code = nb.cells.find((c: { cell_type: string }) => c.cell_type === "code");
    expect(code.outputs).toEqual([]);
    expect(code.execution_count).toBeNull();
  });

  it("round-trips back to markdown via ipynbToMarkdown", () => {
    const back = ipynbToMarkdown(markdownToIpynb(md));
    expect(back).toContain("# Title");
    expect(back).toContain("Some prose.");
    expect(back).toContain("```python\nprint('hi')\n```");
    expect(back).toContain("More prose.");
  });
});

describe("confluenceToMarkdown (Confluence export)", () => {
  const xhtml = `<div xmlns:ac="x" xmlns:ri="y">
  <h1>Page Title</h1>
  <p>Some <strong>text</strong>.</p>
  <ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[print("hi")]]></ac:plain-text-body></ac:structured-macro>
  <ac:structured-macro ac:name="info"><ac:rich-text-body><p>An info panel.</p></ac:rich-text-body></ac:structured-macro>
  <p>See <ac:link><ri:page ri:content-title="Other Page"/></ac:link> too.</p>
</div>`;

  it("converts code macros to fenced blocks and unwraps panels/links", () => {
    const md = confluenceToMarkdown(xhtml);
    expect(md).toContain("# Page Title");
    expect(md).toContain("Some **text**.");
    expect(md).toContain('print("hi")');
    expect(md).toContain("An info panel.");
    expect(md).toContain("Other Page");
    expect(md).not.toContain("ac:structured-macro");
    expect(md).not.toContain("<ri:");
  });
});

describe("fountainToMarkdown (screenwriting)", () => {
  const SCRIPT = [
    "Title: The Heist",
    "Author: Dana Lev",
    "Draft date: 2026-01-01",
    "",
    "# Act One",
    "",
    "= Dana cases the bank.",
    "",
    "INT. BANK LOBBY - DAY",
    "",
    "Dana walks in, scanning the cameras.",
    "",
    "DANA (V.O.)",
    "(quietly)",
    "Three exits. Two guards.",
    "",
    "> CUT TO:",
    "",
    ".ROOFTOP - CONTINUOUS",
    "",
    ">THE END<",
    "",
    "===",
    "",
    "/* boneyard: never show this */",
    "Some action [[with a private note]] here.",
    "~La la la",
  ].join("\n");

  const md = fountainToMarkdown(SCRIPT);

  it("maps the title page to a heading + bold metadata", () => {
    expect(md).toContain("# The Heist");
    expect(md).toContain("**Author:** Dana Lev");
    expect(md).toContain("**Draft date:** 2026-01-01");
  });

  it("maps sections, synopses and scene headings", () => {
    expect(md).toContain("## Act One"); // section shifted one level down
    expect(md).toContain("*Dana cases the bank.*");
    expect(md).toContain("## INT. BANK LOBBY - DAY");
    expect(md).toContain("## ROOFTOP - CONTINUOUS"); // forced "." heading
  });

  it("formats character cue, parenthetical and dialogue", () => {
    expect(md).toContain("**DANA (V.O.)**");
    expect(md).toContain("*(quietly)*");
    expect(md).toContain("> Three exits. Two guards.");
  });

  it("maps transitions, centered text and page breaks", () => {
    expect(md).toContain("*CUT TO:*");
    expect(md).toContain("**THE END**");
    expect(md).toContain("\n---\n");
  });

  it("strips boneyard comments and inline notes, keeps lyrics italic", () => {
    expect(md).not.toContain("boneyard");
    expect(md).not.toContain("private note");
    expect(md).toContain("Some action  here."); // note removed in-place
    expect(md).toContain("*La la la*");
  });

  it("does not treat plain action or ellipsis as headings/cues", () => {
    const md2 = fountainToMarkdown("...a beat.\n\nHe waits.\n");
    expect(md2).toContain("...a beat.");
    expect(md2).not.toContain("## ");
  });

  it(".fountain and .spmd are accepted import extensions", () => {
    expect(isSupportedFormat("script.fountain")).toBe(true);
    expect(isSupportedFormat("script.spmd")).toBe(true);
  });
});
