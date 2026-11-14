---
title: Hebrew typography
description: Gershayim, geresh, maqaf, Hebrew quotation marks and numbers, fixed as you type or for a whole note. Each rule can be turned off.
---

Word has fixed Hebrew punctuation automatically for decades. In Lumen, the
source editor does the same **as you type**, and **Hebrew typography…** in
the command palette applies it to a whole note after a preview.

| Rule | You type | You get |
|---|---|---|
| Gershayim | `צה"ל` | צה״ל |
| Geresh | `ג'ירפה` | ג׳ירפה |
| Hebrew quotation marks | `"שלום"` | „שלום” |
| Maqaf | `בית-ספר` | בית־ספר |
| Dash between words | `אחד - שניים` | אחד – שניים |
| Numbers | `50 %`, `%50`, `10–20` | 50%, 50%, 10-20 (a range reads in order right to left) |
| Mixed lines | `HTML היא שפה.` | an invisible right-to-left mark (RLM) at the start, so the line reads right to left and the period lands at its end |

Every rule works only in a Hebrew context. `say "hello"`, `it's` and `ב-2026`
stay as they are, and so does a prefix before a quote: `ו"ההגנה"` becomes
ו„ההגנה”, not a gershayim.

## Never changed

Nothing changes inside **code** (fenced blocks and inline code), **links**
and URLs, wiki-links, HTML tags, math, or the **frontmatter**.

## Undo

Each fix is its own undo step. **Ctrl+Z / ⌘Z** right after a fix gives back
the character you typed, and the next keys you type don't redo the fix. A
quotation mark right after a Hebrew letter is fixed when you type the next
key, because by then it is clear whether it is ״ (צה"ל) or a closing ”.

## Turning rules off

In **Hebrew typography…** (command palette):

- **Fix as I type** turns the automatic fixes on or off.
- Each rule has its own checkbox.
- The dialog lists every change the rules would make to the current note.
  **Apply to the note** makes them all as one undo step.

The settings are saved in this browser.

## How it is checked

`src/__tests__/hebrewTypography.test.ts` covers:

- 50 golden cases.
- A note with code, links, URLs, HTML, math and frontmatter where none of
  those change.
- Each rule turned off on its own.
- Typing character by character, including an undone fix that stays undone.

`e2e/hebrew-typography.spec.ts` types in the editor, undoes a fix, and
applies the dialog.
