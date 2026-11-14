---
title: Screen readers, automated
description: The Hebrew screen-reader journey run by Guidepup under VoiceOver and NVDA, and the accessibility-tree snapshots that run with every end-to-end test.
---

Automated checks such as axe find only part of what blocks a screen reader
user. Lumen checks screen-reader output at two levels.

## 1. Accessibility-tree snapshots (every e2e run)

`e2e/aria-hebrew.spec.ts` pins what a screen reader receives in the Hebrew
interface: roles, names and states. It uses Playwright's aria snapshots on
Chromium, with no screen reader needed:

- the skip link comes before the main landmark;
- a note's headings carry their levels, task checkboxes their state, and links their names;
- the command palette is a named modal dialog with a search box and results as options;
- the keyboard-shortcuts dialog is named and has a heading.

```sh
npx playwright test e2e/aria-hebrew.spec.ts --project=chromium
```

## 2. Real screen readers (Guidepup, on a Mac or Windows)

`sr/` runs ten tasks of the screen reader protocol (plan W1.23)
with [Guidepup](https://www.guidepup.dev/) (MIT). Guidepup drives VoiceOver
or NVDA and records what it says. Each task passes when the Hebrew it must
hear was spoken. The tasks are in `sr/journey.ts`.

Guidepup needs a real desktop: it takes over the screen reader, the keyboard
and the audio. It does not run in CI containers or in the cloud sandbox.

### On a Mac (VoiceOver)

```sh
npm install -D @guidepup/guidepup @guidepup/playwright   # once
npx @guidepup/setup                                       # once: lets VoiceOver be scripted
npm run test:sr -- --project=voiceover
```

Set the VoiceOver voice to Carmit (Hebrew) in VoiceOver Utility first.

### On Windows or a Windows VM (NVDA)

```sh
npm install -D @guidepup/guidepup @guidepup/playwright   # once
npx @guidepup/setup                                       # once: installs a portable NVDA
npm run test:sr -- --project=nvda-chrome
npm run test:sr -- --project=nvda-firefox
```

Set NVDA's voice to a Hebrew one (eSpeak NG Hebrew or Microsoft Asaf).

### Results

Each run prints a row for the protocol's results table, for example
`| 2026-11-12 | 0.1.0 | NVDA / Windows / chromium (Guidepup) | 10/10 (…) | — |`.
It also writes `sr-results/results.json`, with every phrase spoken in each
task. Paste the row into the protocol's results table and update the
accessibility conformance report from it. TalkBack stays a manual check,
once per release.
