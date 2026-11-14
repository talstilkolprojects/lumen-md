---
title: Train a model on your style, on this machine
description: A LoRA adapter trained on your own notes on a Mac or NVIDIA computer and used in Ollama. Nothing is uploaded.
---

`⌘K → AI fine-tune settings…` now offers the **local route first**. Lumen
exports your notes as training data together with a script. You run the
script on your own computer, and the result appears in Ollama as the model
`lumen-style`. The cloud fine-tune (OpenAI) is still offered below it.

## Steps

1. Choose the notes to learn from (a folder, or all of them) and your
   computer type, then click **Export training data and script**. You get
   `lumen-lora.zip`, which contains:
   - `train.jsonl` and `valid.jsonl`: chat-format samples cut from the
     prose of your notes. Frontmatter, code and tables are left out. When
     you have a [style profile](/ai/agents/), its tone and rules go into
     the system prompt.
   - `heldout.json`: about one note in ten, which is never trained on. It
     is used to check the result.
   - `train-mac.sh` or `train-nvidia.sh`.
2. Unzip the file and run the script in its folder.
   - **Mac (Apple silicon):** the script runs `mlx_lm.lora` on Mistral 7B
     Instruct (Apache-2.0), then `mlx_lm.fuse --export-gguf`, and creates a
     Modelfile with `FROM` the GGUF. MLX can export GGUF only for Llama,
     Mistral and Mixtral, which is why the base model is Mistral.
   - **NVIDIA:** the script trains with PEFT through the Unsloth core
     library (Apache-2.0). It does not use Unsloth Studio, which is AGPL.
     It then converts the adapter with llama.cpp's `convert_lora_to_gguf.py`
     and creates a Modelfile with `ADAPTER`.
3. Select `lumen-style` as the Ollama model in the AI settings.

## Is it closer to your style?

```bash
node scripts/lora/style-eval.mjs --heldout heldout.json --base mistral:7b-instruct --tuned lumen-style
```

Both models continue the opening of each held-out note. The script embeds
the continuations and the held-out notes with your local embedding model
(`nomic-embed-text` by default) and compares the mean cosine to the
held-out notes. The target is a gain of at least 10% over the base model.
Everything runs against your local Ollama.
