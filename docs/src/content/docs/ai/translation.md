---
title: Local translation
description: Translate a document on this device, in three layers — Chrome's built-in translator, Opus-MT for Hebrew ⇄ English, M2M100 for the rest — with code and links kept exactly.
---

`⌘K → AI: Translate Document` translates the whole note into the language
you name. Since plan 6.4 the translation runs **on this device** whenever a
local layer can take the language pair; the cloud or local LLM is the last
resort, not the first.

## The three layers

| Layer | What | Languages | Download |
|---|---|---|---|
| 1 · Chrome's built-in translator | Chrome's on-device Translator API | the language packs Chrome offers (Hebrew included) | a language pack, managed by Chrome, after your consent |
| 2 · Opus-MT | `opus-mt-en-he` (Apache-2.0) and `opus-mt-tc-big-he-en` (CC BY 4.0), converted to ONNX by Lumen, running in transformers.js in a worker | English ⇄ Hebrew | once, through the consent dialog below |
| 3 · M2M100 | `M2M100-418M` (MIT), same worker | about 100 languages, any pair | once, through the consent dialog |
| 3b · the AI model | the translator agent (your configured LLM) | any | — |

Which layer runs is decided by **measured quality**: each layer's chrF on the
`mt-he-en` golden set (NTREX-128, both directions) is recorded in
`src/ai/mt/quality.json`. Opus-MT is the baseline; a layer measured below
it for a pair is never chosen automatically. A layer whose quality has not
been measured yet may still run, and the toast says so ("its quality on
this pair is not measured yet").

The document's language is detected locally (plan 6.5), paragraph by
paragraph: a paragraph already in the target language is left as it is.

## Nothing downloads without asking

Before the first use of Opus-MT or M2M100 a dialog shows what the model
is for, its **size** (hundreds of MB), its **licence** and **attribution**,
and asks. A yes downloads the files once; Opus-MT's files are checked
against the checksums in `models/registry.json` and kept in this browser's
private storage (OPFS). A no leaves the document untouched and the
translation falls through to the next layer that is already available, or
to the AI model. Nothing you write is sent anywhere by the local layers.

Until the converted models are hosted (plan 15.9) layer 2 reports
"the converted models have no host yet", and the toast after a translation
lists the reason each local layer did not run.

## What never changes

Fenced and indented code, inline code, math, YAML frontmatter, every link
and image target, wiki links, autolinks, bare URLs, e-mail addresses,
footnote marks and HTML tags are kept exactly as they were. Only the words
move: headings, list items, quotes and table cells keep their markers. If a
model disturbs a protected span, the line is translated again run by run,
and the result is checked before it replaces your text.

## Measuring

```sh
node scripts/golden/evals/mt.mjs --dev --models <folder with the converted models>
```

prints chrF per layer and direction on the dev split of `mt-he-en`;
`--write-quality` records the numbers that decide the automatic choice. A
layer the harness cannot run where it is executed is reported as
"not measured", with the reason, never as a number.
