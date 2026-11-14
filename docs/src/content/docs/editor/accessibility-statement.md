---
title: Accessibility statement
description: How accessible Lumen is — the standard it follows (Israeli Standard 5568, WCAG), what works, known gaps, and how to report a barrier.
appVersion: 0.1.0
reviewed: 2026-11-10
---

This statement covers the Lumen app (web, desktop and mobile builds) at
version **0.1.0**. It was last reviewed on **10 November 2026** and is
updated with every release: a test (`a11yStatement.test.ts`) fails the
build when the version here and the app's version differ.

## Standard

Israel's Equal Rights for Persons with Disabilities regulations (service
accessibility adjustments, regulation 35) require **Israeli Standard
5568**, which adopts **WCAG 2.0 level AA**. Lumen aims for **WCAG 2.2
level AA**, which includes everything WCAG 2.0 AA asks for.

## What is accessible

- **Keyboard:** every feature is a command in the palette (⌘K / Ctrl+K).
  Dialogs keep focus, Escape closes them, and focus returns to where it was.
- **Screen readers:** dialogs, the editor, the palette and the sidebar edge
  have names and roles. The editor speaks the structure of the line the
  cursor lands on (heading and level, task and its state, code block,
  quote), new suggestions, and the start and end of long AI work. It speaks
  in the interface language, Hebrew or English. **Announce cursor position**
  gives the line, the column and the heading above. **Screen reader
  announcements** switches between headings and structure (default), every
  line, and off.
- **Right-to-left:** Hebrew lines read right to left and English lines left
  to right, in the same document.
- **Contrast:** text is at least 4.5:1 in light and dark mode.
- **Zoom and reflow:** at 200 % and 400 % zoom the main screen, the side
  panels and the dialogs fit the window without scrolling sideways. Code
  blocks scroll inside their own box.
- **High contrast:** in Windows high-contrast mode (forced colours), focus,
  buttons and selected items use the system colours.
- **Reduced motion:** with the system setting on, animations and smooth
  scrolling stop.

## How it is checked

- axe-core (WCAG 2.0/2.1 A and AA) on six surfaces, in Hebrew and English,
  in light and dark mode (`e2e/a11y.spec.ts`).
- In every preview build, axe-core (WCAG 2.0, 2.1 and 2.2 A and AA, target
  size included) on the key Hebrew flows: the main screen in source and
  preview, the calendar and ten dialogs, light and dark
  (`e2e/a11y-hebrew-gate.spec.ts`), and the Hebrew accessibility tree
  (`e2e/aria-hebrew.spec.ts`). A serious or critical violation fails the
  build.
- The same axe rules on 52 of the app's panels and dialogs rendered on
  their own, in Hebrew (light and dark) and English.
- The Hebrew journey under VoiceOver, scripted with Guidepup, on the nightly
  Mac ([screen readers, automated](/editor/screen-reader-automation/)).
- Reflow at 320 px and 640 px wide on ten surfaces, plus a forced-colours
  focus check (`e2e/reflow.spec.ts`).
- Spoken announcements (`e2e/sr-announce.spec.ts`).
- A fixed journey in Hebrew with NVDA, VoiceOver (macOS and iOS) and
  TalkBack: the [screen reader protocol](/editor/screen-reader-protocol/).

## Known gaps

The [accessibility conformance report](/editor/acr/) lists every WCAG 2.2
level A and AA criterion with its status, and a remediation plan for each
one that is only partly met. In short:

- The screen-reader journey has not yet been run with all three screen
  readers for this version. The results are recorded in the protocol when
  it is.
- Charts, diagrams (Mermaid, Graphviz), the canvas and the map are
  pictures. Their source text in the note is the accessible version.
- Content you write yourself, such as images without alt text, is yours to
  make accessible. The alt-text helper can suggest descriptions.

## Accessibility coordinator

Lumen is an open-source project. Its maintainer is its accessibility
coordinator: write through the form below, or open the issue in Hebrew.
Each report gets a reply with what will be done and when.

## Report a barrier

Use the [accessibility report form](https://github.com/talstilkol/lumen-md/issues/new?template=accessibility.yml)
(it is labelled **accessibility**), or **Report an accessibility problem**
in the command palette. Say what you were doing, which screen reader or
tool you used, and what happened. You can write in Hebrew or English.
Accessibility reports are triaged before other bugs.
