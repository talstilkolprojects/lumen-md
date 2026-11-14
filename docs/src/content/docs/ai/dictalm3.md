---
title: DictaLM 3.0 (Hebrew)
description: Dicta's Hebrew–English model in the local model catalogue — what is verified, what waits for a check, and when it may become the default.
---

[DictaLM 3.0](https://arxiv.org/abs/2602.02104) is Dicta's open Hebrew–English
model family, with tool calling and a 65k-token context. It comes in three
sizes, each adapted from a different base model:

| Size | Base model | Licence | In Lumen |
|---|---|---|---|
| 1.7B | Qwen3-1.7B | Apache-2.0 (verified) | In the model catalogue; download it by name in *AI settings* (Ollama) as `hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF`. Never suggested by default yet |
| 12B | NVIDIA Nemotron Nano V2 | **not verified yet** | Not offered |
| 24B | Mistral-Small-3.1 | **not verified yet** | Not offered |

A model is only offered once its licence is checked in the licence gate
(`npm run licenses`). The 12B and 24B weights' licence and their exact
repositories have not been checked yet, so they are not in any list; they are
recorded in `models/registry.json` as *unknown*.

## When it becomes the default

DictaLM 3.0 replaces the Hebrew model Lumen suggests today only when it scores
**at least 5 points higher** on the agent eval and the Hebrew prompt eval,
measured on your own machine:

- 1.7B is compared with `qwen3:4b` (what Lumen suggests on a 4 GB machine).
- 12B and 24B are compared with `qwen3:14b`.

A model whose licence is a custom one (not an open licence) is offered with
its licence notice, but never becomes the default.

## Running the comparison (developers)

The sizes and their open checks are in `models/dictalm3.json`.

```sh
npm run dictalm3                         # each size, its licence and open checks
npm run dictalm3 -- eval --size 1.7B     # eval both models with Ollama → eval/results/
npm run dictalm3 -- decide --json eval/results/dictalm3-decision.json
```

`eval` refuses a size while any of its checks is open: the repository, the
commit that was evaluated, the Ollama name and the licence. `decide` prints,
for each size, *blocked*, *no results*, *keep*, *offer* or *switch*, and the
catalogue line to add to `src/ai/modelCatalog.ts` when there is one.
