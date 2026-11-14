---
title: Languages in beta, and how to help
description: Six of Lumen's languages were translated by machine and are marked beta until a native speaker reviews them; suggest a better translation from inside the app.
---

Lumen's interface is in eight languages. **English** is the source and **Hebrew** is
written by native speakers. The other six were translated by machine (plan 9.1) and no
native speaker has reviewed them yet, so Lumen marks them **beta**:

| Language | Status |
|---|---|
| English | source |
| עברית (Hebrew) | native |
| العربية (Arabic) | beta |
| Русский (Russian) | beta |
| Français (French) | beta |
| Deutsch (German) | beta |
| 日本語 (Japanese) | beta |
| 简体中文 (Simplified Chinese) | beta |

In **Settings → General → Language** and in the command palette, a beta language reads
"Русский (бета)", "Français (bêta)" and so on, in the language you are using. When the
interface is in a beta language, Settings says the translation is waiting for a native
speaker's review and links to the suggestion form.

## Suggest a better translation

Command palette → **Suggest a better translation** (also linked under the language setting).

1. Type the words you saw on screen. Lumen finds the strings that contain them, in your
   language or in English.
2. Pick the string and write it the way a native speaker would. Keep every `{placeholder}`
   as it is.
3. **Open on GitHub** opens the project's new-issue form in a new tab, with the title
   (`[i18n:ru] toolbar.save`), the labels `i18n` and `locale:ru`, the English source, the
   current translation and yours. You post it with your own GitHub account. **Copy the
   text** gives you the same text to send any other way.

Nothing is sent from Lumen itself: there is no server and no account in the app. The issue
exists only once you post it.

## Review a whole language

The easiest way is in the browser, on [Weblate](/contributing/weblate/): every fix comes back as a pull request.

If you are a native speaker and want to review a whole language, the strings are in
`src/i18n/locales/<lang>/*.json`, one file per area. Open a pull request with your fixes.
New strings drafted by a model are listed in `i18n/needs-review/` until a person approves
them ([Translation drafts](/contributing/translation-drafts/)). When a language has been
reviewed, its status in `src/i18n/review.ts` changes from `beta` to `reviewed`, and the beta
mark goes away.

Arabic is Israel's second right-to-left language, so its review also covers the RTL checks
(the RTL matrix, plan 9.5, runs in Arabic too).
