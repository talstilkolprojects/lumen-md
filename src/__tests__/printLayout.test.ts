/** W2.23 — print layout: direction, language, @page CSS, page breaks and the table of contents. */
import { describe, expect, it } from "vitest";
import { applyPageBreaks, buildToc, contentDirection, contentLang, cssString, printCss, printFrontmatter } from "../print/printLayout";

describe("contentDirection / contentLang", () => {
  it("takes the note's direction from its text, not code or markup", () => {
    expect(contentDirection("# כותרת\n\nטקסט")).toBe("rtl");
    expect(contentDirection("---\ntitle: Report\n---\n# דוח")).toBe("rtl");
    expect(contentDirection("```js\nconst x\n```\n\nשלום")).toBe("rtl");
    expect(contentDirection("![](http://x.png) שלום")).toBe("rtl");
    expect(contentDirection("Hello שלום")).toBe("ltr");
    expect(contentDirection("123")).toBe("ltr");
  });

  it("picks he or ar by letters, else the UI language", () => {
    expect(contentLang("שלום עולם hello", "en")).toBe("he");
    expect(contentLang("مرحبا بالعالم", "en")).toBe("ar");
    expect(contentLang("Hello world", "fr")).toBe("fr");
    expect(contentLang("Hello world", "he")).toBe("en");
  });
});

describe("printCss", () => {
  it("puts the title in the header and page / pages in the footer, in Hebrew numerals when asked", () => {
    const css = printCss({ title: "דוח", dir: "rtl", numbering: "hebrew" });
    expect(css).toContain('@top-center { content: "דוח"');
    expect(css).toContain('counter(page, hebrew) " / " counter(pages, hebrew)');
    expect(css).toContain("html { direction: rtl; }");
    expect(css).toContain("thead { display: table-header-group; }");
    expect(css).toMatch(/table, figure, img[^{]*\{ break-inside: avoid; \}/);
  });

  it("supports a footer, no numbers, Letter paper and an empty header", () => {
    const css = printCss({ title: "Memo", header: "", footer: "Confidential", numbering: "none", pageSize: "Letter", dir: "ltr" });
    expect(css).toContain("size: Letter");
    expect(css).toContain('@top-center { content: ""');
    expect(css).toContain('@bottom-center { content: "Confidential"');
    expect(css).not.toContain("counter(page");
  });

  it("escapes the title so it cannot leave the CSS string or the style element", () => {
    expect(cssString('a"b\\c\n</style>')).toBe('"a\\"b\\\\c \\3c /style\\3e "');
  });
});

describe("printFrontmatter", () => {
  it("reads toc, page-numbers, header, footer and page-size", () => {
    expect(printFrontmatter({ toc: true, "page-numbers": "hebrew", header: "H", footer: "F", "page-size": "letter" })).toEqual({
      toc: true,
      numbering: "hebrew",
      header: "H",
      footer: "F",
      pageSize: "Letter",
    });
    expect(printFrontmatter({ "page-numbers": "roman" })).toEqual({});
    expect(printFrontmatter(null)).toEqual({});
  });
});

describe("page breaks and table of contents", () => {
  it("turns \\newpage and \\pagebreak paragraphs into breaks", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>a</p><p>\\newpage</p><p>b</p><p> \\pagebreak </p><p>not \\newpage</p>";
    expect(applyPageBreaks(root)).toBe(2);
    expect(root.querySelectorAll(".page-break").length).toBe(2);
    expect(root.textContent).toContain("not \\newpage");
  });

  it("builds a nested table of contents from h1–h3 with ids", () => {
    const root = document.createElement("div");
    root.innerHTML = '<h1 id="a">מדריך</h1><h2 id="b">פרק 1</h2><h3 id="c">סעיף</h3><h2 id="d">פרק 2</h2><h4 id="e">deep</h4>';
    const toc = buildToc(root, "תוכן עניינים")!;
    expect(toc.querySelector("h2")!.textContent).toBe("תוכן עניינים");
    expect(Array.from(toc.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["#a", "#b", "#c", "#d"]);
    expect(toc.querySelectorAll("ol ol ol a").length).toBe(1);
    expect(buildToc(document.createElement("div"), "x")).toBe(null);
  });
});
