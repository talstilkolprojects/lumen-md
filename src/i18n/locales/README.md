# Lumen i18n locales

Every language is a folder of **domain files** (plan 0.3):

```
src/i18n/locales/<lang>/<domain>.json    flat { "key": "value" }, keys sorted
i18n/keys/<domain>.json                  the extracted English source strings
```

A key's domain is its first segment: `cmd.*`, `group.*`, `palette.*` and
`desc.*` live in `cmd.json`, `ai.*` in `ai.json`, and so on. The map is in
[`scripts/lib/i18n-files.mjs`](../../../scripts/lib/i18n-files.mjs)
(`DOMAINS`); a first segment no domain lists goes to `common.json`.

| domain | holds (first segment) |
|---|---|
| `cmd` | cmd, group, palette, desc |
| `ai` | ai, agent, research, batch, fineTune, doctor, suggest, tts, voice, dictate, spell |
| `editor` | block, insertText, findReplace, mdTable, format, mode, editor, suggesting, chart, outline, … |
| `canvas` | canvas, graphView |
| `settings` | themeSettings, theme, privacy, trustedKeys, org, auth, billing, audit, runtimeMetrics, plugin, pluginGallery |
| `files` | tree, vault, trash, versionHistory, doc, contextMenu, search, tagsPanel, backlinks, git, collab, clip, template(s), … |
| `toast` | toast |
| `common` | everything else (toolbar, status, tour, dialog, …) |

**Why:** with one file per language, every branch that added a string
edited the same lines of `index.ts`, `he.json` and `i18n/keys.json`, and
`keys.json` carried a timestamp that changed on every run. Now two branches
that add keys to different domains change different files, and keys are
sorted, so two branches adding to the same domain usually change different
lines. Neither conflicts when merged (`src/__tests__/i18nLayout.test.ts`
proves it with two real git branches).

**Loading:** English, the fallback for every key, is bundled with the app
(`index.ts` imports `locales/en/*.json` eagerly), so `t()` stays
synchronous. Every other language is lazy: each domain file is its own
chunk, and `loadLocale()` fetches all of a language's domains in parallel
the first time it is selected (`initLocale()` does it before the first
render for a returning user). A language is applied only if all its domains
loaded; otherwise the UI stays English.

## Add a string

1. Add the key to `src/i18n/locales/en/<domain>.json`, and the Hebrew to
   `src/i18n/locales/he/<domain>.json`. Order doesn't matter.
2. Run `npm run i18n:fix` (`i18n-split.mjs` sorts every file into its
   domain, and `extract-i18n-keys.mjs` refreshes `i18n/keys/`), then
   `node scripts/generate-all-locales.mjs` for the machine-filled locales.
3. `npm run i18n:check` and `npm run test` (the i18nDrift / i18nStrings /
   i18nValues gates) must pass.

## Add a locale

1. `npm run i18n:extract` writes `i18n/keys/*.json`: every English source
   string and the `{var}` placeholders each one carries.
2. `node scripts/translate-locale.mjs --locale=ar` translates the missing
   keys (placeholders, shortcuts and inline markdown locked by the prompt)
   and writes `src/i18n/locales/ar/<domain>.json`.
3. Native-speaker review. The reviewer reads the JSON; nothing is
   re-authored.

## Migrating a branch: `scripts/i18n-split.mjs`

`node scripts/i18n-split.mjs` moves the old layout to this one: the inline
`const en: Strings = { … }` block and the single-file `loadLocale()` in
`index.ts`, `locales/<lang>.json` and `i18n/keys.json`. It also normalises
this layout (each key in its domain, files sorted). It is idempotent and
never drops a string. Run on the base before this change, it produces
exactly this change. `--check` (part of `npm run i18n:check` and CI) fails
while anything is left to move or sort.

**A branch started before the split** keeps its strings with `--absorb`.
That mode applies, key by key and language by language, what the branch
added, changed or removed since its fork point, onto the domain files:

```sh
OLD=$(git rev-parse HEAD)               # your branch's tip, old layout
git rebase origin/<base>                # on every i18n conflict, take the base's side:
#   git checkout --ours src/i18n/index.ts            # in a rebase "ours" is the base
#   git rm -q src/i18n/locales/*.json i18n/keys.json # deleted by the split
#   git rebase --continue
node scripts/i18n-split.mjs --absorb "$OLD"
npm run i18n:fix && git add -A src/i18n i18n && git commit -m "i18n: re-apply this branch's strings"
```

With `git merge origin/<base>` instead of a rebase, resolve the same way,
taking the base's side (`--theirs` in a merge), then run the same
`--absorb "$OLD"`. If your `index.ts` had changes other than strings,
re-apply those by hand: `--absorb` only carries strings.

## English of lazily loaded domains

A domain that only loads on demand (the encrypted sync and local
translation, for two) keeps its English in `src/i18n/lazy/<domain>.json`
instead of `locales/en/`, so it ships with that domain's chunk and not the
startup bundle. The domain calls `registerEnglish()` when it loads (see
`src/sync/e2ee/strings.ts`, `src/ai/mt/strings.ts`;
`src/__tests__/i18nLazyEnglish.test.ts` lists each domain and who may import
it). The other locales keep these keys in their files as usual, and
`extract-i18n-keys.mjs`, `i18n-split.mjs` (for `i18n/keys/`), the drift /
values / placeholder tests and `print-missing-i18n-keys.mjs` read the lazy
files together with `locales/en/`. A key lives in exactly one of the two places.

**New keys:** `npm run i18n:draft` drafts every English key a language
lacks, in all seven languages, with a local model, and lists the drafts in
`i18n/needs-review/<domain>.json` (plan 9.6). The values gate counts a
listed draft as untranslated until `npm run i18n:draft -- --approve=<lang>`.
