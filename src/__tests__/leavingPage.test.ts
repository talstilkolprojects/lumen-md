/**
 * Plan W11.P7 — the "Leaving Evernote or Notion?" page, in English and
 * Hebrew: every internal link reaches a docs page, every external link is
 * https on the other app's own help site, every section about another app
 * cites its source, the screenshot places for W10.M9 are there, and the
 * link into the wizard (`?import=`) is one the app reads.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { FIRST_RUN_SOURCES, importFromSearch } from "../onboarding/importEvent";

const DOCS = "docs/src/content/docs";
const PAGES = { en: `${DOCS}/getting-started/leaving.md`, he: `${DOCS}/he/getting-started/leaving.md` } as const;
/** The other apps' own help sites: the only external sources the page may cite. */
const OFFICIAL = ["help.evernote.com", "www.notion.com", "support.apple.com", "support.google.com", "support.microsoft.com"];
const APP = "lumen-md.vercel.app";
const SECTIONS = ["Evernote", "Notion", "Apple Notes", "Google Keep", "OneNote", "Obsidian"];

const links = (md: string) => [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
const docExists = (slug: string) => ["md", "mdx"].some((x) => existsSync(`${DOCS}/${slug.replace(/^\/|\/$/g, "")}.${x}`));
/** The body of each `## ` section. */
function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of md.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    out.set(part.slice(0, nl).trim(), part.slice(nl));
  }
  return out;
}

describe.each(Object.entries(PAGES) as [string, string][])("the %s page", (lang: string, path: string) => {
  const md = readFileSync(path, "utf8");

  it("has a title and a description", () => {
    expect(md).toMatch(/^---\ntitle: .+\ndescription: .+\n---\n/);
  });

  it("every internal link reaches a docs page in the same language", () => {
    const internal = links(md).filter((l) => l.startsWith("/"));
    expect(internal.length).toBeGreaterThan(0);
    for (const l of internal) {
      expect(docExists(l), l).toBe(true);
      if (lang === "he") expect(l.startsWith("/he/"), l).toBe(true);
      else expect(l.startsWith("/he/"), l).toBe(false);
    }
  });

  it("every external link is https, to the app or to the other app's own help", () => {
    for (const l of links(md).filter((x) => !x.startsWith("/"))) {
      const u = new URL(l);
      expect(u.protocol, l).toBe("https:");
      expect([APP, ...OFFICIAL], l).toContain(u.hostname);
    }
  });

  it("one section per source, and each about another app cites that app's help page (0 claims without a source)", () => {
    const s = sections(md);
    for (const name of SECTIONS) expect(s.has(name), name).toBe(true);
    for (const name of SECTIONS.filter((n) => n !== "Obsidian")) {
      const body = s.get(name)!;
      const cited = links(body).filter((l) => OFFICIAL.includes(new URL(l, "https://x.invalid").hostname));
      expect(cited.length, `${name} cites no official source`).toBeGreaterThan(0);
      expect(body).toMatch(lang === "he" ? /^מקור: \[/m : /^Source: \[/m);
    }
    // No prices, ratings or other claims about the other apps on this page.
    expect(md).not.toMatch(/\$\s?\d|₪\s?\d|\d+\s?(USD|NIS)|\b(best|fastest|cheapest|better than|worse than)\b/i);
  });

  it("has a place for each screenshot W10.M9 makes", () => {
    const shots = [...md.matchAll(/<!-- screenshot: (leaving\/[a-z-]+\.png) \(W10\.M9\) -->/g)].map((m) => m[1]);
    expect(shots).toEqual(["leaving/evernote-export.png", "leaving/notion-export.png", "leaving/apple-notes-export.png", "leaving/keep-takeout.png", "leaving/onenote-export.png"]);
  });

  it("links straight into the wizard with a source the app reads", () => {
    const into = links(md).filter((l) => l.startsWith(`https://${APP}/`));
    expect(into.length).toBeGreaterThan(0);
    for (const l of into) expect(importFromSearch(new URL(l).search), l).not.toBeNull();
  });
});

describe("the ?import= link", () => {
  it("opens the wizard only on one of the six sources", () => {
    expect(importFromSearch("?import=evernote")).toBe("evernote");
    for (const s of FIRST_RUN_SOURCES) expect(importFromSearch(`?import=${s}`)).toBe(s);
    expect(importFromSearch("?import=lumen")).toBeNull();
    expect(importFromSearch("?import=%3Cscript%3E")).toBeNull();
    expect(importFromSearch("")).toBeNull();
  });

  it("App reads it once at start and opens the wizard", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain("importFromSearch(window.location.search)");
    expect(app).toContain('url.searchParams.delete("import")');
  });

  it("is in the docs sidebar in both languages", () => {
    expect(readFileSync("docs/astro.config.mjs", "utf8")).toContain('slug: "getting-started/leaving", translations: { he: "עוזבים את Evernote או Notion?" }');
  });
});
