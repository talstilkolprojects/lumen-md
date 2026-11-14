---
title: Structured output and Chrome's built-in model
description: How Lumen's local AI returns JSON that always matches what the feature asked for, on Ollama, the in-browser model or Chrome's built-in model — and when the built-in model is used with no download.
---

Many AI features need an answer of a fixed shape: a category, a list of tags,
a date, a task with a priority. Lumen asks every local engine for exactly that
shape (a JSON Schema) and checks every answer itself:

| Engine | How the shape is enforced |
| --- | --- |
| Ollama (desktop) | `format` with the JSON Schema |
| In-browser model (web-llm, WebGPU) | `response_format` with the schema |
| Chrome's built-in model (Chrome 148+ on desktop) | the Prompt API's `responseConstraint` |

If an answer does not match, Lumen asks once more with the error, then tries
the next engine. If an engine is not there (Firefox, Safari, a phone, no
Ollama), it is skipped without an error.

## The built-in model: AI with no download

Chrome 148 and later on Windows, macOS, Linux and Chromebook Plus can include
a small model on the device. When Chrome already has it, Lumen can use it for
**short tasks** (a category, tags, a date) without downloading anything,
which is the difference between AI in the first minute and a download screen.

- It is used only after it passed Lumen's Hebrew eval: at least 90 % of the
  score of your current local model on the same short tasks, measured on your
  Chrome version. Until then, and on every other browser, Lumen uses Ollama or
  the in-browser model.
- Lumen never starts the built-in model's download itself.
- It runs on your device: the privacy ledger lists each use as *on-device*,
  and airplane mode allows it, since nothing leaves the device.
