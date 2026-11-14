---
title: Visual regression
description: npm run test:visual compares ten surfaces in English and Hebrew, light and dark, with their pixel baselines — locally, no CI needed.
---

`npm run test:visual` takes 40 screenshots — ten surfaces, in English (LTR)
and Hebrew (RTL), in the light and the dark theme — and compares each with
its baseline. A pixel change nobody meant fails the run; so does a surface
without a baseline.

| Surfaces |
| --- |
| split · source · preview · WYSIWYG · command palette · keyboard shortcuts · plugin gallery · template gallery · theme settings · AI settings |

## First run on a machine

```bash
npx playwright install chromium
npm run test:visual:update      # builds, serves dist/, writes visual/__baselines__/<platform>/
```

Open every PNG, then commit the folder. From then on:

```bash
npm run test:visual
```

A failure leaves the expected, actual and diff images in `visual-results/`
(`visual-results/report/index.html`).

## What keeps the shots stable

- The production build, served by `vite preview`.
- Chromium only, 1280×800 at 1×, browser locale en-US and time zone UTC.
- A fixed note (in English or in Hebrew), a fixed clock, no service worker.
- The app's own fonts; animations, transitions, scrollbars and the caret off.
- The parts that depend on the machine (whether a local model runs) are
  masked.

Baselines are per platform: compare on the same kind of machine that wrote
them. Each shot also fails if the page is wider than the viewport — the
commonest RTL layout bug.

## An intended change

Run `npm run test:visual:update`, review the PNGs that changed and commit
them with the change.

## Does the gate work?

`visual/selftest.visual.ts` writes a throwaway baseline of the split view,
moves the toolbar by 3 px and checks that the comparison fails.

## The RTL matrix

`visual/rtl.visual.ts` adds six shots of the RTL matrix note
(`e2e/rtl-note.ts`): the preview and WYSIWYG in Hebrew, light and dark, and
the preview on an iPhone 14 and a Pixel 7.

## Real Safari, Firefox and Edge (Percy)

The local baselines are taken in Chromium. RTL layout bugs show up most in
Safari, so main's promotions are also checked with Percy, which is free under
BrowserStack's open-source plan. Percy takes 30 screens, each in Hebrew and
English and in light and dark:

- the ten surfaces above;
- the RTL matrix note;
- nineteen views opened by their palette commands: settings, graph, canvas,
  search, version history and others (`visual/percy-surfaces.ts`).

Playwright captures each screen's DOM in Chromium (`visual/percy.percy.ts`).
Percy then renders that DOM in real Chrome, Firefox and Safari (and Edge) and
compares it with main's approved baseline. The local baselines stay as they
are.

```sh
PERCY_TOKEN=… npm run visual:percy             # 30 screens × 4 variants
PERCY_TOKEN=… npm run visual:percy -- --canary # self-test: RTL text moved 2px
```

The canary build adds a 2px shift to RTL text in the preview. It must show
changes in every browser and is never approved. Outside `percy exec` the
suite skips itself. The token lives in the agent's secret store, and the run
is part of the release pipeline (W7.21), not GitHub Actions.
