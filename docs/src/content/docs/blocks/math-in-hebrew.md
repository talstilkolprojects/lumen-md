---
title: Math inside Hebrew text
description: Formulas in a right-to-left sentence keep their order in the editor, the preview, PDF and Word.
sidebar:
  label: Math inside Hebrew text
---

A formula in the middle of a Hebrew sentence breaks in almost every editor.
`x² + y² = r²` comes out as `r² = y² + x²`, or the `$` signs jump to the
other end. In Lumen a formula is laid out **left to right as one unit**,
wherever it sits in a right-to-left line:

```markdown
במדגם של 40 תלמידים קיבלנו $\bar{x}=12.5$ וזה נכון ב-95% מהמקרים.
```

## Where it holds

- **Preview and print (PDF).** Each formula is an isolated left-to-right
  block, so KaTeX's pieces (`a =`, `b +`, `c`) stay in order.
- **Source editor.** `$…$` is an isolated left-to-right run. The digits,
  operators and `$` signs stay where you typed them, and the cursor moves
  through the formula the way it is drawn.
- **WYSIWYG.** An inline formula is an isolated left-to-right run.
- **Line direction.** A formula does not decide a line's direction. A Hebrew
  sentence that opens with a formula, such as `$x^2$ הוא ריבוע`, is still
  right to left. `$$` display blocks are always left to right, like code.
- **Word (.docx).** Each formula becomes a Word math zone, which Word lays out
  left to right as one unit inside the Hebrew paragraph. The zone holds the
  TeX as written; Lumen does not convert it to Word's built-up equations.

## Typing formulas

- **Ctrl+M** (**⌘M** on a Mac) wraps the selection in `$…$`, or inserts `$$`
  with the cursor between. It also works with the Hebrew layout on. The
  command palette has **Insert inline formula** too.
- **No layout switch inside a formula.** With the Hebrew layout on, keys
  typed inside `$…$` in the source editor come out as the Latin letter of
  the same key: the X key types `x`, not `ס`. Outside the formula, typing is
  unchanged.

## Templates

The template gallery has three study templates, in English and Hebrew:

- **Math exam practice** (בגרות): a quadratic equation, a derivative, sequences;
- **Physics lab report**: theory, a measurement table, error analysis;
- **Statistics problem set**: descriptive statistics, a z-score, a hypothesis
  test.

## Limits

- **What counts as a formula.** A `$` followed by a space, or a closing `$`
  followed by a digit, does not open or close one. So `$5 ו-$10` is money.
  This follows Pandoc's rule, which can differ from the preview's Markdown
  parser in rare cases.
- **Typing with the Hebrew layout** works in the source editor. In WYSIWYG,
  the formula editor does not translate keys.
