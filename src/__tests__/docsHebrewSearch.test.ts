/**
 * Plan W1.28 — Hebrew search in the docs: prefixed and construct-state
 * words are indexed with their bare forms, and 20 golden Hebrew queries
 * find their page.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs modules without types
import { absoluteForm, bareForms, hebrewBaseForms, hebrewWords } from "../../docs/src/plugins/hebrew-forms.mjs";
// @ts-expect-error — plain .mjs modules without types
import rehypeHebrewSearch, { isHebrewPage } from "../../docs/src/plugins/rehype-hebrew-search.mjs";
// @ts-expect-error — plain .mjs modules without types
import { queryWords } from "../../scripts/docs-search.mjs";

type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };

describe("Hebrew word forms", () => {
  it("strips one or two prefix letters, keeping at least three letters", () => {
    expect(bareForms("והפתקים")).toEqual(["הפתקים", "פתקים"]);
    expect(bareForms("בכספת")).toEqual(["כספת", "ספת"]);
    expect(bareForms("שלום")).toEqual(["לום"]);
    expect(bareForms("של")).toEqual([]);
    expect(bareForms("גיבוי")).toEqual([]);
  });

  it("construct state → absolute form", () => {
    expect(absoluteForm("התקנת")).toBe("התקנה");
    expect(absoluteForm("את")).toBeNull();
  });

  it("words without nikud or cantillation; forms only when new", () => {
    expect(hebrewWords("בְּרֵאשִׁ֖ית בָּרָ֣א")).toEqual(["בראשית", "ברא"]);
    expect(hebrewBaseForms("הכספת והכספת כספת")).toEqual(["הכספה", "כספה", "ספת", "והכספה"]);
    expect(hebrewBaseForms("והפתקים")).toEqual(["הפתקים", "פתקים"]);
    expect(hebrewBaseForms("פתקים והפתקים")).toEqual(["הפתקים"]);
  });

  it("a query keeps its words, a hyphen splits \"מ-Notion\"", () => {
    expect(queryWords("מעבר מ-Notion")).toEqual(["מעבר", "notion"]);
  });
});

describe("rehype plugin", () => {
  const run = (path: string, text: string, title = "") => {
    const tree: Node = { type: "root", children: [{ type: "element", tagName: "p", children: [{ type: "text", value: text }] }, { type: "element", tagName: "pre", children: [{ type: "text", value: "והקוד" }] }] };
    (rehypeHebrewSearch() as (t: Node, f: unknown) => void)(tree, { path, data: { astro: { frontmatter: { title } } } });
    return tree.children!.slice(2);
  };

  it("Hebrew pages get hidden, low-weight blocks of forms (title forms weigh more); code is not read", () => {
    const added = run("/x/src/content/docs/he/a.md", "והפתקים שלכם", "התקנת Lumen");
    expect(added.map((n) => n.properties?.dataPagefindWeight)).toEqual(["5", "0.5"]);
    expect(added[0].children![0].value).toBe("התקנה תקנת תקנה");
    expect(added[1].children![0].value).toBe("הפתקים פתקים לכם");
    expect(added.every((n) => n.properties?.ariaHidden === "true" && (n.properties?.className as string[]).includes("sr-only"))).toBe(true);
  });

  it("English pages are left alone", () => {
    expect(isHebrewPage("/x/src/content/docs/workspace/a.md")).toBe(false);
    expect(run("/x/src/content/docs/editor/hebrew.md", "והפתקים")).toEqual([]);
  });
});

describe("golden queries", () => {
  it("20/20 Hebrew queries bring their page into the top 3 (index model)", () => {
    const r = spawnSync(process.execPath, ["scripts/docs-search.mjs"], { cwd: resolve(__dirname, "..", ".."), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("20/20");
  });
});
