---
title: "Journalist mode: redaction and locked notes"
description: Text you redact is removed from every export, not covered. A note can be locked with a password of its own.
---

Reporters, lawyers and researchers keep notes about people who must not be
named. Lumen has two tools for that, on top of [photo metadata
removal](/security/photo-metadata/).

## True redaction

Select the text and run **Redact selection** from the command palette. The
text is wrapped in `<redact>…</redact>`: you still see it in your note,
shaded, and it is **removed** from every export — PDF, print, DOCX, HTML,
Markdown, RTF, LaTeX, EPUB, slides and the rest. In its place the export has
`█████`, always five blocks, so the length of a name gives nothing away.

This is not a black box drawn over text that is still there (a well-known
leak in PDFs: copy the box, or run `pdftotext`, and the text comes back).
The exporters never receive the text at all.

The rules fail closed:

- A `<redact>` that is never closed removes everything after it, and every
  footnote too: the preview shows the footnotes at the end of the note, so they
  are shaded with the rest.
- A mark with attributes or a slash (`<redact class="x">`, `<redact/>`) is a
  mark too, exactly as the preview reads it, so what you see shaded is what
  goes.
- **Redact selection** over text that already has marks makes one mark over
  the whole selection; nothing that was covered before is uncovered.
- Photos inlined as `data:` URLs are judged by their bytes, whatever their
  label, and so are photos embedded in an SVG: a JPEG, PNG or WebP loses its
  metadata, and one that can't be cleaned (HEIC, AVIF) is left out.
- Marks count inside code blocks too.
- A `</redact>` that the preview doesn't read as one (in code, in a link's
  address, in a comment, or while a paragraph or table opened inside the
  passage is still open) doesn't end the passage. Everything the preview
  shades is gone from the export, and sometimes a little more. A suggestion
  (`{>>comment<<}`, `{~~old~>new~~}`) is read the way the preview reads it,
  so its `>` doesn't end a tag that the preview keeps open.
- The same goes for Markdown structure. A `<redact>` on a line of its own
  shades the blocks after it, and a `</redact>` typed inside one of them (a
  list item, a quote, a table cell, a heading or a paragraph) doesn't end the
  passage. To end it, put the `</redact>` on a line of its own, after a blank
  line:

  ```markdown
  <redact>

  - Source A
  - Source B

  </redact>
  ```
- Exports also leave out hidden text a reader of the file could find: HTML
  comments (`<!-- … -->`) and Obsidian comments (`%% … %%`).
- **Print** (⌘P) of a note with redactions goes through the same export.
- **Publish site** (GitHub Pages or a .zip) and the command line (`lumen publish`,
  `lumen convert`) go through it too: the pages, their titles and the site's search
  index never hold a redacted passage, and the photos they copy lose their metadata.

What it does not do: the note itself keeps the text (that is the point), so
syncing or sharing the *note* shares the text. Redact before you export, and
share the export.

## A note with its own password

Run **Note password…** on a note saved in the vault. The note is encrypted
with a password of its own, separate from the vault's: on disk, in sync and
in backups it is ciphertext, with one line saying how to open it.

- **Opening:** open the note, run **Note password…**, type the password. It
  stays open until you choose **Lock now** or close Lumen; the password is
  never stored.
- **While it is open,** what Lumen keeps on the device (the open tabs, the
  version history) keeps the encrypted text, not the plain one. Locking a
  note deletes its earlier, plain versions from history.
- **Forgotten password = lost note.** There is no recovery key, by design.
- **While it is locked,** nothing replaces the note but its own encrypted
  text, byte for byte: plain text from a tool or an old tab is refused, and
  so is any other encrypted text, even one that copies the note's salt.
- The key comes from the password through the vault's key-derivation
  function (PBKDF2-SHA256, 600,000 iterations today; Argon2id once it lands),
  and every save is sealed with AES-256-GCM under a fresh nonce.

Limits, plainly: the note's *name* is not hidden; "Save as" makes a plain
copy; anything you copy out of an open note is plain text; and a device
that is compromised while the note is open can read it.
