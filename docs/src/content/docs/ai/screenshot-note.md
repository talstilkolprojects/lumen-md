---
title: Screenshot to note
description: Turn a screenshot into Markdown you can edit — tables, lists, code and error messages — with a vision model on your own computer.
---

:::note[Status]
The pipeline and its measurement are in place. The paste and capture
commands, and the numbers with the vision model, come in the next release.
:::

Image descriptions (alt text) say what a picture shows. Screenshot to note
does something else: it copies the *content* of a screenshot into the note,
so you can edit it.

## What you get

- **Tables** become Markdown tables.
- **Lists and headings** stay lists and headings. A dialog's title becomes a
  heading and its buttons a list.
- **Code, terminal output and error messages** go into code blocks, exactly
  as shown. An error message the model left as text is put into a `text`
  code block.
- **Web addresses** seen in the image are kept as text in code, never as live
  links. A screenshot can point anywhere.

## How it works

1. A vision model in Ollama on your computer: Qwen3-VL-2B-Instruct
   (Apache-2.0) by default, or another installed vision model.
2. Without one, Tesseract OCR on this device. It is slower and doesn't
   understand table layout.

Everything runs on your device: Ollama is local, and the OCR runs in the
browser. Because a screenshot can contain text written to fool an AI
("ignore your instructions"), the result goes through the prompt-injection
guard first, and anything suspicious is marked in the note.

## Measured

There are 50 screenshots: 25 Hebrew and 25 English, covering tables,
dialogs, code and errors. Run:

```sh
node scripts/eval/screenshot-note/run.mjs make /tmp/shots
node scripts/eval/screenshot-note/run.mjs measure /tmp/shots --engine ollama
```

The targets: CER ≤ 5%, ≥ 80% of tables right, ≤ 6 seconds per screenshot on
an M1 Mac, and 0 network requests. The OCR fallback alone reaches CER 17.84%
(Hebrew) and 8.61% (English), with 0 of 18 tables right. That gap is the
reason for the vision model.
