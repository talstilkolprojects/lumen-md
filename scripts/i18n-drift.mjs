#!/usr/bin/env node
/**
 * `npm run i18n:drift`: ci.yml's i18n drift gate, counting the lazy English too
 * (scripts/lib/i18n-drift.mjs says why). Exit 1 when a locale drifts more than 10 keys
 * from English, or has a key with no English string.
 */
import { listLocales, readLocale } from "./lib/i18n-files.mjs";
import { lazyEnglishEntries } from "./lib/i18n-lazy.mjs";
import { LIMIT, drift } from "./lib/i18n-drift.mjs";

const eager = Object.keys(readLocale("en"));
const lazy = lazyEnglishEntries().map(([k]) => k);
const en = new Set([...eager, ...lazy]);
const locales = Object.fromEntries(listLocales().map((l) => [l, Object.keys(readLocale(l))]));
const r = drift({ en, locales });
console.log(`i18n keys — en: ${en.size} (${eager.length} at startup + ${lazy.length} lazy)`);
for (const row of r.rows) {
  console.log(`${row.ok ? "✓" : "✗"} ${row.locale}: ${row.keys}, diff ${row.diff}${row.noEnglish.length ? `, ${row.noEnglish.length} key(s) with no English: ${row.noEnglish.slice(0, 10).join(", ")}` : ""}`);
}
if (!r.ok) {
  console.error(`::error::i18n drift: a locale is more than ${LIMIT} keys from English, or has keys with no English string; run \`node scripts/print-missing-i18n-keys.mjs\` and fix.`);
  process.exit(1);
}
