---
title: Markdown fidelity
description: How closely Lumen follows the CommonMark and GFM specs, and the promise that opening and saving a file in either editor gives you back the same bytes.
---

A Markdown editor should never rewrite your files behind your back. Lumen is
tested against the official specs, and against its own round trip: open a
file, save it, and get exactly the bytes you started with.

## Spec conformance

Lumen's parser is tested against the official spec examples, which are kept
in the repository unmodified:

| Suite | Examples | Gate |
|---|---|---|
| CommonMark 0.31.2 | 652 | at least 99% |
| GitHub Flavored Markdown 0.29 | 670 (2 disabled upstream) | at least 98% |

The CommonMark parser underneath (micromark) passes every CommonMark example
on its own. What Lumen adds on top changes a handful of results on purpose:

| Where Lumen differs | Why |
|---|---|
| A leading `---` block is frontmatter | It holds the note's metadata (title, tags). The spec reads it as a thematic break and text. |
| A bare URL or email address becomes a link | GFM autolink literals are always on, including in examples that test plain CommonMark. |
| `ftp://` addresses are not linked automatically | Matches github.com today. Write `<ftp://…>` to link one. |
| Disallowed raw HTML (`<script>`, `<title>`, …) is not filtered by the parser | The preview sanitizes all raw HTML afterwards, which removes these tags. |
| A single line break inside a paragraph shows as a line break | The preview's soft-break setting. It is not part of the gated score. |

The GFM spec is pinned to CommonMark 0.29. Where CommonMark 0.31.2 changed the
expected result for the same input (mostly the emphasis rules), Lumen follows
the newer spec, and those examples are left out of the GFM score.

Any other failing example fails the suite, so every difference has to be
explained here.

## Round trip

Both editors are tested on more than 200 real Markdown files: everything in
the repository, Hebrew documentation included, and every section of the two
spec files. A CRLF copy of every tenth file is added on top.

- **Source editor:** open and save is byte-identical for every file. A file
  with Windows (CRLF) line endings stays CRLF. One with old Mac (CR) endings
  stays CR. In a file with mixed endings, the stray carriage returns stay
  where they are, shown as a special-character mark.
- **WYSIWYG:** unedited blocks are saved exactly as the file had them. An edit
  rewrites only the block you changed, such as the paragraph, list or table
  you typed in. Everything else keeps its own style: `*` or `-` bullets,
  `__bold__` or `**bold**`, table padding and blank lines. Blocks that WYSIWYG
  does not display, such as link reference definitions, are kept in place. A
  CRLF file gets CRLF in the blocks you add.

## Checking it yourself

```sh
npm run md:conformance
```

This runs the conformance suite, the round trip through both editors, and
the unit tests for the source-preserving save. The full results, with every
failing example and a per-file diff of the WYSIWYG serialization, are written
to `test-results/md-conformance/` and `test-results/md-roundtrip/`.

The spec files are © John MacFarlane and GitHub, Inc., under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Their
source and commit are recorded in `src/__tests__/fixtures/md-spec/README.md`.
