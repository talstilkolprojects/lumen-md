import { describe, it, expect } from "vitest";
import { lazyEnglish } from "./helpers/i18nLazy";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * T45 — the i18n gate checks values, not only keys: a locale that copies
 * the English string is untranslated. Hebrew: zero, apart from the terms
 * that are the same in every language (product and format names, symbols).
 * The other locales: at most 5 %.
 */
const indexPath = join(__dirname, "..", "i18n", "index.ts");
const content = readFileSync(indexPath, "utf8");
const enBlock = content.slice(content.indexOf("const en: Strings = {"), content.indexOf("\n};\n", content.indexOf("const en: Strings = {")));
const en: Record<string, string> = {};
for (const m of enBlock.matchAll(/^\s+"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) en[m[1]] = JSON.parse(`"${m[2]}"`);
Object.assign(en, lazyEnglish());

/** Strings that are rightly identical in Hebrew. */
const SAME_IN_HEBREW = new Set([
  "toolbar.ltr", "toolbar.rtl", "mode.wysiwyg", "group.git", "cmd.view.wysiwyg",
  "insertText.kind.markdown", "insertText.kind.html", "block.playground.title",
  "cmd.insert.callout.hint", "cmd.insert.model.hint", "cmd.insert.embed.hint",
  "templates.contributeLink", "ai.toast.localLoading.body", "cmd.security.encrypt.hint",
]);

const words = (s: string) => /[A-Za-z]{3}/.test(s);

function untranslated(locale: string): string[] {
  const data = JSON.parse(readFileSync(join(__dirname, "..", "i18n", "locales", `${locale}.json`), "utf8")) as Record<string, string>;
  return Object.keys(en).filter((k) => data[k] === en[k] && words(en[k]));
}

describe("i18n values are translated", () => {
  it("parses the English bundle", () => {
    expect(Object.keys(en).length).toBeGreaterThan(1000);
  });

  it("Hebrew: no English copies beyond the shared terms", () => {
    const left = untranslated("he").filter((k) => !SAME_IN_HEBREW.has(k));
    expect(left).toEqual([]);
  });

  for (const locale of ["ar", "de", "fr", "ja", "ru", "zh-CN"]) {
    it(`${locale}: at most 5% of the values are English copies`, () => {
      const left = untranslated(locale);
      expect(left.length / Object.keys(en).length, left.slice(0, 20).join(", ")).toBeLessThanOrEqual(0.05);
    });
  }
});
