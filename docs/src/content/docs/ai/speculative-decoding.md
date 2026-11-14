---
title: Speculative decoding in Ollama
description: Ollama 0.34 speeds up some models by guessing several tokens at once. Lumen measures it per model, keeps it only where it helps, and turns it off for reproducible evals.
---

From version 0.34, Ollama turns on **speculative decoding** by default for the
models that ship a prediction head (Qwen 3.6, Qwen 3.8, Gemma 4). It
can make answers 1.3–2.4 times faster. Two catches have been reported: the
output is not always identical from run to run, even at temperature 0, and on
one model (qwen3.8) it made answers about four times *slower*.

What Lumen does:

- **Measures each model once per Ollama version.** After a model first answers,
  Lumen times a short answer in the background with Ollama's default and with
  speculation off (`draft_num_predict 0`).
- **Keeps it only where it helps.** If the default is less than 10% faster,
  Lumen turns it off for that model. So the automatic choice is never slower than off.
- **Shows the numbers** in the AI doctor (⌘K → *AI doctor*), under
  *Speculative decoding*, for example `qwen3.6:27b: 48 → 115 tok/s (×2.4, on)`.
- **Turns it off for evals.** `npm run eval:*` and `npm run models:day` send
  `draft_num_predict 0` on every request and record the Ollama version with the
  results, so a score can be reproduced.
- **Never suggests an external draft model.** A mismatched one made
  answers 73% slower in the reports.

To measure on your own machine from a terminal:

```bash
node scripts/ollama-speculative.mjs measure          # tok/s with and without, per model
node scripts/ollama-speculative.mjs repro --model qwen3.6:27b   # byte-identical with the pin?
```
