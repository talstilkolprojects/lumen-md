---
title: Ben-Yehuda library (offline)
description: Download the public-domain works of Project Ben-Yehuda once, then search, read, quote and highlight Hebrew literature with no network.
---

[Project Ben-Yehuda](https://benyehuda.org) is a volunteer library of Hebrew
literature. Its works that are in the **public domain** are published as a
dump that anyone may use, with no permission needed. Lumen uses that dump
only: works the site publishes with their authors' permission are not in
it, so they never reach your device.

## Download

1. Choose **Download the Ben-Yehuda library…** in the command palette.
   The library starts off, so Lumen asks to turn it on first.
2. Confirm the download. Lumen fetches the dump's catalogue from GitHub.
3. Pick an author. Lumen downloads that author's works, four at a time.

Each work becomes a note in `Sources/BenYehuda/<author>/`, with its title,
author, link, the date you downloaded it and `rights: public-domain` in the
frontmatter. Run the command again for more authors.

After that, nothing goes over the network: search and reading are local.

## Search

**Search the Ben-Yehuda library…** looks for authors, titles and words of
the downloaded texts. Hebrew prefixes, full and defective spelling and
niqqud don't matter: `ביאליק בריכה` finds `הַבְּרֵכָה`. A work whose text
you have not downloaded yet is marked "not downloaded".

## Quote and highlight

Open a work, select a passage, and choose:

- **Copy as a quote (Ben-Yehuda)**: a quote with the author, the work, a link
  to it on the project's site and the mark "public domain". Paste it into
  any note.
- **Highlight this passage (Ben-Yehuda)**: the passage goes to the
  highlights hub (`Highlights/`).

## Credit

The works are free to use. The project asks, if you would like to give
credit, for "Project Ben-Yehuda volunteers" and a link to the site. Lumen's
quotes include both.
