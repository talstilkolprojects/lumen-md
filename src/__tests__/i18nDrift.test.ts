// @vitest-environment node
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import { LIMIT, drift } from "../../scripts/lib/i18n-drift.mjs";
import { listLocales, readLocale } from "../../scripts/lib/i18n-files.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { lazyEnglishEntries } from "../../scripts/lib/i18n-lazy.mjs";

describe("i18n drift counting the lazy English (npm run i18n:drift)", () => {
  const en = ["a", "b", "c"];

  it("passes when every locale has English for each key and stays within the limit", () => {
    expect(drift({ en, locales: { en, he: ["a", "b", "c"], de: ["a", "b"] } }).ok).toBe(true);
  });

  it("fails on a Hebrew key with no English string, however small the count difference", () => {
    const r = drift({ en, locales: { en, he: ["a", "b", "c", "orphan.key"] } });
    expect(r.ok).toBe(false);
    expect(r.rows[0]).toMatchObject({ locale: "he", diff: 1, noEnglish: ["orphan.key"], ok: false });
  });

  it(`fails when a locale is more than ${LIMIT} keys from English (ci.yml's limit), in any locale`, () => {
    const many = Array.from({ length: LIMIT + 2 }, (_, i) => `k${i}`);
    expect(drift({ en: many, locales: { he: many, fr: [] } }).rows.find((r: { locale: string }) => r.locale === "fr").ok).toBe(false);
  });

  it("this repository passes: locales/en plus src/i18n/lazy against every locale", () => {
    const english = new Set([...Object.keys(readLocale("en")), ...lazyEnglishEntries().map(([k]: [string, string]) => k)]);
    const locales = Object.fromEntries(listLocales().map((l: string) => [l, Object.keys(readLocale(l))]));
    const r = drift({ en: english, locales });
    expect(r.rows.filter((x: { ok: boolean }) => !x.ok)).toEqual([]);
    expect(r.rows.map((x: { locale: string }) => x.locale)).toContain("he");
  });
});
