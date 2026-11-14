---
title: Ask a PDF
description: Questions about a PDF answered on this device from its own pages — every answer with quotes you can open at their page and line.
---

In the [PDF reader](/workspace/pdf-reader/), **Ask** opens a question box
beside the pages. The answer comes from the PDF's own text, on this
device, and every claim carries a quote with its **page and line**; a click
on a quote opens that page and marks the words.

## How an answer is made

1. **Text.** pdf.js reads the text of each page. A page without a text
   layer — a scan — is rendered and read by the on-device OCR (Tesseract,
   Hebrew and English).
2. **Passages.** The pages are cut into passages of whole lines (about 150
   words), each knowing its page and lines. They are ranked for the
   question with BM25 (Hebrew-aware: no niqqud, one-letter prefixes such as
   ו־ה־ב־ל peeled) and, when an Ollama on this machine has an embedding
   model, with embeddings too, the two rankings fused. The index is kept
   while the PDF is unchanged.
3. **Answer.** The six best passages go, numbered, to the `pdf-answerer`
   agent — through the agent runtime, so on a local model (Ollama, or the
   in-browser model) under the *local only* policy. It answers in the
   language of the question and quotes the passages word for word.
4. **Check.** A quote counts only when it is in the passage it names (or
   covers at least 85 % of it, the rule the research citations use); it is
   then placed on its page and line. An answer without one checked quote is
   sent back to the model once with the reason; quotes that still don't
   check out are left out, and the panel says how many.

If the passages don't hold the answer, the panel says *"This PDF doesn't
seem to answer that."* instead of guessing.

## Measuring it

`npm run eval:pdf-chat` asks the questions of the PDF golden set (plan
7.10, `eval/golden/pdf-qa`) against your Ollama and reports the share of
answers whose checked quote is on the page that holds the answer (target:
≥ 85 %). `LUMEN_EVAL_MODEL` picks the model; `LUMEN_EVAL_PDF_DIRS` adds the
held-out test split built with the golden seed. The normal test run checks
the retrieval on the same PDFs without a model.
