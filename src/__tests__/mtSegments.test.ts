/**
 * Local translation, the document side (plan 6.4): code, inline code,
 * links / URLs, frontmatter, wiki links, math and HTML survive a
 * translation exactly, whatever the translator does to the words.
 */
import { describe, it, expect } from "vitest";
import { keptSpans, parseMarkdown, renderLine, runsOf, sentencesOf, translateMarkdown } from "../ai/mt/segments";
import { fencedBlocks, urlsOf } from "../agents/defs/translator";

const FIXTURES: Record<string, string> = {
  frontmatter: `---
title: Hello world
tags: [a, b]
date: 2026-10-24
---

# A heading

Plain paragraph here.`,
  code: `Intro line with \`inline()\` and \`\`double \` tick\`\` code.

\`\`\`ts
const x = "translate me not";
// a comment that must stay
\`\`\`

~~~
tilde fence
~~~

    indented code line
    second one

Trailing text.`,
  links: `See [the docs](https://example.com/docs?q=1&x=2 "Docs") and [ref link][ref] and <https://auto.link/x>.
Bare https://bare.example/path?x=1, mail someone@example.org and image ![alt words](img/a.png).
Wiki [[Some Note]] and [[Other|alias]] and footnote[^n1].

[ref]: https://ref.example/target
[^n1]: The footnote text.`,
  structure: `# Title  ##
## Second *level*

- item one
- item two with \`code\`
  - nested item
1. first
2. [x] done task
> a quote with [link](http://q.example)
> > nested quote

| Col A | Col B |
|:--|--:|
| cell \`c\` | cell with [l](https://t.example) |

Term $x^2 + y$ and display $$\\sum_i a_i$$ here. <b>bold tag</b> and <br/>.

---

<div class="x">
raw html block
</div>`,
  hebrew: `# כותרת

שורה בעברית עם \`קוד\` וקישור [תיעוד](https://he.example/דף) ותמונה ![תיאור](x.png).

- פריט ראשון
- פריט שני`,
};

/** A translator that keeps placeholders and changes the words. */
const upper = async (texts: string[]) => texts.map((s) => s.toUpperCase());
/** A translator that reorders words and keeps placeholders (as MT does). */
const reverse = async (texts: string[]) => texts.map((s) => s.split(/(\{\{\d+\}\})/).map((p) => (/^\{\{\d+\}\}$/.test(p) ? p : p.split(" ").reverse().join(" "))).join(""));
/** A translator that drops every placeholder (the failure the second pass exists for). */
const dropper = async (texts: string[]) => texts.map((s) => s.replace(/\{\{\d+\}\}/g, "").toUpperCase());
/** A translator that doubles every placeholder. */
const doubler = async (texts: string[]) => texts.map((s) => s.replace(/(\{\{\d+\}\})/g, "$1 $1").toUpperCase());

describe("markdown segments", () => {
  it("renders back to the input unchanged", () => {
    for (const [name, doc] of Object.entries(FIXTURES)) {
      expect(parseMarkdown(doc).map(renderLine).join("\n"), name).toBe(doc);
    }
  });

  it("an identity translator returns the document byte for byte", async () => {
    for (const [name, doc] of Object.entries(FIXTURES)) expect(await translateMarkdown(doc, async (t) => t), name).toBe(doc);
  });

  it.each(Object.entries(FIXTURES))("%s: every kept span survives any translator (100%% preservation)", async (_name, doc) => {
    for (const translate of [upper, reverse, dropper, doubler]) {
      const out = await translateMarkdown(doc, translate);
      for (const span of keptSpans(doc)) expect(out, span).toContain(span);
      // The agent's own checks agree: same fenced code, same URLs in every link form.
      expect(fencedBlocks(out)).toEqual(fencedBlocks(doc));
      expect(urlsOf(out)).toEqual(urlsOf(doc));
      // Frontmatter is untouched.
      const fm = /^---\n[\s\S]*?\n---\n/.exec(doc)?.[0];
      if (fm) expect(out.startsWith(fm)).toBe(true);
      // Structure markers stay where they were.
      expect(out.split("\n").length).toBe(doc.split("\n").length);
    }
  });

  it("translates the words and only the words", async () => {
    const out = await translateMarkdown(FIXTURES.links, upper);
    expect(out).toContain("SEE [THE DOCS](https://example.com/docs?q=1&x=2 \"Docs\")");
    expect(out).toContain("[REF LINK][ref]");
    expect(out).toContain("![ALT WORDS](img/a.png)");
    expect(out).toContain("[[Some Note]]");
    expect(out).toContain("[^n1]: THE FOOTNOTE TEXT.");
    expect(out).toContain("someone@example.org");
    const s = await translateMarkdown(FIXTURES.structure, upper);
    expect(s).toContain("# TITLE  ##");
    expect(s).toContain("2. [x] DONE TASK");
    expect(s).toContain("| CELL `c` | CELL WITH [L](https://t.example) |");
    expect(s).toContain("|:--|--:|");
    expect(s).toContain("$$\\sum_i a_i$$");
    expect(s).toContain("<b>BOLD TAG</b>");
  });

  it("falls back to run-by-run translation when a translator breaks the placeholders", async () => {
    const calls: string[][] = [];
    const spy = async (texts: string[]) => {
      calls.push(texts);
      return dropper(texts);
    };
    const out = await translateMarkdown("Read `a` then [b](https://b.example) now.", spy);
    expect(out).toBe("READ `a` THEN [B](https://b.example) NOW.");
    // Pass 1 sent the placeholder sentence; pass 2 sent the text runs alone.
    expect(calls[0]).toEqual(["Read {{0}} then [b{{1}} now."]);
    expect(calls[1]).toEqual(["Read ", " then [b", " now."]);
  });

  it("skips paragraphs the router says are already in the target language (plan 6.5)", async () => {
    const doc = "First paragraph in English.\n\nפסקה שנייה בעברית.\n\nThird in English.";
    const out = await translateMarkdown(doc, upper, { shouldTranslate: (p) => !/[֐-׿]/.test(p) });
    expect(out).toBe("FIRST PARAGRAPH IN ENGLISH.\n\nפסקה שנייה בעברית.\n\nTHIRD IN ENGLISH.");
  });

  it("cuts long segments at sentence ends and keeps the surrounding whitespace", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`).join(" ");
    expect(sentencesOf(long, 100).every((s) => s.length <= 100)).toBe(true);
    expect(sentencesOf(long, 100).join(" ")).toBe(long);
    const sent: string[][] = [];
    const out = await translateMarkdown(`- ${long}  `, async (t) => (sent.push(t), t.map((s) => s.toUpperCase())), { maxChars: 100 });
    expect(sent[0].length).toBeGreaterThan(1);
    expect(out).toBe(`- ${long.toUpperCase()}  `);
  });

  it("the agent's URL check no longer reads a footnote definition as a link target", () => {
    expect(urlsOf("[^1]: The note\n[ref]: https://r.example\n")).toEqual(["https://r.example"]);
  });

  it("rejects a translator that returns the wrong number of segments", async () => {
    await expect(translateMarkdown("One.\n\nTwo.", async () => ["only one"])).rejects.toThrow(/returned 1 segments for 2/);
  });

  it("inline runs: code, math, links, wiki links, autolinks, mail and tags are kept", () => {
    const runs = runsOf("a `c` b $m$ c [t](u) d [[w]] e <https://x> f m@x.io g <i>h</i>");
    expect(runs.filter((r) => r.kind === "keep").map((r) => r.text)).toEqual(["`c`", "$m$", "](u)", "[[w]]", "<https://x>", "m@x.io", "<i>", "</i>"]);
  });
});
