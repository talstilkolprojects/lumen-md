---
title: Handwriting and ink
description: Write or draw with a pen, an Apple Pencil, a finger or a mouse inside a note. The ink is saved as SVG in the Markdown file, so the note still opens in Obsidian and other editors.
---

Lumen lets you write by hand inside a note: a sketch next to lecture notes,
a formula you would rather draw than type, a signature, a diagram.

## Draw

1. Put the cursor where the ink should go.
2. Open the command palette and run **Handwriting: draw or edit**.
3. Write on the pad. Lift the pen and write again; every stroke is kept.
4. Press **Insert**.

The pad has a **pen** and an **eraser**, four colours, three widths,
**Undo** (also Ctrl+Z / ⌘Z) and **Clear**.

- **Pen and Apple Pencil:** the line gets wider as you press harder.
- **Finger and mouse:** Lumen has no pressure to read, so it estimates the
  width from your speed.
- **The eraser end of a pen** erases, without choosing the eraser first.
  The eraser removes whole strokes.

### Palm rejection

While the pen touches the screen, and for half a second after you lift it,
a hand resting on the screen draws nothing. A stroke that the palm started
just before the pen touched down is thrown away.

Once you have used a pen on the pad, fingers stop drawing, as in most note
apps. To draw with a finger again, turn on **Draw with a finger**. Two fingers
on the pad never draw.

## Where the ink sits

- **On its own line** (the default): at the start of the line. In a Hebrew
  or Arabic note that is the right-hand edge; in an English note, the left.
- **Beside the text (study page)**: the ink floats at the end of the line,
  and the paragraph after it flows around it. In a Hebrew note it sits on the
  left of the text. Use it for handwritten margin notes next to printed text.

Lumen takes the direction from the paragraph just before the cursor, so the
ink is placed the same way in every reader.

## Edit or remove

- In the preview, **double-click** the ink.
- In the source editor, put the cursor anywhere inside the ink block and run
  **Handwriting: draw or edit** again.

Save keeps the ink where it was. Clear and then Save removes it from the note,
with its blank lines.

## What is in the file

The ink is an SVG image written into the Markdown:

```html
<svg xmlns="http://www.w3.org/2000/svg" data-lumen-ink="1" data-ink-id="k3f9a2xq" data-ink-dir="rtl" data-ink-place="block" viewBox="0 0 189 175" width="189" height="175" role="img" aria-label="Handwriting" style="display:block;max-width:100%;height:auto;margin-left:auto">
<path fill="#1f2937" d="M64.3,21.6 Q69.2,25.6 …Z" data-ink-size="5" data-ink-pts="63,23,0.3 67,26.9,0.31 …"/>
</svg>
```

- It is an **HTML block** in Markdown terms: a blank line before and after it,
  and none inside it. The note stays valid Markdown.
- **Obsidian** (reading view) and other editors that show inline HTML draw the
  ink as it looks in Lumen. Editors that hide inline HTML, and GitHub, leave
  the text around it unchanged.
- Each `<path>` keeps the pen points (`data-ink-pts`: x, y and pressure), so
  Lumen can open the ink again for editing. Saving an ink without changing it
  writes back the same bytes.
- Nothing leaves your device: the pad and the ink need no network.

## Limits

- The eraser removes whole strokes, not parts of one.
- Handwriting recognition (turning Hebrew handwriting into text) is not part
  of this feature yet.
- An ink you write by hand in SVG, without `data-ink-pts`, is shown and kept,
  but its strokes cannot be erased in the pad.

## Recognising handwriting (measured first)

Lumen doesn't turn handwriting into text yet, and it won't show such a
feature until it works well enough in Hebrew. No open recogniser does that
today. The measurement comes first:

- **A held-out set**: 300 lines from 20 writers, everyday Hebrew with digits
  and English words, collected with consent under CC BY 4.0. Each writer
  gets a sheet (`npx tsx scripts/eval/handwriting/run.mjs sheet <n>`) and
  writes their 15 lines with the pen in Lumen. The lines of five writers are
  held out and never enter the repository.
- **Two paths.** *Ink* reads the pen's strokes in the order they were
  written, which is easier than reading a picture. *Image* reads a picture
  of the writing with a vision model on your computer (Qwen3-VL-2B through
  Ollama), compared with Tesseract.
- **The bar.** A path is offered only at a character error rate of 15% or
  less (ink) or 20% or less (image) on the held-out lines. The numbers are
  published here either way, and recognition never leaves your device.
