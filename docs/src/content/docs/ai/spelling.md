---
title: English spelling on this device
description: Spell-check English notes with a dictionary that ships with Lumen — no LanguageTool account, no request leaves the device.
---

Lumen's grammar check (`⌘K → Check grammar (LanguageTool)`, and the background
underlines when *Grammar check* is on) has three backends. Which one runs
depends on the AI policy and on what you configured:

| | Under *local only* | Under *local first* / *cloud* |
|---|---|---|
| LanguageTool on this machine or network (`lumen.grammar.endpoint`, e.g. `docker/local-ai.yml` on port 8010) | used | used |
| The public LanguageTool API (`api.languagetool.org`) | **never contacted** | used |
| English dictionary on this device (this page) | used | — |
| Local proofreader model | added when you run the check yourself | — |

Hebrew paragraphs are always checked on this device (rules plus the
optional Hspell dictionary) and never sent anywhere.

## What it checks

- **Words**, against the en-US Hunspell dictionary
  ([dictionary-en](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en)
  4.0, SCOWL word list, MIT AND BSD) through
  [nspell](https://github.com/wooorm/nspell) (MIT), in a background worker.
  The dictionary (≈ 0.55 MB) is part of the app: nothing is downloaded.
- **Only English paragraphs.** Each paragraph's language is detected on
  this device; a French or German paragraph is not marked as misspelled
  English. A paragraph too short to tell follows the rest of the note.
- **Only prose.** Code blocks, inline code, front matter, URLs, e-mail
  addresses, link targets, wiki links, footnote labels, `#tags`, HTML tags,
  ALL-CAPS acronyms, camelCase names and words with digits are skipped.

Hover an underline for up to three suggestions.

## Measured

On the committed dev split of the `spell-en` golden set (25 Moby-Dick
sentences with 32 injected typos), checked by
`node scripts/golden/evals/spell-en.mjs --dev` and by the unit tests:

| Metric | Result | Target |
|---|---|---|
| Typos found | 100% | ≥ 90% |
| First suggestion is the right word | 62.5% | — |
| Right word among the first five | 84.4% | — |
| Correct words marked wrong (clean sentences) | 2.6% | ≤ 3% |

Most false marks are names (*Queequeg*, *Stubb*) and British spellings
(*honour*): the dictionary is American English. The held-out test split
is scored by CI with the set's secret seed.

## Limits

- American English only; other Latin-script languages get no spelling
  check under *local only* unless you run LanguageTool yourself.
- Spelling, not grammar: "their is" passes. For grammar, run LanguageTool
  on this machine or use the explicit check, which adds the local
  proofreader model.
- There is no personal word list yet.
