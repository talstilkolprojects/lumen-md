---
title: Literature review matrix
description: One table of every PDF in the vault, with question, method, sample, findings and limitations, and each value backed by a quote verified on its page. Runs on this device.
---

`⌘K` → **Literature review from the vault's PDFs** reads every PDF in the
vault on this device. Scanned pages are read with OCR. It writes:

- **one note per paper** in `Literature review/`, with five fields as
  properties: question, method, sample, findings and limitations. Under each
  value are the quotes it came from, each with a link to its page and line;
- **`Literature review.base`**, which shows the notes as a table, one row per
  paper and one column per field (Obsidian Bases format). It has two views:
  **All papers** and **Verified only**, which lists only the papers where
  every field is verified.

## No value without a quote

For each field, the passages that search finds go to the local model. The
model answers with quotes copied from those passages. Each quote is then
looked up in its passage and located on its page:

- A value is kept only when at least one of its quotes is found.
- Quotes that were made up, or that cite the wrong passage, are dropped. If
  none is left, the field shows "No value with a verified quote" instead of
  a guess.

The model is the local one in AI settings (Ollama or the browser model). A
cloud model is used only if your AI policy allows it.

## How it is measured

`eval/probes/lit-review.json` has five short papers (English and Hebrew).
For each field it records the right page and a phrase from it.

- `src/__tests__/litReview.test.ts` runs retrieval and verification on
  them with a stand-in model. Retrieval finds the right passage for 24 of
  the 25 fields, and every kept citation is on the right page. It also
  checks that a model that makes quotes up has nothing kept.
- `npm run eval:lit-review` runs the real model and reports the share of
  fields that are right.
- The acceptance set is 20 real papers, which the owner provides in the same
  file format. The plan's targets: 85% of fields right, every citation on the
  right page.
