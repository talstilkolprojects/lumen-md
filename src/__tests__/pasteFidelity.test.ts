/**
 * Faithful paste (W1.4): 30 clipboard HTML samples, shaped like what Word,
 * Google Docs, Wikipedia, a Hebrew news site and Gmail put on the
 * clipboard, in Hebrew, English and mixed (fixtures/paste/*.html), each with
 * the Markdown it must become (*.md, the snapshot).
 *
 * Gates:
 * - every sample converts to its snapshot;
 * - structure (headings, list items with their depth, table cells, links,
 *   emphasis) matches on at least 95% across the samples (it is 100% while
 *   every snapshot matches; the score shows how far a change drifts);
 * - no inline style or styling tag in any output;
 * - no direction control in any output beyond those the snapshot needs.
 */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { cleanBidiControls, cleanPastedHtml, countBidiControls, pastedHtmlToMarkdown, shouldConvertPaste } from "../paste/htmlPaste";

const html = import.meta.glob<string>("./fixtures/paste/*.html", { query: "?raw", import: "default", eager: true });
const md = import.meta.glob<string>("./fixtures/paste/*.md", { query: "?raw", import: "default", eager: true });

const samples = Object.keys(html)
  .sort()
  .map((p) => ({ name: p.split("/").pop()!.replace(/\.html$/, ""), html: html[p], expected: md[p.replace(/\.html$/, ".md")] }));

/* eslint-disable @typescript-eslint/no-explicit-any -- walking mdast */
/** Structural features of a Markdown document, as strings. */
function structure(text: string): string[] {
  const tree: any = unified().use(remarkParse).parse(text);
  const out: string[] = [];
  const plain = (n: any): string => (typeof n.value === "string" ? n.value : (n.children ?? []).map(plain).join(""));
  const walk = (n: any, depth: number) => {
    if (n.type === "heading") out.push(`h${n.depth}:${plain(n)}`);
    if (n.type === "listItem") out.push(`li${depth}:${plain(n.children?.[0] ?? {})}`);
    if (n.type === "link") out.push(`a:${plain(n)}->${n.url}`);
    if (n.type === "strong" || n.type === "emphasis" || n.type === "delete" || n.type === "inlineCode") out.push(`${n.type}:${plain(n)}`);
    if (n.type === "blockquote") out.push("quote");
    // GFM tables parse as paragraphs without remark-gfm: count their rows' cells.
    if (n.type === "paragraph" && /^\|.*\|$/m.test(plain(n))) {
      for (const row of plain(n).split("\n")) if (!/^\|\s*-/.test(row)) for (const c of row.split(/(?<!\\)\|/).slice(1, -1)) out.push(`td:${c.trim()}`);
    }
    for (const c of n.children ?? []) walk(c, n.type === "list" ? depth + 1 : depth);
  };
  walk(tree, 0);
  return out;
}

function matchScore(expected: string[], actual: string[]): { matched: number; total: number } {
  const pool = [...actual];
  let matched = 0;
  for (const e of expected) {
    const i = pool.indexOf(e);
    if (i >= 0) {
      matched++;
      pool.splice(i, 1);
    }
  }
  return { matched, total: expected.length };
}

describe("paste fidelity", () => {
  it("has 30 samples, each with its snapshot", () => {
    expect(samples.length).toBe(30);
    expect(samples.filter((s) => !s.expected).map((s) => s.name)).toEqual([]);
  });

  it("converts every sample to its snapshot, with no style and no needless direction marks", () => {
    let matched = 0;
    let total = 0;
    const wrong: string[] = [];
    for (const s of samples) {
      const got = pastedHtmlToMarkdown(s.html);
      const want = s.expected.trim();
      const sc = matchScore(structure(want), structure(got));
      matched += sc.matched;
      total += sc.total;
      if (got !== want) wrong.push(`${s.name}:\n--- want\n${want}\n--- got\n${got}`);
      if (/style\s*=|<span|<font|<o:p|mso-/i.test(got)) wrong.push(`${s.name}: styling left in the output`);
      if (countBidiControls(got) !== countBidiControls(want)) wrong.push(`${s.name}: ${countBidiControls(got)} direction controls, want ${countBidiControls(want)}`);
    }
    console.log(`paste structure match: ${matched}/${total} (${((matched / total) * 100).toFixed(1)}%)`);
    expect(matched / total).toBeGreaterThanOrEqual(0.95);
    expect(wrong).toEqual([]);
  });
});

describe("shouldConvertPaste", () => {
  it("leaves code editors' styled spans and lone <pre> as plain text", () => {
    expect(shouldConvertPaste('<meta charset="utf-8"><div style="color:#d4d4d4;font-family:Consolas"><span>const x = 1;</span></div>', "const x = 1;")).toBe(false);
    expect(shouldConvertPaste("<pre>a\n b</pre>", "a\n b")).toBe(false);
    expect(shouldConvertPaste(undefined, "x")).toBe(false);
    expect(shouldConvertPaste("<p>plain words</p>", "plain words")).toBe(false);
    expect(shouldConvertPaste("<p>a <b>bold</b> word</p>", "a bold word")).toBe(true);
  });
});

describe("cleanBidiControls", () => {
  it("removes embeddings, overrides and isolates always", () => {
    expect(cleanBidiControls("\u202Bשלום\u202C \u2067abc\u2069 \u202Ex\u202C")).toBe("שלום abc x");
  });

  it("keeps an LRM/RLM only between a letter of the other direction and a neutral or digit", () => {
    expect(cleanBidiControls("שלום\u200E (2)")).toBe("שלום\u200E (2)");
    expect(cleanBidiControls("abc\u200F!")).toBe("abc\u200F!");
    // Same direction as the letter before it, before a letter, or doubled: not needed.
    expect(cleanBidiControls("שלום\u200F (2)")).toBe("שלום (2)");
    expect(cleanBidiControls("abc\u200Edef")).toBe("abcdef");
    expect(cleanBidiControls("שלום\u200E\u200E (2)")).toBe("שלום\u200E (2)");
    expect(cleanBidiControls(": \u200E100")).toBe(": 100");
  });
});

describe("cleanPastedHtml (WYSIWYG paste)", () => {
  it("rebuilds Word lists and drops styles and direction attributes", () => {
    const html = cleanPastedHtml(
      "<p class=MsoListParagraph dir=RTL style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·</span><span style='color:red'>א</span></p>" +
        "<p class=MsoListParagraph style='mso-list:l0 level2 lfo1'><span style='mso-list:Ignore'>o</span>ב</p>",
    );
    expect(html).toBe("<ul><li>א<ul><li>ב</li></ul></li></ul>");
  });
});
