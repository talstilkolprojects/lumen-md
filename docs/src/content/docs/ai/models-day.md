---
title: Real models day
description: One command that runs every real-model eval on a machine with Ollama and a GPU, resumes after a stop, and writes one sealed report.
---

Most of Lumen's AI checks run against a **fake Ollama** in tests: they prove
the wiring (prompts, parsers, tool calls), not the quality of a model. The
real numbers need a real model on a real GPU. `npm run models:day` runs all
of them in one go.

## Before you start

```sh
npm ci
npm run models:day -- check
```

`check` runs nothing. It lists what is missing, with the exact install
command for each item:

- Node ≥ 22.6 and `npm ci`
- Ollama ≥ 0.5 (structured outputs), running (`ollama serve`)
- a GPU: 12 GB of VRAM, or Apple Silicon with at least 16 GB
- the models, by exact tag: `ollama pull gemma3:12b`, `ollama pull qwen2.5:7b`,
  `ollama pull qwen2.5-coder:1.5b`, `ollama pull qwen3:0.6b`,
  `ollama pull nomic-embed-text` (about 15 GB together)
- for dictation WER: Python 3 with `pip install -r scripts/golden/requirements.txt`, and ffmpeg
- for the browser engines: `npx playwright install chromium`

Missing models are pulled by the run itself unless you pass `--no-pull`.

## Run it

```sh
npm run models:day
```

`npm run models:day -- plan` shows the steps, what each one measures, and its
declared time. The default steps are declared at 3 hours or less on a 12 GB
GPU. A step whose script is not on the checked-out branch is **unavailable**
and names the PR that adds it. A step that needs something only you have,
like the meeting recordings (`--meetings-dir`), is **blocked**. Neither one
counts as a failure.

| Step | Measures |
|---|---|
| `agents-gemma3`, `agents-qwen` | every agent's cases (target ≥ 90 % and ≥ 80 %) |
| `pdf-chat` | answers cited to the right page, and citation nDCG@5 |
| `summarize` | summary sentences grounded in the source |
| `fim` | autocomplete latency p50 / p95 (target p50 < 300 ms) |
| `real-tiny` | every agent once on `qwen3:0.6b` |
| `rerank` | the reranker on HeQ |
| `asr-zipformer`, `asr-web` | dictation WER on FLEURS-he validation (target ≤ 15 %) |
| `tool-calls` | valid tool calls on both models (target ≥ 95 %) |
| `bench-models` | every browser engine in Chromium on WebGPU |
| `meetings`, `canvas-draw`, `crosslingual`, `lit-review` | each feature's own eval |
| `dictalm3` (optional: `--with dictalm3`) | DictaLM 3.0 against `qwen3:4b` |

## Stop and continue

Each step's result is saved as soon as the step ends. Press Ctrl-C at any
point and run the same command again: finished steps are kept, and the step
that was running starts over. Use `--redo <step>` to run a finished step
again, or `--fresh` to start a new run.

## The report

Everything goes to `eval/results/day/<run>/`:

- `<step>/`: the eval's own files, plus `log.txt`
- `report.md`: a table per step and per agent, and which plan task each step covers
- `report.json`: the commit, the machine, the GPU, each model's Ollama
  digest, and every file with its sha256. A **receipt** (a sha256 over the
  whole report) seals it.

Pass `--sign-key key.pem` to also sign the receipt with Ed25519 (make a key
with `openssl genpkey -algorithm ed25519 -out key.pem`). To check a report:

```sh
npm run models:day -- verify eval/results/day/<run>/report.json
```

This fails if the report or any result file changed after the run. If the
server was the fake one from the tests (`npm run fake-ollama`), the whole
report says **WIRING RUN, NOT A MODEL SCORE**.
