# Lumen i18n locales

This directory holds lazy-loaded locale bundles. Each file is a flat
`{ "key": "translated value" }` JSON map mirroring the keys in the
parent `index.ts` `en` bundle.

## Add a locale

1. Run `node scripts/extract-i18n-keys.mjs` from the repo root —
   produces `i18n/keys.json` with every English source string and the
   `{var}` placeholders each one carries.

2. Translate the values. The recommended pipeline:

   ```
   node scripts/translate-locale.mjs --locale=ar --in=i18n/keys.json --out=src/i18n/locales/ar.json
   ```

   The script POSTs each batch to OpenAI / Anthropic with a system
   prompt that locks `{var}` placeholders, keyboard shortcuts (⌘K, Esc),
   and inline markdown.

3. Native-speaker review — usually 4 hours per locale. The reviewer
   only needs to read the JSON, not re-author it.

4. Drop the resulting `<code>.json` next to this README. The locale
   becomes selectable on the next page load.

## Why JSON, not TS

JSON files are static assets — Vite splits them into their own chunks
so `en` stays the only synchronous load (Hebrew moved here too — A7
lever 4; `initLocale()` in main.tsx preloads the persisted locale before
the first render). TS bundles would
inflate the main JS chunk by ~80 KB per locale.

## English of lazily loaded domains

A domain that only loads on demand (the encrypted sync, for one) keeps its
English in `src/i18n/lazy/<domain>.json` instead of the `en` block, so it
ships with that domain's chunk and not the startup bundle. The domain calls
`registerEnglish()` when it loads (see `src/sync/e2ee/strings.ts`). The
other locales keep these keys in their files as usual, and
`extract-i18n-keys.mjs`, the drift / values / placeholder tests and
`print-missing-i18n-keys.mjs` read the lazy files together with the `en`
block. A key lives in exactly one of the two places.
