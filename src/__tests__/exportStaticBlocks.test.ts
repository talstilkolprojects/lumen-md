// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderHtmlDocument } from "../storage/exportHtml";

describe("static HTML export of Lumen blocks", () => {
  it("serializes interactive blocks as their source, not a never-hydrated placeholder", async () => {
    const md = "# Doc\n\n```mermaid\ngraph TD; Alpha-->Beta\n```\n\n```chart\ntype: bar\ndata: [1, 2, 3]\n```\n";
    const html = await renderHtmlDocument(md, { title: "Doc" });
    expect(html).toContain("Alpha--&gt;Beta");
    expect(html).toContain("type: bar");
    expect(html).toContain("lumen-static-block");
    expect(html).not.toMatch(/data-lumen-block-pending|Loading /);
  });
});

describe("HTML export direction", () => {
  it("opens a Hebrew note right-to-left with lang=he", async () => {
    const html = await renderHtmlDocument("# כותרת\n\nפסקה בעברית עם a few English words.", { title: "פתק" });
    expect(html).toMatch(/<html lang="he" dir="rtl"/);
  });

  it("keeps an English note left-to-right", async () => {
    const html = await renderHtmlDocument("# Title\n\nSome text, then שלום.", { title: "Doc" });
    expect(html).toMatch(/<html lang="en" dir="ltr"/);
  });

  it("ignores leading code when deciding, and honours an explicit dir", async () => {
    const md = "```js\nconst x = 1;\n```\n\n# פתק\n";
    expect(await renderHtmlDocument(md, { title: "Doc" })).toMatch(/dir="rtl"/);
    expect(await renderHtmlDocument(md, { title: "Doc", dir: "ltr", lang: "en" })).toMatch(/<html lang="en" dir="ltr"/);
  });
});
