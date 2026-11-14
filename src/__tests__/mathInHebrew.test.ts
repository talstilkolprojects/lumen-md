/**
 * Plan W5.14: math inside Hebrew text. Formulas are found in the source,
 * left out of the line-direction rule, marked as LTR isolates once
 * rendered, and written to Word as math zones. The 50 golden lines
 * (fixtures/math-he/lines.json) are Hebrew sentences with numbers and
 * inline formulas.
 *
 * Their on-screen order (preview and source, screen and print) and the
 * order in a printed PDF are measured in real browsers by
 * e2e/math-in-hebrew.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayMathLines, inlineMathSpans, rehypeMathIsolate, withoutInlineMath } from "../lib/mathIsolate";
import { markdownLineDirection } from "../lib/bidiDirection";
import { latinForHebrewKey } from "../lib/mathKeys";
import { markdownToDocxBytes } from "../storage/exportDocx";
import { unzip } from "../storage/zip";

interface Line {
  id: string;
  line: string;
  formula: string;
  before: string;
  after: string;
}
const LINES: Line[] = JSON.parse(readFileSync(join(__dirname, "fixtures", "math-he", "lines.json"), "utf8")).items;
const spansText = (s: string) => inlineMathSpans(s).map(([a, b]) => s.slice(a, b));

describe("finding formulas in the source", () => {
  it("finds $…$ and $$…$$ on a line", () => {
    expect(spansText("נתון $x^2+1$ ו-$$y$$ כאן")).toEqual(["$x^2+1$", "$$y$$"]);
    expect(spansText("הראו ש$a+b=c$.")).toEqual(["$a+b=c$"]);
  });
  it("leaves money, escaped dollars and code alone", () => {
    expect(spansText("עלה $5 ואחר כך $10")).toEqual([]);
    expect(spansText("המחיר \\$5 ו-\\$6")).toEqual([]);
    expect(spansText("קוד `$x$` כאן")).toEqual([]);
    expect(spansText("$ x$ ו-$x $")).toEqual([]);
  });
  it("finds every formula of the 50 golden lines", () => {
    expect(LINES.length).toBe(50);
    for (const l of LINES) {
      const found = spansText(l.line);
      expect({ id: l.id, first: found[0] }).toEqual({ id: l.id, first: `$${l.formula}$` });
      expect(found.length).toBe((l.line.match(/\$/g) ?? []).length / 2);
    }
  });
  it("finds display blocks, not inside fenced code", () => {
    expect([...displayMathLines(["טקסט", "$$", "x^2", "$$", "```", "$$", "```"])]).toEqual([1, 2, 3]);
  });
});

describe("line direction (9.7's rule) leaves formulas out", () => {
  it("a Hebrew sentence that opens with a formula is right to left", () => {
    expect(markdownLineDirection("$x^2$ הוא ריבוע")).toBe("rtl");
    expect(markdownLineDirection("- $f(x)=3x$ היא פונקציה")).toBe("rtl");
    expect(markdownLineDirection("$E=mc^2$ is famous")).toBe("ltr");
    expect(withoutInlineMath("a $b$ c")).toBe("a  c");
  });
  it("all 50 golden lines are right to left", () => {
    for (const l of LINES) expect({ id: l.id, dir: markdownLineDirection(l.line) }).toEqual({ id: l.id, dir: "rtl" });
  });
});

describe("rendered formulas become LTR isolates", () => {
  type N = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: N[] };
  const el = (tagName: string, className: string[] | undefined, children: N[] = []): N => ({ type: "element", tagName, properties: className ? { className } : {}, children });
  it("puts dir=ltr on KaTeX's inline, display and error elements, and nothing else", () => {
    const inline = el("span", ["katex"], [el("span", ["katex-html"])]);
    const display = el("span", ["katex-display"], [el("span", ["katex"])]);
    const error = el("span", ["katex-error"]);
    const plain = el("span", ["note"]);
    const tree: N = { type: "root", children: [el("p", undefined, [{ type: "text" }, inline, plain]), display, error] };
    rehypeMathIsolate()(tree);
    expect(inline.properties!.dir).toBe("ltr");
    expect(display.properties!.dir).toBe("ltr");
    expect(error.properties!.dir).toBe("ltr");
    expect(plain.properties!.dir).toBeUndefined();
    expect(display.children![0].properties!.dir).toBeUndefined(); // the outer one isolates it
  });
});

describe("Word export: formulas as math zones", () => {
  async function documentXml(md: string): Promise<string> {
    const files = await unzip((await markdownToDocxBytes(md)).buffer);
    return new TextDecoder().decode(files.get("word/document.xml"));
  }

  it("each of the 50 golden lines: a right-to-left paragraph, its formulas as OMML zones between their Hebrew neighbours", async () => {
    let right = 0;
    for (const l of LINES) {
      const xml = await documentXml(l.line);
      const para = /<w:p>(?:(?!<w:p>).)*?<m:oMath>.*?<\/w:p>/s.exec(xml)?.[0] ?? "";
      const zones = [...para.matchAll(/<m:oMath><m:r><m:t xml:space="preserve">(.*?)<\/m:t>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'));
      const text = para.replace(/<m:oMath>.*?<\/m:oMath>/g, "\u0000").replace(/<[^>]+>/g, "");
      const at = text.indexOf("\u0000");
      const ok =
        para.includes("<w:bidi/>") &&
        zones[0] === l.formula &&
        zones.length === (l.line.match(/\$/g) ?? []).length / 2 &&
        !text.includes("$") &&
        text.lastIndexOf(l.before, at) >= 0 &&
        text.indexOf(l.after, at) > at;
      if (ok) right++;
      else console.log("docx", l.id, JSON.stringify(text), zones);
    }
    expect(right).toBe(50);
  });

  it("declares the math namespace and writes display blocks as math paragraphs", async () => {
    const xml = await documentXml("לפני\n\n$$\n\\frac{a}{b}\n$$\n\nאחרי");
    expect(xml).toContain('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"');
    expect(xml).toContain("<m:oMathPara><m:oMath><m:r><m:t xml:space=\"preserve\">\\frac{a}{b}</m:t>");
  });
});

describe("typing a formula with the Hebrew layout", () => {
  it("gives the Latin character of the physical key", () => {
    expect(latinForHebrewKey({ code: "KeyX", key: "ס" })).toBe("x");
    expect(latinForHebrewKey({ code: "KeyA", key: "ש" })).toBe("a");
    expect(latinForHebrewKey({ code: "KeyQ", key: "/" })).toBe("q");
    expect(latinForHebrewKey({ code: "Slash", key: "." })).toBe("/");
    expect(latinForHebrewKey({ code: "Comma", key: "ת" })).toBe(",");
  });
  it("leaves the English layout, other layouts and shortcuts alone", () => {
    expect(latinForHebrewKey({ code: "KeyX", key: "x" })).toBe(null);
    expect(latinForHebrewKey({ code: "KeyQ", key: "a" })).toBe(null); // AZERTY
    expect(latinForHebrewKey({ code: "KeyX", key: "ч" })).toBe(null); // Russian
    expect(latinForHebrewKey({ code: "KeyX", key: "ס", ctrlKey: true })).toBe(null);
    expect(latinForHebrewKey({ code: "Digit2", key: "2" })).toBe(null);
  });
});
