/**
 * docs-parity: the rules of scripts/docs-parity.mjs on small in-memory
 * pages (the real tree is checked by `npm run docs:parity`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs script without types
import { body, helpTopics, lines, outline, parity, sectionLinks, unmatched, wordCount } from "../../scripts/docs-parity.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { GATES, PREVIEW_GATES } from "../../scripts/vercel-build.mjs";

type Heading = { level: number; heading: string; anchor: string };

function page(md: string, keys?: string[]) {
  const o: Heading[] = outline(md);
  return { outline: o, anchors: new Set(o.map((h) => h.anchor)), links: sectionLinks(md), words: wordCount(md), keys: new Set(keys ?? o.map((h) => h.anchor)) };
}

const EN = "Intro words here.\n\n## What a run does\n\nOne two three four five.\n\n### Not good\n\nSix seven eight.\n\n## Tools\n\nNine ten eleven twelve.\n";
const HE_FULL = "מבוא כאן.\n\n## מה קורה בריצה\n\nאחת שתיים שלוש ארבע.\n\n### לא טוב\n\nחמש שש שבע.\n\n## כלים\n\nשמונה תשע עשר אחת עשרה.\n";

describe("docs-parity", () => {
  it("reads the outline outside code fences, with the help bundle's anchors", () => {
    // As scripts/help-bundle.mjs reads a heading: markup characters (`*_`) dropped, then slugged.
    const md = "## Tools\n\n```md\n## not a heading\n```\n\n### `run_python`: Python, offline\n\n#### Deep **one**\n";
    expect(outline(md)).toEqual([
      { level: 2, heading: "Tools", anchor: "tools" },
      { level: 3, heading: "runpython: Python, offline", anchor: "runpython-python-offline" },
      { level: 4, heading: "Deep one", anchor: "deep-one" },
    ]);
  });

  it("counts prose words, not code, markup or front matter", () => {
    const md = body("---\ntitle: T\n---\nimport X from 'y';\n\nOne **two** [three](/x/).\n\n```js\nnot counted at all\n```\n\n| a | b |\n|---|---|\n");
    expect(wordCount(md)).toBe(5);
    expect(wordCount("שלום עולם, `code` כאן")).toBe(4);
  });

  it("a translated page with the same outline and enough words passes", () => {
    const pages = { en: new Map([["ai/x", page(EN)]]), he: new Map([["ai/x", page(HE_FULL, ["what-a-run-does", "not-good", "tools"])]]) };
    const report = parity({ pages, topics: [{ topic: "ai/x#tools", file: "src/ui/X.tsx" }] });
    expect(lines(report)).toEqual([]);
  });

  it("finds a missing page", () => {
    const report = parity({ pages: { en: new Map([["ai/x", page(EN)]]), he: new Map() } });
    expect(report.missing).toEqual([{ slug: "ai/x", words: wordCount(EN) }]);
  });

  it("finds missing sections and names the English headings the Hebrew lacks", () => {
    const he = "מבוא.\n\n## מה קורה בריצה\n\nאחת שתיים שלוש ארבע חמש שש שבע שמונה תשע עשר.\n";
    const report = parity({ pages: { en: new Map([["ai/x", page(EN)]]), he: new Map([["ai/x", page(he)]]) } });
    expect(report.sections).toEqual([{ slug: "ai/x", en: 3, he: 1, lacking: ["### Not good", "## Tools"] }]);
  });

  it("a heading at another level is a different outline", () => {
    const he = HE_FULL.replace("### לא טוב", "## לא טוב");
    const report = parity({ pages: { en: new Map([["ai/x", page(EN)]]), he: new Map([["ai/x", page(he)]]) } });
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]).toMatchObject({ en: 3, he: 3, lacking: [] });
  });

  it("lists the unmatched headings by level (longest common subsequence)", () => {
    const h = (level: number, heading: string) => ({ level, heading, anchor: heading });
    expect(unmatched([h(2, "a"), h(3, "b"), h(2, "c"), h(2, "d")], [h(2, "א"), h(2, "ב")]).map((x: Heading) => x.heading)).toEqual(["b", "d"]);
  });

  it("finds a short Hebrew page (under 60% of the English words)", () => {
    const en = `## A\n\n${"word ".repeat(99)}\n`; // 100 words with the heading
    const he = `## א\n\n${"מילה ".repeat(58)}\n`; // 59
    const report = parity({ pages: { en: new Map([["p", page(en)]]), he: new Map([["p", page(he)]]) } });
    expect(report.short).toEqual([{ slug: "p", en: 100, he: 59, ratio: 0.59 }]);
    const ok = parity({ pages: { en: new Map([["p", page(en)]]), he: new Map([["p", page(`## א\n\n${"מילה ".repeat(59)}\n`)]]) } });
    expect(ok.short).toEqual([]);
  });

  it("finds help topics in the source: HelpButton, learnHow and openHelp", () => {
    const files = [
      { rel: "src/ui/A.tsx", text: `<HelpButton topic="ai/local-agents#ai-settings" />\naction={learnHow("ai/local-agents#reviewing-proposed-changes")}` },
      { rel: "src/ui/B.tsx", text: `openHelp("workspace/search"); openHelp(topic);` },
    ];
    expect(helpTopics(files)).toEqual([
      { topic: "ai/local-agents#ai-settings", file: "src/ui/A.tsx" },
      { topic: "ai/local-agents#reviewing-proposed-changes", file: "src/ui/A.tsx" },
      { topic: "workspace/search", file: "src/ui/B.tsx" },
    ]);
  });

  it("a help topic must land on a section the Hebrew page carries (by its key)", () => {
    // The Hebrew page has one section: the bundle keys it by its own anchor, not the English one.
    const he = page("## מה קורה בריצה\n\nטקסט.\n");
    const pages = { en: new Map([["ai/x", page(EN)]]), he: new Map([["ai/x", he]]) };
    const report = parity({ pages, topics: [{ topic: "ai/x#tools", file: "src/ui/X.tsx" }, { topic: "ai/y", file: "src/ui/Y.tsx" }] });
    expect(report.anchors).toEqual([
      { topic: "ai/x#tools", file: "src/ui/X.tsx", lang: "he", problem: "no section #tools" },
      { topic: "ai/y", file: "src/ui/Y.tsx", lang: "en", problem: "no such page" },
      { topic: "ai/y", file: "src/ui/Y.tsx", lang: "he", problem: "no such page" },
    ]);
  });

  it("a link's #section must exist on its target, by anchor or by key", () => {
    expect(sectionLinks("See [t](/he/ai/x/#tools), [here](#כלים) and `[no](#code)`.")).toEqual([
      { target: "he/ai/x", anchor: "tools" },
      { target: null, anchor: "כלים" },
    ]);
    const pages = {
      en: new Map([["ai/x", page(EN)]]),
      he: new Map([
        ["ai/x", page(HE_FULL, ["what-a-run-does", "not-good", "tools"])],
        ["ai/y", page("טקסט [א](/he/ai/x/#tools) [ב](#כלים) [ג](/he/ai/x/#nope) [ד](/ai/x/#not-good).\n\n## כלים\n\nעוד.\n")],
      ]),
    };
    expect(parity({ pages }).links).toEqual([{ slug: "ai/y", lang: "he", link: "/he/ai/x/#nope" }]);
  });

  it("is a gate (W6.28): docs:complete runs it with --strict, and every preview build runs docs:complete", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["docs:complete"]).toMatch(/docs-parity\.mjs --strict/);
    expect(pkg.scripts["docs:parity"]).toMatch(/--strict/);
    expect(PREVIEW_GATES).toContain("docs:complete");
    expect(GATES["docs:complete"]).toEqual(["run", "-s", "docs:complete"]);
  });

  it("a Hebrew page that lost one section of the English page's is a problem the gate fails on", () => {
    const he = HE_FULL.replace("\n## כלים\n\nשמונה תשע עשר אחת עשרה.\n", "\n");
    const report = parity({ pages: { en: new Map([["ai/x", page(EN)]]), he: new Map([["ai/x", page(he)]]) } });
    expect(report.sections).toHaveLength(1);
    expect(lines(report)[0]).toMatch(/^sections {2}ai\/x: English 3 sections, Hebrew 2 — lacks ## Tools$/);
  });
});
