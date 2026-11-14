/**
 * The i18n drift gate, counting the English the app really ships (plan 0.3 + the lazy domains).
 *
 * ci.yml's "i18n drift gate" counts English from src/i18n/locales/en/ only, but English of
 * lazily loaded domains lives in src/i18n/lazy/*.json (kept out of the startup bundle). On
 * chore/verify-factory that made en 2270 vs he 2493 although no string is missing.
 * Here English = locales/en ∪ the lazy files, and for every other locale:
 *   - the key counts stay within LIMIT of each other (ci.yml's rule, applied to every locale, not only he)
 *   - every key has an English string (no limit: a Hebrew key without English always fails)
 * Equal to ci.yml's check or stricter, never looser.
 */

/** ci.yml: "en + he stay within 10 keys of each other". */
export const LIMIT = 10;

/**
 * @param {{ en: Set<string> | string[], locales: Record<string, string[]> }} input
 * @returns {{ ok: boolean, rows: { locale: string, keys: number, diff: number, noEnglish: string[], ok: boolean }[] }}
 */
export function drift({ en, locales }, limit = LIMIT) {
  const english = en instanceof Set ? en : new Set(en);
  const rows = Object.entries(locales)
    .filter(([l]) => l !== "en")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([locale, keys]) => {
      const diff = Math.abs(english.size - keys.length);
      const noEnglish = keys.filter((k) => !english.has(k)).sort();
      return { locale, keys: keys.length, diff, noEnglish, ok: diff <= limit && noEnglish.length === 0 };
    });
  return { ok: rows.length > 0 && rows.every((r) => r.ok), rows };
}
