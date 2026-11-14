---
title: Translation review (the UI's seven languages)
description: The agent that checks every translation of Lumen's interface against its English — missing variables, odd lengths, untranslated strings and, on this machine, a back-translation.
---

Lumen's interface is translated into seven languages (Arabic, German,
French, Hebrew, Japanese, Russian, Chinese). `npm run i18n:review` checks
every translation against its English source and prints a report:

| Check | Level | What it means |
|---|---|---|
| missing variable | error | a `{placeholder}` of the English is not in the translation — the UI would lose the value |
| extra variable | error | a `{placeholder}` the English doesn't have — it would show literally |
| length | warning | far shorter or longer than the English (Japanese and Chinese have their own bounds) |
| untranslated | warning | the English word for word (product and format names are fine) |
| deviation | warning | with `--back`: translated back to English **on this machine** (M2M100 through transformers.js — no cloud), it shares little with the English (chrF < 25) |
| missing key | info | no translation yet; the UI shows English |

The command exits with status 1 when there is any error, and the test
`src/__tests__/i18nReview.test.ts` holds the seven locales at **0 missing
variables**.

```sh
node scripts/extract-i18n-keys.mjs          # refresh i18n/keys.json first
npm run i18n:review -- --out review.md      # the report
npm run i18n:review -- --back --sample 200  # with back-translation (downloads M2M100 once)
```

The first run fixed 34 missing variables — strings in six languages that had
been cut at an escaped quote (`git.alert.cloned`, `collab.prompt.join`,
`tree.confirm.deleteFile`, `tree.confirm.deleteFolder`) and a German and
French `writingGoal.done` without its numbers.
