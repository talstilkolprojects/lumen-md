---
title: Large vaults and long notes
description: How Lumen stays fast with 10,000 notes and with a single 2 MB note — and how that is measured.
---

Lumen is built to stay responsive with a vault of **10,000 notes** and with a
single note of **2 MB** (plan 8.4). Nothing needs to be switched on; this page
explains what happens and what to expect.

## A vault with thousands of notes

- **The index lives in a Web Worker.** Search (`⇧⌘F`), backlinks and the tags
  panel read one shared index of your notes. It is built once, in a
  background worker, so a query over 10,000 notes never blocks typing.
  Hebrew search (niqqud, final letters and prefix letters folded) is prepared
  when a note is indexed, not on every query.
- **A save re-indexes only that note.** After the first build, saving a note
  re-reads that note alone; renaming or deleting a note or a folder moves or
  drops its entries without reading anything. When files change behind
  Lumen's back (another tab, a folder edited elsewhere), the index re-lists
  the vault and re-reads only the files whose modification time changed.
- **The file tree and the index share one listing** of the vault after a
  structural change.
- **Big vaults open with folders collapsed.** With more than 1,000 notes the
  file tree starts with its folders closed (the folders of the open note stay
  open), so opening the vault does not render 10,000 rows.

## A very long note

From 50,000 characters on, three things change — the result on screen is the
same:

- **The outline** re-parses only the blocks that changed (a paragraph, a list,
  a code block). Opening or closing a code fence, or changing a reference
  definition (`[label]: url`), re-parses what it affects.
- **The preview** is rendered block by block. After an edit only the changed
  blocks are rendered again, and rendering pauses every few milliseconds so
  the editor stays fluid. A note with footnotes, reference definitions or
  suggestions (CriticMarkup) is rendered in one pass, as before.
- **The word count** in the status bar, and keeping a copy of the open note
  in the browser's storage for the next session, happen when you pause
  typing rather than on every keystroke.

## Targets and how they are checked

| What | Target | Checked by |
| --- | --- | --- |
| Open the app with 10,000 notes | < 1 s | `e2e/perf-vault.spec.ts` (production build) |
| Save → index updated | < 50 ms | `e2e/perf-vault.spec.ts`, `src/__tests__/vaultWorker.test.ts` |
| Search 10,000 notes | < 100 ms | `e2e/perf-vault.spec.ts`, `src/__tests__/vaultWorker.test.ts` |
| Typing in a 2 MB note | < 16 ms per keystroke | `e2e/perf-vault.spec.ts` (`@nightly`) |

The unit tests count work rather than time it: a save reads one note and
re-indexes one note, a rename reads none, backlinks read only the linking
notes, a keystroke in a long note re-parses one block. The outline is
compared with the one-pass outline on random documents and random edits.

The 2 MB typing test runs every night (`.github/workflows/nightly-perf.yml`),
not on every pull request. To run it yourself against a production build:

```sh
npm run build
npx http-server dist -p 5180 -c-1 --cors &
PLAYWRIGHT_BASE_URL=http://localhost:5180 npx playwright test --project=perf
```

Each run attaches the measured numbers to the Playwright report as `perf`
annotations.

## For developers

- `src/storage/vaultIndexCore.ts` — the index (pure, runs in the worker or in
  the page); `src/storage/vaultIndex.worker.ts` and
  `src/storage/vaultIndexProtocol.ts` — the worker and its messages;
  `src/storage/workspaceIndex.ts` — the main-thread side, fed by the
  VaultBackend's events (`watchVault`).
- `src/renderer/blocks.ts` — top-level blocks of a document, re-scanned only
  around an edit; `src/renderer/incrementalToc.ts` and
  `src/renderer/incrementalPreview.ts` build on it.
- Semantic-search vectors are kept as one `Float32Array` per note, with the
  norms precomputed (`packVectors` in `src/ai/semanticSearch.ts`).
