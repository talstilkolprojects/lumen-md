import { describe, it, expect } from "vitest";
import { firstStrongDirection, markdownBaseDirection, scriptLanguage } from "../lib/textDirection";

describe("firstStrongDirection", () => {
  it("is decided by the first strong character, not the first character", () => {
    expect(firstStrongDirection("  123 — שלום world")).toBe("rtl");
    expect(firstStrongDirection("(hello) שלום")).toBe("ltr");
    expect(firstStrongDirection("مرحبا")).toBe("rtl");
    expect(firstStrongDirection("Привет")).toBe("ltr");
    expect(firstStrongDirection("日本語")).toBe("ltr");
  });

  it("Arabic-Indic digits and combining marks are weak, not strong (Codex P2, #263)", () => {
    expect(firstStrongDirection("١٢")).toBeNull();
    expect(firstStrongDirection("۱۲۳")).toBeNull();
    expect(firstStrongDirection("١٢ abc")).toBe("ltr");
    expect(firstStrongDirection("١٢ مرحبا")).toBe("rtl");
    // A Hebrew point before its letter does not change the answer.
    expect(firstStrongDirection("\u05B0\u05D0")).toBe("rtl");
    expect(firstStrongDirection("\u05B0 a")).toBe("ltr");
  });

  it("is null for text with no strong character", () => {
    expect(firstStrongDirection("")).toBeNull();
    expect(firstStrongDirection("123 !? ---")).toBeNull();
  });
});

describe("markdownBaseDirection", () => {
  it("defaults to ltr", () => {
    expect(markdownBaseDirection("")).toBe("ltr");
    expect(markdownBaseDirection("# Hello\n\nworld")).toBe("ltr");
  });

  it("is rtl for a Hebrew note", () => {
    expect(markdownBaseDirection("# כותרת\n\nפסקה ראשונה")).toBe("rtl");
  });

  it("skips the frontmatter and fenced code, which are always ltr", () => {
    const md = "---\ntitle: Example\ntags: [a, b]\n---\n\n```js\nconsole.log(1)\n```\n\n# פתק\n";
    expect(markdownBaseDirection(md)).toBe("rtl");
  });

  it("honours a frontmatter dir key over the content", () => {
    expect(markdownBaseDirection("---\ndir: rtl\n---\n\n# English title")).toBe("rtl");
    expect(markdownBaseDirection("---\ndir: ltr\n---\n\n# כותרת")).toBe("ltr");
  });
});

describe("scriptLanguage", () => {
  it("names the language only when the script is unambiguous", () => {
    expect(scriptLanguage("שלום")).toBe("he");
    expect(scriptLanguage("مرحبا")).toBe("ar");
    expect(scriptLanguage("hello")).toBeNull();
    expect(scriptLanguage("Привет")).toBeNull();
    expect(scriptLanguage("")).toBeNull();
  });
});
