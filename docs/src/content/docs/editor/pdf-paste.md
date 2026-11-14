---
title: Hebrew pasted from a PDF
description: Hebrew copied out of a PDF often comes out backwards or with the wrong final letters. Lumen notices and offers the fix.
---

Copy a paragraph out of a Hebrew court ruling, government form or article in
PDF, paste it into a note, and it often reads backwards:

```
2024 תנשב PDF-ה ץבוק
```

That is the order the PDF **drew** the letters, left to right, not the order
you read them. Some PDFs also mix up the final letters, giving `שלומ`
instead of `שלום`, or `םשרד` instead of `משרד`.

## The suggestion after a paste

Lumen pastes exactly what was on the clipboard. Then, if the text looks like
reversed Hebrew or Hebrew with broken final letters, a message offers the fix:

> **Looks reversed — fix?**
> Preview: קובץ ה-PDF בשנת 2024

**Fix** replaces exactly what you pasted, as one change, so **Ctrl+Z** brings
the original back. If you ignore the message, nothing changes. This works in
the source editor and in WYSIWYG.

For text that is already in a note, select it and run **Fix reversed Hebrew
(from a PDF)** from the command palette (⌘K).

## What the fix does

- **Reverses each line into reading order.** Lines stay in their order.
- **Keeps numbers, English words and links the right way round.**
  `03-1234567`, `GPT-4`, `gov.il` and `Smith et al. (2021)` are left as they
  are.
- **Turns brackets back the right way.** In a PDF, a bracket inside Hebrew is
  drawn as its mirror image.
- **Fixes final letters.** The last letter of a word gets its final form, and
  a final form inside a word gets its regular one. Acronyms such as
  `מ״מ` or `בג״ץ`, and prefixes before a hyphen such as `כ-35%`, are left alone.

## How it decides

Correct Hebrew never has a final letter at the start of a word (`םולש`), a
common word spelled backwards (`לש`, `אוה`, `ןיב`), or a sentence that
starts with its full stop. Lumen looks for these signs. If the text also
shows signs of reading forwards, such as final letters at word ends or
common words spelled the right way, it does not suggest a fix.

The same check runs over every Hebrew string in Lumen's own interface, more
than 1,400 of them, and finds nothing to fix.

## Limits

- **A line made of one word and a number** may not have enough to go on. An
  example is `טלפונ: 03-1234567`. When the signs are too weak, no fix is
  suggested, and you can still select the text and run the command.
- **A single word ending in a regular letter is left alone,** because it may
  be a loanword (`טיפ`).
- **Some PDF readers put words in reading order but the runs in the wrong
  order.** For example, `PDF קובץ ה-` instead of `קובץ ה-PDF`. That kind of
  copy is not detected.
