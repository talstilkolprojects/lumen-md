---
title: Screen reader protocol
description: The fixed Hebrew journey run with NVDA, VoiceOver and TalkBack before a release, and its results.
---

Automated checks such as axe find only part of what blocks a screen reader
user. This journey is run by a person, **without looking at the screen**,
with each screen reader, in **Hebrew** (Hebrew interface, Hebrew voice).
A step passes when it is done with the screen reader alone. A **blocker** is
a step that cannot be done at all. The release target is **0 blockers**
on every screen reader.

## Setups

| Screen reader | System | Browser | Voice |
|---|---|---|---|
| NVDA 2025.x | Windows 11 | Firefox and Chrome | eSpeak NG or Microsoft Asaf (Hebrew) |
| VoiceOver | macOS 15+ | Safari | Carmit (Hebrew) |
| VoiceOver | iOS 18+ | Safari | Carmit (Hebrew) |
| TalkBack | Android 14+ | Chrome | Google TTS, Hebrew |

Before starting: in Lumen, set the language to עברית (Settings → Language,
or the setup) and clear the site data so the first run starts fresh.

## The journey

1. **Start.** Open the app. The page title and the editor's name are read.
2. **Skip link.** Tab once: "Skip to the editor" is read; Enter moves focus into the editor.
3. **Write.** Type `# תוכנית`, Enter, then a line of Hebrew text. The text is read as typed, in Hebrew.
4. **Structure.** Arrow up to the first line: "כותרת 1: תוכנית" is read.
5. **Task.** Add `- [ ] לקנות חלב`, arrow away and back: "משימה, לא בוצעה" is read.
6. **Where am I.** Open the palette (Ctrl+K / ⌘K), type `מיקום`, Enter: the line, the column and the heading are read.
7. **Palette.** In the palette, arrow through the results: each command's name is read, and the number of results is read when it changes.
8. **Dialog.** Open the keyboard shortcuts (Ctrl+/ / ⌘/). The dialog's name is read, Tab stays inside, Escape closes it, and focus returns to the editor.
9. **Search.** Open search, type a word from the note, open the result: the note opens and focus is in the editor.
10. **Sidebar.** Open the workspace sidebar from the palette, move through the files and open one.
11. **Preview.** Switch to preview (from the palette). Headings can be listed with the screen reader's headings list, in order.
12. **AI.** If AI is set up: run a writing command. "ה-AI עובד…" and then "ה-AI סיים." are read, and the result can be reached.
13. **Mixed direction.** A line with Hebrew and an English word is read in the right order.
14. **Settings.** Open theme settings, switch to dark mode and back with the keyboard. Each control's state is read.

## Results

Each run adds a row: the date, the Lumen version, the setup, the steps that
passed, and each blocker with a link to its issue.

| Date | Version | Setup | Passed | Blockers |
|---|---|---|---|---|
| — | 0.1.0 | NVDA / Windows | not run yet | — |
| — | 0.1.0 | VoiceOver / macOS | not run yet | — |
| — | 0.1.0 | VoiceOver / iOS | not run yet | — |
| — | 0.1.0 | TalkBack / Android | not run yet | — |
