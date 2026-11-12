---
title: Where models download from
description: Every model file comes from Hugging Face, Lumen's mirror or your own copy, and is checked against its sha256 whichever source served it.
---

The models that run in your browser (dictation, Whisper, embeddings, the
reranker, web-llm chat models, translation, niqqud) are downloaded once and
kept on this device. A model is never tied to one host. Each file is tried
from these sources, in order:

| # | Source | When it is used |
|---|---|---|
| 1 | **Hugging Face**, at the commit pinned in `models/registry.json` | First, when it answers. |
| 2 | **Lumen's mirror**: one GitHub release per model on the project's repository | When Hugging Face is blocked, down, or serves different bytes. |
| 3 | **Your own copy**: a web address you enter, or files you pick on this device | When neither of the above works, for example on a closed network. |

## Every file is checked

`models/registry.json` lists every file of a model with its size and
**sha256**. A file is used only when it matches exactly, whichever source
served it. A source that serves other bytes is skipped and the next one is
tried. A file without a published sha256 comes only from Hugging Face at a
pinned commit, never from a mirror or a URL you enter.

Verified files go into the cache the model's library reads, so loading the
model afterwards makes no request at all.

## Your own copy

**AI settings → Model download sources**:

- **Your own copy**: a web address laid out like the mirror's releases,
  `<address>/<release tag>/<file>`, where the file name is the path in the
  model's repository with `/` written as `__`. For example, download a
  release's assets into a folder named after its tag and serve it. This
  deployment's security policy (CSP `connect-src`) must allow the address.
- **Add model files from this device…**: pick files you already have. Lumen
  keeps each one whose size and sha256 match a model file in the registry,
  whatever its name. The others are reported as not recognised.

## Lumen's mirror

GitHub Releases holds the copy: each file can be up to 2 GiB, and GitHub sets
no total size or bandwidth limit for a release. GitHub's download links send
no CORS header, so a browser can't read them directly. A small Cloudflare
Worker (`edge-workers/model-mirror`, on the free Workers plan) adds that one
header and streams the file through. It stores nothing and can reach only
`models-*` releases. It isn't trusted with the content either, because the
app checks the sha256.

Cloudflare R2 was considered and not chosen. Its free tier is 10 GB-month of
storage with free egress, which is too small for the web-llm models, and its
`r2.dev` addresses are rate-limited and meant for development only.

A deployment turns the mirror on with `VITE_MODEL_MIRROR_URL`, and the build
adds its origin to the CSP. Until then, step 2 is skipped.

## For maintainers

```sh
npm run models:mirror -- --check            # what can't download without Hugging Face yet (offline)
npm run models:mirror -- --pin              # pin revisions + sha256 of every file (needs Hugging Face)
npm run models:mirror -- --upload           # one release per model, every file verified first
npm run models:mirror -- --verify --deep    # read every file from the mirror only, check sha256
```

Only models whose licence class is `allowed` are mirrored by default. Each
release's notes carry the model's licence and attribution.
