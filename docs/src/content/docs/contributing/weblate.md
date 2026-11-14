---
title: Translating on Weblate
description: Review and fix Lumen's six machine-translated languages on Hosted Weblate, in the browser, with every change coming back to the repository as a pull request.
---

Lumen's interface strings can be reviewed on **Hosted Weblate**, a translation platform
that hosts open-source projects for free. A native speaker reviews and fixes strings in
the browser. Weblate sends the changes back to the repository as a pull request, and
`npm run i18n:check` stays green on them as they are.

**Arabic comes first.** It is Israel's second right-to-left language, and its strings
were translated by machine. The brief for Arabic reviewers is
[`i18n/weblate/arabic-reviewer-brief.md`](https://github.com/talstilkol/lumen-md/blob/main/i18n/weblate/arabic-reviewer-brief.md).

## For translators

1. Sign in to Hosted Weblate. A GitHub account works.
2. Open the **Lumen** project and pick your language.
3. Work through the components in the order `npm run i18n:weblate -- --queue <lang>`
   prints. The startup strings come first: they are the interface before any other
   screen opens.
4. For each string, **approve** it if it reads the way a native speaker would write it,
   or fix it. Keep every `{placeholder}` exactly as it is. Weblate checks this too.

A language leaves **beta** once a native speaker has reviewed it: 100 % of the startup
strings for Arabic, and at least 50 % for each other language. Its status then changes in
`src/i18n/review.ts` (see [Languages in beta](/contributing/translations/)).

## How the sync works

| Direction | How |
|---|---|
| Repository → Weblate | Weblate reads `main` through the Hosted Weblate GitHub App. A new English string shows up after `npm run i18n:fix`, which also rewrites the English base, is merged. |
| Weblate → repository | Weblate opens a pull request with the changed `src/i18n/locales/<lang>/<domain>.json` files. A maintainer merges it once `npm run i18n:check` and `npm run i18n:weblate` pass. |

There is **one component per area** (`cmd`, `common`, `ai`, `editor`, `files`, `settings`,
`toast`, `canvas`), and each matches one locale file per language.

The setup lives in `i18n/weblate/config.json`. `npm run i18n:weblate -- --print` prints
the settings to enter in Weblate. Three choices in it matter:

- **The English base is `i18n/weblate/en/<area>.json`**, not `src/i18n/locales/en/`. The
  app ships the English strings of lazily loaded screens apart from the startup set, but
  every other language keeps both in one file. Weblate's cleanup add-on keeps only the
  keys of the base, so a base without the lazy strings would delete their translations.
  `node scripts/weblate.mjs --write` builds the base from both, and `npm run i18n:fix` runs
  it.
- **JSON as the layout writes it**: the "JSON file" format with the parameters
  `json_indent: 2`, `json_sort_keys: case_sensitive`, spaces, and no compact separators.
  Weblate writes JSON with translate-toolkit, which uses Python's `json.dumps` with
  `ensure_ascii` off and a newline at the end. With these parameters, every one of the 56
  translation files comes out byte for byte the same. All keys are ASCII, so Python's sort
  and JavaScript's agree.
- **The "Remove blank strings" add-on.** The UI shows an empty translation as empty: `""`
  does not fall back to English. `npm run i18n:weblate` refuses an empty value.

## For the maintainer: setting it up once

1. Request libre hosting on Hosted Weblate for the public `talstilkol/lumen-md`
   repository (MIT). Weblate's free hosting is for projects with a licence that OSI
   approves or the FSF recognises as libre, whose source is public.
2. Install the **Hosted Weblate GitHub App** on `talstilkol/lumen-md` only.
3. Create the project `lumen-md` and the 8 components from `npm run i18n:weblate -- --print`.
   Turn on reviews, and add the two cleanup add-ons.
4. Ask the Arabic reviewers to start, with the brief.
