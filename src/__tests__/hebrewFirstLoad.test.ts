/**
 * W4.10 — Hebrew first: the page is written lang="he" dir="rtl"; before the
 * first paint public/locale-boot.js sets the saved or the system language
 * (so a Hebrew system paints right to left, with no flip), and initLocale()
 * agrees with it; og:locale is he_IL; the READMEs open in Hebrew and name no
 * cloud provider as a default.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { detectLocale } from "../i18n/detect";
// @ts-expect-error — plain .mjs helpers without types
import { readmeProblems } from "../../scripts/docs-sync.mjs";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Run public/locale-boot.js as the browser would, and return what it set. */
function boot(opts: { saved?: unknown; languages?: string[]; language?: string; storageThrows?: boolean }) {
  const el = { lang: "he", dir: "rtl" };
  const win: Record<string, unknown> = {};
  const ctx = {
    window: win,
    document: { documentElement: el },
    navigator: { languages: opts.languages ?? [], language: opts.language ?? "" },
    localStorage: {
      getItem: () => {
        if (opts.storageThrows) throw new Error("blocked");
        return opts.saved === undefined ? null : JSON.stringify({ state: { locale: opts.saved } });
      },
    },
  };
  vm.runInNewContext(read("public/locale-boot.js"), ctx);
  return { lang: el.lang, dir: el.dir, pick: win.__lumenPickLocale as (s: unknown, l: string[]) => string, boot: win.__lumenBootLocale };
}

const CASES: Array<[unknown, string[], string]> = [
  [null, ["he-IL", "en-US"], "he"],
  [null, ["iw"], "he"],
  [null, ["en-US", "he-IL"], "he"], // W4.35: Hebrew anywhere in the list
  [null, ["en-US", "iw"], "he"],
  [null, ["ar-EG"], "ar"],
  [null, ["zh-TW", "zh-CN"], "zh-CN"],
  [null, ["zh-Hant-HK"], "en"],
  [null, ["zh"], "zh-CN"],
  [null, ["pt-BR", "fr-CA"], "fr"],
  [null, ["xx"], "en"],
  [null, [], "en"],
  ["he", ["en-US"], "he"],
  ["en", ["he-IL"], "en"], // a saved choice always wins
  ["klingon", ["he-IL"], "he"],
];

describe("the language at load", () => {
  it("detectLocale: the saved choice, else Hebrew if listed, else the first supported system language, else English", () => {
    for (const [saved, langs, want] of CASES) expect(detectLocale(saved, langs), `${saved} ${langs}`).toBe(want);
  });

  it("the boot script picks exactly what the app picks (no flip on start)", () => {
    const { pick } = boot({ languages: ["en"] });
    for (const [saved, langs, want] of CASES) expect(pick(saved, langs), `${saved} ${langs}`).toBe(want);
  });

  it("sets lang and dir before the first paint: Hebrew system → rtl; English → ltr; saved choice wins", () => {
    expect(boot({ languages: ["he-IL", "en"] })).toMatchObject({ lang: "he", dir: "rtl", boot: "he" });
    expect(boot({ languages: ["en-GB"] })).toMatchObject({ lang: "en", dir: "ltr" });
    expect(boot({ saved: "ar", languages: ["en"] })).toMatchObject({ lang: "ar", dir: "rtl" });
    expect(boot({ saved: "en", languages: ["he-IL"] })).toMatchObject({ lang: "en", dir: "ltr" });
    // No languages list (older browsers): navigator.language.
    expect(boot({ language: "he" })).toMatchObject({ lang: "he", dir: "rtl" });
    // Blocked storage: the system language still applies.
    expect(boot({ storageThrows: true, languages: ["he"] })).toMatchObject({ lang: "he", dir: "rtl" });
  });
});

describe("index.html", () => {
  const html = read("index.html");

  it("is written Hebrew first, with the boot scripts before the app and no inline script", () => {
    expect(html).toMatch(/<html lang="he" dir="rtl"/);
    const localeAt = html.indexOf('<script src="/locale-boot.js"></script>');
    const themeAt = html.indexOf('<script src="/theme-boot.js"></script>');
    const appAt = html.indexOf('<script type="module" src="/src/main.tsx">');
    expect(localeAt).toBeGreaterThan(0);
    expect(localeAt < themeAt && themeAt < appAt).toBe(true);
    // Every <script> is external or JSON-LD data (the CSP allows no inline script).
    for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type="application\/ld\+json"/.test(m[1])) continue;
      expect(m[1], m[0].slice(0, 60)).toMatch(/src="/);
      expect(m[2].trim()).toBe("");
    }
  });

  it("og:locale he_IL with en_US as the alternate; Hebrew title and description", () => {
    expect(html).toContain('<meta property="og:locale" content="he_IL" />');
    expect(html).toContain('<meta property="og:locale:alternate" content="en_US" />');
    expect(/<meta property="og:title" content="([^"]+)"/.exec(html)![1]).toMatch(/[֐-׿]/);
    expect(/<title>([^<]+)<\/title>/.exec(html)![1]).toMatch(/[֐-׿]/);
  });
});

describe("the READMEs", () => {
  it("README.md opens in Hebrew and links the English one; README.en.md links back; no cloud provider up top, no CI badge", () => {
    expect(readmeProblems(read("README.md"), "README.md")).toEqual([]);
    expect(readmeProblems(read("README.en.md"), "README.en.md")).toEqual([]);
    const first = read("README.md").split("\n").slice(0, 20).join("\n");
    expect(first).not.toMatch(/OpenAI|GPT|Anthropic|Gemini|Mistral/);
  });

  it("catches the old opening", () => {
    const old = "# Lumen\n\n[![CI](https://github.com/x/y/actions/workflows/ci.yml/badge.svg)](x)\n| **AI Copilot** | OpenAI GPT-4o streaming |\n";
    const p = readmeProblems(old, "README.md").join("\n");
    expect(p).toMatch(/cloud provider \(“OpenAI”\)/);
    expect(p).toMatch(/Actions badge/);
    expect(p).toMatch(/must open in Hebrew/);
    expect(p).toMatch(/no link to README\.en\.md/);
    expect(readmeProblems("Uses OpenAI by default.", "README.en.md").join()).toMatch(/default/);
    // A cloud provider further down, as an option, is fine.
    const ok = `# כותרת\n\n[English](README.en.md)\n${"\n".repeat(25)}Optional: OpenAI with your own key.\n`;
    expect(readmeProblems(ok, "README.md")).toEqual([]);
  });
});
