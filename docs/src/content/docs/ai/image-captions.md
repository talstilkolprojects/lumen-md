---
title: Image descriptions on this device
description: Alt text for pasted and attached images — OCR, a local vision model, or a captioning model in the browser. Nothing is sent to the cloud.
---

An image with no alt text, or with only its file name (`IMG_1234`,
`Screenshot 2026-…`), gets a real description. Lumen tries, in order:

1. **OCR** — an image that is mostly text (a screenshot, a slide, a scan)
   gets that text: the first line as alt text, the full text as the image
   title, so search finds it.
2. **A vision model in Ollama** on this machine (qwen2.5vl, gemma3, llava,
   moondream…), asked for one sentence in the note's language.
3. **A captioning model in the browser** — Florence-2 base-ft (Microsoft,
   MIT, ≈ 224 MB), with SmolVLM-256M-Instruct (Hugging Face, Apache-2.0,
   ≈ 189 MB) when Florence-2 cannot load on this device or gives nothing
   usable. Both run in a background worker (WebGPU when available) and
   describe in English; the description is then translated into the note's
   language with [local translation](/ai/translation/). When no local
   translation can take the pair, the English description is kept.
4. Otherwise the file name stays. Lumen never invents alt text.

Every description is checked before it is written: not empty, at least two
words, not the file name or a camera placeholder, not the prompt read back.

## Downloads

The browser models are downloaded from Hugging Face only after you agree
in a dialog that shows the model, its size, its licence and its
attribution. That dialog appears only when you run
`⌘K → Images: alt text from OCR / local vision`. Pasting an image never
asks; it uses a browser model only after you agreed to it once from the
command. Declining stops there: Lumen does not offer the fallback model
in the same run.

To turn off automatic alt text for pasted images, set
`lumen.ai.imageText` to `off`.

## Measured

| Check | Status |
|---|---|
| Order, consent, fallback, validator, translation | unit tests (`caption.test.ts`, `captionWorker.test.ts`) |
| Quality: ≥ 80% of the 50 images of the caption golden set rated ≥ 4 / 5 | **not measured yet** — the set's Crossmodal-3600 part is built by the golden-sets workflow and the other 20 images and all ratings are the owner's (plan 15.11, 15.15) |
| Speed and memory on real hardware | not measured: the models are not reachable from the build machine |
