---
title: Translation drafts
description: npm run i18n:draft drafts new UI strings in all seven languages with a local model; drafts stay "needs review" until a person approves them.
---

Lumen's interface is in eight languages. When you add an English string,
the seven others (Hebrew, Arabic, German, French, Japanese, Russian,
Simplified Chinese) need it too. Instead of leaving them empty, draft them:

```sh
npm run i18n:draft
```

The command finds every English key a language doesn't have yet, drafts it
with a model **on your machine** (Ollama), writes the drafts into
`src/i18n/locales/<lang>/<domain>.json`, and lists each one in
`i18n/needs-review/<domain>.json`. Ten new keys give seventy drafts in one
run.

## Options

| Option | What it does |
| --- | --- |
| `--keys=a.b,c.d` | Draft only these keys |
| `--lang=he,ar` | Only these languages |
| `--model=qwen2.5:7b` | The Ollama model (`OLLAMA_HOST` sets the address, default `http://127.0.0.1:11434`) |
| `--engine=fake` | No model: writes `[he] English text` — a dry run |
| `--list` | What still needs review, per language |
| `--approve=he [--keys=…]` | Mark the Hebrew drafts (or only those keys) as reviewed |

Pass options after `--`: `npm run i18n:draft -- --keys=toolbar.save`.

## What is checked

- Every `{placeholder}` and `` `inline code` `` is swapped for a token the
  model must keep. A draft that loses, repeats or invents one is **not
  written** and is reported.
- A language that already has the key is left alone; re-running drafts
  nothing twice.

## Review

The app shows a draft right away, but the values gate
(`src/__tests__/i18nValues.test.ts`) counts every listed draft as
**untranslated**: Hebrew allows none, the other languages up to 5 %. Read
the drafts, fix what needs fixing in the locale file, then approve:

```sh
npm run i18n:draft -- --approve=he
```

Each entry in `needs-review` keeps a hash of the English text it was drafted
from, so you can tell a draft whose English changed since.

## Engines

Ollama is the engine today. The on-device translation of plan 6.4 (Chrome's
Translator, Opus-MT, M2M100) runs in the browser; it plugs in as another
engine through the same `translate(texts, lang)` interface
(`scripts/lib/i18n-draft.mjs`).
