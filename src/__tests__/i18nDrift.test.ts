import { describe, it, expect } from "vitest";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";
import { lazyEnglish } from "./helpers/i18nLazy";

/**
 * Ensures every lazy-loaded locale JSON has the same keys as the EN
 * bundle. Catches drift when a developer adds an EN key but forgets
 * to run the translation generator.
 */
describe("i18n locale drift", () => {
  // Every language is src/i18n/locales/<lang>/<domain>.json (plan 0.3).
  // English of lazily loaded domains lives next to its chunk.
  const enKeys = new Set([...Object.keys(readLocale("en")), ...Object.keys(lazyEnglish())]);

  const locales = ["he", "ar", "de", "fr", "ja", "ru", "zh-CN"];

  for (const locale of locales) {
    it(`${locale}/*.json has no missing EN keys`, () => {
      const localeData = readLocale(locale);
      const localeKeys = new Set(
        Object.keys(localeData).filter((k) => !k.startsWith("_")),
      );
      const missing = [...enKeys].filter((k) => !localeKeys.has(k));
      expect(missing, `Missing keys in ${locale}`).toEqual([]);
    });

    it(`${locale}/*.json has no extra keys not in EN`, () => {
      const localeData = readLocale(locale);
      const localeKeys = Object.keys(localeData).filter(
        (k) => !k.startsWith("_"),
      );
      const extra = localeKeys.filter((k) => !enKeys.has(k));
      // Strictly zero extras — orphan translations bloat the bundle
      // and confuse readers about which keys are still in production.
      // The previous "allow up to 10" was a soft pass that let four
      // dead keys (findReplace.find, findReplace.matchCase,
      // mdTable.cancel, writingGoal.label) sit untouched. If a sub-
      // dialect needs an override, add the key to the EN source first.
      expect(extra, `Extra keys in ${locale}`).toEqual([]);
    });
  }
});
