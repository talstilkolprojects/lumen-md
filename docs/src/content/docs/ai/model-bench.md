---
title: Measuring the local models
description: npm run bench:models runs every local engine on its golden set in a real browser, with WebGPU, and writes time, memory and quality into models/registry.json.
---

Lumen's local engines are measured where they run: in a browser, through
the app's own code (the transformers.js worker, tesseract.js), on the
golden sets in `eval/golden/`. The numbers go into `models/registry.json`,
next to each model's licence.

## Run it

On a computer with a GPU:

```bash
npm ci
npx playwright install chromium     # once
npm run bench:models
```

The command:

1. Starts the Vite dev server and opens `bench/models.html` in Chromium,
   in a window, with WebGPU on.
2. For each engine:
   - Loads its model once, so it is downloaded and cached.
   - Opens a fresh page and measures that page.
3. Prints a table and writes the numbers to
   `eval/results/bench-models-<date>.json`.

Nothing in the table or the file is an item, an input or an output: only
numbers.

To store the numbers in the registry:

```bash
npm run bench:models -- --write
```

## What is measured

| Number | What it is |
|---|---|
| `loadMs` | Loading the model from the browser's cache (the first, downloading load is not counted unless `--no-prime`) |
| `prepareMs` | Work done once per part, such as embedding the corpus |
| `p50Ms`, `p95Ms` | Time per item |
| `rssPeakMB`, `rssDeltaMB` | Resident memory of the whole browser (page, workers, GPU process) at its peak, and above the idle page |
| `jsHeapPeakMB` | The page's JavaScript heap at its peak |
| `quality` | The set's own metric: nDCG@10 for retrieval, CER for OCR (per condition), WER and CER for speech |

GPU memory itself is not visible to a web page. The GPU process's
resident size, counted in `rssPeakMB`, is the closest number.

## Engines

| Engine | Set | Model |
|---|---|---|
| `bm25` | retrieval | none: the baseline, reported but never written |
| `bge-rerank` | retrieval | `onnx-community/bge-reranker-v2-m3-ONNX` over BM25's 20 candidates |
| `e5` | retrieval | `Xenova/multilingual-e5-small`, dense, over the whole corpus |
| `tesseract` | ocr-he | `tessdata_fast` heb + eng |
| `whisper-tiny`, `whisper-small`, `whisper-turbo` | asr-he | `onnx-community/whisper-*` |

An engine is a file in `src/bench/engines/`. It exports a `BenchEngine`
with an id, the golden set it is measured on, the registry ids of its
models, and three functions: `load`, an optional `prepare`, and `run`.
How a set is scored is in `scripts/bench/tasks.mjs`. A feature that adds
a local engine adds its adapter there, so the next run measures it.

## When numbers are not written

`--write` stores a result as `measured.<device>` of each of the engine's
models only when the result is real and complete:

- The run had no error.
- Every item of every part was measured: not with `--limit`, and on the
  test split no part is below its size.
- The engine is a model, not the baseline.
- A WebGPU run really ran on WebGPU, on a real GPU. A run that fell back
  to WebAssembly is not a WebGPU number. Neither is one on SwiftShader,
  the CPU emulation headless Chromium offers when there is no GPU.

## Options

| Option | Meaning |
|---|---|
| `--engines a,b` | Only these engines |
| `--backends webgpu,wasm` | Also measure WebAssembly: the page is shown no WebGPU, so the app picks wasm as on such a device |
| `--split test --dir <dir>` | The held-out test split (built in CI) |
| `--limit N` | The first N items per part: a quick check, never written |
| `--channel chrome` | Installed Chrome instead of Playwright's Chromium |
| `--headless` | No window (WebGPU is less reliable this way) |
| `--url <url>` | Use a dev server that is already running |
