---
title: Academic LaTeX export (Hebrew)
description: Export a note as a LaTeX project — Hebrew right to left with babel, math, Pandoc-style [@key] citations from the vault's BibTeX, and images — that compiles with LuaLaTeX or XeLaTeX.
---

**Export LaTeX project (academic, Hebrew)…** in the command palette
downloads `<note>-latex.zip` with:

- `main.tex` — the note as an `article`: `#` becomes the title (or
  `title:` from the frontmatter), `##` sections, lists, quotes, tables,
  footnotes, code (left to right, verbatim), inline `$…$` and display
  `$$…$$` math as written;
- the reference list, in APA (the same formatter as Lumen's citations),
  each entry in its own language and direction;
- `references.bib` — the cited entries from every `.bib` in the vault, for
  a bibtex or biblatex style of your own;
- `images/` — the images the note shows;
- `README.txt` with the compile command.

Compile with `latexmk -lualatex main.tex` (recommended) or
`latexmk -xelatex main.tex`. Both work from the same preamble.

## Hebrew

The preamble uses **babel** with `\babelprovide[import, main]{hebrew}`
— `bidi=basic` under LuaLaTeX, which babel's maintainers recommend for
right-to-left text, and `bidi=default` under XeLaTeX. Polyglossia was not
chosen: under XeLaTeX it needs the separate `bidi` package, and babel
covers both engines with one preamble.

In a Hebrew paper every run of Latin text (a term, a name, `1–20` page
ranges, an e-mail) is wrapped in `\foreignlanguage{english}{…}`, so it
reads left to right with the right font and hyphenation; in an English
paper Hebrew runs get `\foreignlanguage{hebrew}{…}`. Math and code are
always left to right. The paper's language is decided by its letters.

Fonts: Frank Ruhl Libre or David Libre (SIL Open Font Licence, free from
Google Fonts) when installed, else Noto Serif Hebrew or FreeSerif; Latin
Modern for English.

## Citations

Pandoc's syntax, as in Lumen's citation dialog:

| In the note | In main.tex |
|---|---|
| `[@cohen2020]` | `\citep{cohen2020}` |
| `[see @knuth1984, p. 33]` | `\citep[see][p.~33]{knuth1984}` |
| `[@a; @b]` | `\citep{a,b}` |
| `@cohen2020 showed` | `\citet{cohen2020} showed` |

Only keys found in a `.bib` in the vault become citations (so an e-mail
address stays text); the toast lists cited keys that are missing.

## How it was checked

`src/__tests__/latexAcademic.test.ts` turns ten golden notes in
`src/__tests__/fixtures/latex/` (Hebrew, English, mixed runs, inline and
display math, citations, lists and quotes, a table, footnotes and links,
code and special characters, an English paper with Hebrew) into exactly the
`.tex` beside each. All ten compiled with XeLaTeX (TeX Live 2023) with no
errors and no missing characters; the PDFs read right to left.
