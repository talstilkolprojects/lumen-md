---
title: Models day on a free cloud GPU
description: One command runs the real models day, held-out sets included, on a free Kaggle GPU and brings back the signed report. Tal's Mac is only the backup.
---

The [real models day](/ai/models-day/) needs a GPU. Until now that meant
Tal's Mac and about two hours of his time. `npm run models:cloud` runs the
same day on a free Kaggle GPU and brings the sealed report back. The only
owner step is activating the account, once.

## The owner step (once, about 5 minutes)

1. Sign in at kaggle.com.
2. **Settings → Phone verification.** Kaggle needs a verified phone number
   for GPUs and internet access in notebooks.
3. **Settings → API → Create New Token.** Put the downloaded `kaggle.json`
   at `~/.kaggle/kaggle.json` (`chmod 600`) on the machine that runs the
   command, or set `KAGGLE_USERNAME` and `KAGGLE_KEY`.

`npm run models:cloud -- setup` checks all of this and the
[held-out](/ai/heldout/) key.

## The command

```sh
pip install kaggle
npm run models:cloud                       # push, wait (≤ 12 h), fetch, verify
npm run models:cloud -- --ref verify/train-2 --no-wait
npm run models:cloud -- fetch <run> --push # later; --push commits it to eval/day-<run>
```

What it does:

1. It makes two one-run keys: an Ed25519 key that signs the report, and an
   X25519 key for a copy of the held-out sets (`npm run heldout -- export`).
   The evaluator's own key never leaves this machine.
2. It uploads them, with `run.json` (the commit and the models:day
   arguments), as a **private** Kaggle dataset.
3. It pushes `scripts/cloud/kaggle_kernel.py` as a private script kernel
   with a GPU (`NvidiaTeslaT4`, 2× T4 with 16 GB each) and internet on.
4. The kernel installs Node 22, Ollama, ffmpeg and the repo at that commit,
   runs `npm ci`, and starts `ollama serve`. Then it runs `npm run models:day`
   with the run's signing key and `--with dictalm3`, so it covers
   `qwen2.5:7b`, `gemma3:12b`, `qwen2.5-coder:1.5b` (FIM) and DictaLM 3.0
   1.7B. It also scores the held-out sets from the run copy. It leaves
   `results.tar.gz` and `cloud.json`.
5. The runner downloads them and checks the receipt and every file. It also
   checks that the signature is by **this run's** key, that the commit is
   the one it asked for, that real models ran (not the fake), and that a GPU
   was found. Only then does it unpack into `eval/results/day/<run>/`.

It prints the W6.18 acceptance as it was measured:

- the models that have an Ollama digest (the target is at least 4);
- the tool-call share against the 95 % target, with any gap stated as is;
- the AI tasks that now have a real number.

## Hebrew dictation, every path

The run measures Hebrew dictation the way each device runs it, on FLEURS-he
validation and on the held-out `asr-he` set:

| Path | Engine | Step | Target |
|---|---|---|---|
| Phone and browser, live | Zipformer2 streaming | `asr-zipformer` | ≤ 15 % |
| Browser, each sentence or file | ivrit.ai turbo (the app's ONNX files, q4f16) | `asr-web` | ≤ 15 % |
| Desktop | whisper.cpp with the ivrit.ai turbo ggml | `asr-whisper-cpp` | ≤ 10 % |

The held-out step scores `asr-he` through all three on the same clips.
`fetch` prints each path's number, met or missed, or why it wasn't
measured, and says when "send to my desktop" is the phone's way to the
target (the phone misses 15 % and the desktop meets it).

- `asr-web` runs the app's model files on the CPU (onnxruntime-node), so
  its WER is the model's and it runs in the cloud. Only its WebGPU
  latency comes from `bench-models` on the Mac. Ozen v1 isn't measured
  while it is off (its training data's licence isn't cleared).
- For the desktop, the kernel builds whisper.cpp at a release tag (CUDA on
  the T4, the CPU if that fails) and downloads the ivrit.ai turbo ggml
  file. The app doesn't pin that file yet, so `cloud.json` records the
  repository, revision, size, sha256 and licence it measured, and `fetch`
  prints the `pin` command of the desktop Whisper script (`whisper:desktop`, W1.17) with those values.
  If whisper.cpp doesn't build or there is no file, the step is reported
  as blocked.
- Outside the kernel, pass `--whisper-ggml <file>` (and `--whisper-cli`)
  to `npm run models:day`.

## Dictation only, in one command

```sh
npm run models:cloud -- dictation
```

This runs only the Hebrew dictation steps (`asr-zipformer`, `asr-web`,
`asr-whisper-cpp` and the held-out `asr-he` through all three), waits for
Kaggle, checks the signed report as above, and pushes `eval/day-<run>`.
That branch also updates `src/ai/dictation/measuredWer.json`, the numbers
"send to my desktop" reads ([Hebrew dictation](/ai/hebrew-dictation/)), so
it is ready for review as it is. It needs the owner step above and the
held-out key; `--no-push` keeps the result local, `--ref` picks another
pushed commit. `fetch` still prints the `whisper:desktop -- pin` command for
the ggml file it measured.

`asr-whisper-cpp` is an optional models:day step (`--with asr-whisper-cpp`),
so the default day stays within its three hours. The cloud run always adds
it, because the kernel builds whisper.cpp.

## What stays on Tal's Mac

The step that needs WebGPU in a real browser: `bench-models`. The kernel
skips it. `npm run models:cloud -- mac` runs the whole day locally, as
before.

## Why Kaggle

Compared on 12.11.2026:

| Option | GPU | Limits | Headless | Verdict |
|---|---|---|---|---|
| **Kaggle Notebooks** | T4 ×2 or P100 (16 GB) | about 30 GPU h/week (shown in your settings); 12 h per session; phone verification | yes: `kaggle kernels push / status / output` | **chosen** |
| Google Colab (free) | varies, usually T4 | not published; ≤ 12 h | no API. The FAQ disallows bypassing the notebook UI and remote control on free runtimes | not usable unattended |
| Lightning AI (free) | through promotional credits | one free CPU Studio; credits can change at any time | an SDK, but the free GPU time is not guaranteed | not chosen |
| Hugging Face ZeroGPU | half an RTX Pro 6000 | 5 GPU min/day for a free account, Gradio only, 60 s per call by default | no: functions in a Gradio Space | cannot run models:day |

Kaggle runs `ollama serve` as a background process in a kernel, along with
llama.cpp (which Ollama uses) and Whisper (Python, or the repo's
ONNX engine in Node). Secrets that are attached through Kaggle's UI are not
kept when a kernel is pushed through the API. That is why the run's keys
travel in the run's private dataset.

**Risks:** Kaggle can change its quota or its terms. A run uses a few hours
of the weekly quota. The run's dataset (one-run keys and the held-out copy)
stays private in the owner's account.

Sources: [Kaggle CLI: kernels](https://github.com/Kaggle/kaggle-api/blob/main/docs/kernels.md),
[kernel metadata](https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels_metadata.md),
[NVIDIA on Kaggle's 30 h/week](https://developer.nvidia.com/blog/how-kaggle-makes-gpus-accessible-to-5-million-data-scientists/),
[fast.ai: phone verification for GPUs](https://course.fast.ai/Resources/kaggle.html),
[free GPUs in 2026 (12 h sessions)](https://gpuperhour.com/blog/free-cloud-gpus-and-credits),
[Colab FAQ](https://research.google.com/colaboratory/faq.html),
[Lightning AI billing FAQ](https://lightning.ai/docs/platform/overview/faq/billing.md),
[ZeroGPU docs](https://huggingface.co/docs/hub/spaces-zerogpu),
[UI secrets lost on API push](https://huggingface.co/spaces/cuilabs/bee/blob/main/scripts/bootstrap_kaggle_secrets.py),
[Ollama in a Kaggle notebook](https://dev.to/ifeanyi_idiaye_3f6d81ed8a/run-deepseek-r-1-thinking-model-in-kaggle-notebook-using-ollama-5195).
