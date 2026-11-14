---
title: Privacy and the AI policy
description: What stays on your device, the one setting that decides whether AI may ever use the cloud, and the ledger that records every AI network request.
---

By default nothing you write leaves this device. Notes are kept in the
browser's private storage, or in a folder on the desktop. They go
somewhere else only when **you** turn on sync, collaboration, or a cloud
AI provider.

## The AI policy

`⌘K → AI: Local or Cloud Policy` decides where an AI request may go:

| Policy | Meaning |
|---|---|
| **Local only** | nothing leaves this device: Ollama, the in-browser WebGPU model and transformers.js only. A cloud provider is **never** contacted, not even as a fallback when no local model can answer. |
| **Local first** | local models first; a cloud provider (with your own key) only when none of them can answer |
| **Cloud** | the cloud provider you selected is used directly |

A **fresh install starts on *Local only***. An installation that was set
up for the cloud before policies existed keeps its behaviour (*Cloud*
when a cloud provider was selected, *Local first* when only a key was
configured), so an upgrade never silently changes where your prompts go.

## The privacy ledger

`⌘K → Privacy ledger…` lists every network request the AI features made:
the time, the host, how many bytes went out and came back, why
(cloud AI, a model download, research…), the policy at that moment, and
whether it was **allowed or blocked**. A request the policy forbids is
blocked before it leaves the machine and still appears in the ledger, so
you can see that it was stopped.

The ledger stores **no** prompt, response or header, only the facts above.
It covers AI traffic: provider calls, embeddings, transcription, grammar,
research and model downloads, including the OCR language models fetched
from a worker. Fonts, sync and the app's own files are not AI traffic and
aren't listed.

## Everything else

| Data | Where it lives | Leaves the device? |
|---|---|---|
| Your notes | the browser's private file system (OPFS), or a folder on the desktop | only with sync or collaboration on |
| Settings, search history | this browser's storage | no |
| API keys and tokens | encrypted on this device; the OS keychain in the desktop app ([details](/security/vault/)) | only to the service each one belongs to |
| Collaboration | peer to peer (WebRTC); end-to-end encrypted when the room has a password ([details](/collab/encryption/)) | only to the people in the room |
| Error reports | off unless whoever hosts the app sets `VITE_SENTRY_DSN` at build time | only then |

The full policy is in `PRIVACY.md` in the repository.
