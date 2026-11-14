import { describe, it, expect } from "vitest";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";
import { lazyEnglish } from "./helpers/i18nLazy";
import { readNeedsReview, unreviewed } from "../../scripts/lib/i18n-draft.mjs";

/**
 * T45 — the i18n gate checks values, not only keys: a locale that copies
 * the English string is untranslated. Hebrew: zero, apart from the terms
 * that are the same in every language (product and format names, symbols).
 * The other locales: at most 5 %. A machine draft (`npm run i18n:draft`,
 * plan 9.6) counts as untranslated until it is approved.
 */
// src/i18n/locales/<lang>/<domain>.json (plan 0.3).
const en: Record<string, string> = { ...readLocale("en"), ...lazyEnglish() };

/** Strings that are rightly identical in Hebrew. */
const SAME_IN_HEBREW = new Set([
  "toolbar.ltr", "toolbar.rtl", "mode.wysiwyg", "group.git", "cmd.view.wysiwyg",
  "insertText.kind.markdown", "insertText.kind.html", "block.playground.title",
  "cmd.insert.callout.hint", "cmd.insert.model.hint", "cmd.insert.embed.hint",
  "templates.contributeLink", "ai.toast.localLoading.body", "cmd.security.encrypt.hint",
  "publish.target.github", // a product name (plan 4.18)
  "pii.type.IBAN", // the international standard's own abbreviation, written so in Hebrew too
]);

const words = (s: string) => /[A-Za-z]{3}/.test(s);

const review = readNeedsReview();

function untranslated(locale: string): string[] {
  const data = readLocale(locale);
  const drafts = new Set(unreviewed(locale, en, review));
  return Object.keys(en).filter((k) => drafts.has(k) || (data[k] === en[k] && words(en[k])));
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
