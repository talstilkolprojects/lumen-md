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
  the editor stays fluid. The blocks you can see come first; the rest of the
  note fills in while the browser is idle, and a part you scroll to jumps the
  queue. Until a block is ready it holds its place with a blank of about its
  height, so the page does not jump, and a link to a heading in it waits for
  it. A note with footnotes, reference definitions or suggestions
  (CriticMarkup) is rendered in one pass, as before.

## Rendering off the main thread

The preview of every note — Markdown parsing, code highlighting (Shiki) and
math (KaTeX) — is worked out in a background worker, so typing is never
held up by it. Link hover cards are made there too. Code blocks and formulas
that did not change are not highlighted or typeset again. Without a worker
(an old browser, or one that blocks it) the same work runs in the page, and
the result is the same.
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

## Responsiveness budget

Load time is measured by Lighthouse; how fast each action answers is
measured separately (plan W1.22), in Chromium with the CPU slowed 4×, like a
mid-range phone:

| What | Budget |
| --- | --- |
| INP over 20 fixed interactions (palette, view modes, opening and switching notes, typing, a task checkbox, search, undo) | p75 < 100 ms |
| Key press → next frame, end of a 50 KB note | p95 < 16 ms |
| Key press → next frame, end of a 2 MB note | p95 < 33 ms |

```sh
npm run perf:inp          # measures (e2e/inp-budget.spec.ts), then gates
npm run perf:inp:gate -- --record   # also appends the run to reports/perf/inp-trend.jsonl
```

The run writes `reports/perf/inp-latest.json`. The gate compares it with
`reports/perf/inp-baseline.json` and fails when any of the three numbers is
10 % or more slower; the first run becomes the baseline
(`npm run perf:inp:gate -- --update` replaces it on purpose).

## Responsiveness on real devices

`npm run perf:responsiveness` measures both editors (source and WYSIWYG) on
a 10,000-note vault, against the production build (plan W6.45):

| Environment | Where | INP p75 budget |
|---|---|---|
| `desktop-chromium` | Desktop Chrome, CPU as is | < 100 ms |
| `mid-phone-emulated` | Pixel 7 emulation, CPU 4× slower | < 200 ms |
| `real-device-*` | real Pixel and iPhone on BrowserStack (`perf:responsiveness -- browserstack`) | < 200 ms |

Keypress → paint p95 must stay under 16 ms in a 50 KB note and under 33 ms
in a 2 MB note, everywhere. Safari has no Event Timing API, so on an iPhone
only keypress → paint is measured; INP shows as "not measured" there,
never as 0.

The related-notes panel is open during the whole measurement, because it
re-ranks after every pause in typing. A build without the panel still runs,
but its run says `relatedPanel: false`, it scores no board number, and it is
never compared with a baseline taken with the panel. To make a new baseline,
run `node scripts/perf/responsiveness.mjs gate --update`.

Each environment has its own baseline in `reports/perf/baselines/<env>.json`.
The first run writes it; commit it. A later run fails when any number is
10 % or more slower than that baseline. The run also writes a signed
`lumen-metric` receipt to `reports/metrics/`, which the area board scores
(`perf.inp-p75-ms`, `perf.inp-p75-mid-phone-ms`, `perf.key2paint-p95-*`).
The nightly perf run and the verification factory run it every night.

## For developers

- `src/storage/vaultIndexCore.ts` — the index (pure, runs in the worker or in
  the page); `src/storage/vaultIndex.worker.ts` and
  `src/storage/vaultIndexProtocol.ts` — the worker and its messages;
  `src/storage/workspaceIndex.ts` — the main-thread side, fed by the
  VaultBackend's events (`watchVault`).
- `src/renderer/blocks.ts` — top-level blocks of a document, re-scanned only
  around an edit; `src/renderer/incrementalToc.ts` and
  `src/renderer/incrementalPreview.ts` build on it.
- `src/renderer/renderCore.ts` — the pipeline up to HAST (no React, no DOM);
  `src/renderer/render.worker.ts` and `src/renderer/renderWorkerCore.ts` — the
  render worker; `src/renderer/renderProtocol.ts` — its messages (a version
  per preview, so a newer render makes an older one stale);
  `src/renderer/renderClient.ts` — the page's side, with the fallback;
  `src/renderer/hastToReact.ts` — the one step that stays in the page.
  `src/renderer/viewport.ts` orders the blocks of a long note. Shiki and KaTeX
  keep their output per block (`src/renderer/blockCache.ts`,
  `src/renderer/math.ts`). Tests: `src/__tests__/renderWorker.test.ts` and
  `src/__tests__/viewportPreview.test.ts`.
- Semantic-search vectors are kept as one `Float32Array` per note, with the
  norms precomputed (`packVectors` in `src/ai/semanticSearch.ts`).
