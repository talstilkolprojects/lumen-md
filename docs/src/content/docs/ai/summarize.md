---
title: Grounded summaries on this device
description: Summaries made on this device whose every sentence is copied from the text and checked against it — Chrome's Summarizer for English, a local model for Hebrew, and a model-free fallback.
---

`⌘K → "AI: Summarize This Note (on this device)"` and **Summarize** in the
[Ask a PDF](/workspace/pdf-chat/) panel make a short summary in which
**every sentence is copied from the text** — shortened with "…" where words
were left out — and checked against it word for word (`quoteContained`, the
rule the research citations use). A sentence that isn't in the text is
never shown. In a PDF each sentence links to its page and line.

## Layers

| Layer | When | What |
|---|---|---|
| Chrome's Summarizer API | English text, and the browser already has its model | Chrome's on-device summary — used only if at least 95 % of its sentences are in the text (it often paraphrases) |
| Local model | otherwise | the `summarizer` agent on Ollama or the in-browser model — **local executors only**, under any AI policy. For Hebrew, DictaLM 3.0 1.7B in Ollama when it is installed; else the runtime's local pick (Qwen3 in web-llm in the browser). A long text is summarised section by section, then once more over the section summaries. |
| Extractive | no local model, or nothing usable | the sentences that carry the text's most frequent content words, in their order — no model at all |

Chrome's Summarizer doesn't support Hebrew, so a Hebrew text always goes to
the local model. A model whose answer has fewer than 80 % of its sentences
in the text is asked once more, with the reason.

Install the Hebrew model in Ollama (it is listed in its library as DictaLM
3.0), and Lumen picks it for Hebrew summaries by its name.

## Measuring it

`npm run eval:summarize` summarises the documents of the golden summary set
(plan 7.10, `eval/golden/summarize`) on your Ollama and reports the share of
the model's sentences that pass the grounding check **before** any is
dropped (target: ≥ 95 %), with key-word coverage as a second signal.
`LUMEN_EVAL_SUMMARY_DIRS` adds the held-out test split built with the golden
seed, for all 20 documents.
