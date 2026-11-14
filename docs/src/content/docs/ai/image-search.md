---
title: Image search by description
description: Find an image in your notes by describing it, in Hebrew or English, on this device.
---

Open the search dialog (`⌘⇧F`), switch to **Images** and describe the
picture: "a red bicycle by the sea", "צילום מסך של הגדרות". Lumen
ranks the vault's images by how well each one matches the description and
shows them as thumbnails. Click an image to copy its Markdown link, then
paste it into the note.

## How it works

- **Model.** SigLIP base multilingual (Google, Apache-2.0). Lumen converts
  it to ONNX itself (plan 6.0) and serves it from its own host. It runs in
  the transformers.js worker, on WebGPU when the browser has it and on
  WebAssembly otherwise.
- **Consent.** The first search asks before downloading the model and shows
  its size, licence and attribution. The model is verified against the
  registry's checksums and cached on this device.
- **Indexing.** Each image is embedded once. Later searches embed only
  images that are new or changed (size or modification time), and drop
  deleted ones. The vectors are kept in this browser's IndexedDB.
- **Hebrew.** SigLIP's Hebrew quality has not been measured on the
  image-search golden set yet. Until it is, a Hebrew description is first
  translated to English on this device by [local translation](/ai/translation/),
  using only layers that are already available, with no second download
  prompt. The tab shows the English it searched with. If no local layer can
  translate, the Hebrew is used as written.
- **Privacy.** Images, descriptions and vectors stay on this device.

## Availability

The converted models need a host, which the owner has not chosen yet (plan
15.9). Until then the tab explains that the model can't be downloaded yet,
and nothing is fetched.

## Quality

`node scripts/golden/evals/image-search.mjs --dev --models <dir>` measures
recall@1, recall@5 and nDCG@10 per query language on the image-search
golden set. The target is recall@5 ≥ 80% for Hebrew queries.
