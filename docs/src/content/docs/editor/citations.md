---
title: Citations with [@key]
description: Cite from your BibTeX, CSL-JSON or Zotero library with pandoc's [@key, p. 10], in APA, Chicago, MLA or the Israeli APA, with a reference list in the preview, DOCX and PDF.
---

## Cite in two keystrokes

Press `⌥⌘C` (or `⌘K → "Insert a citation [@key]…"`) to open the cite
dialog. It searches your whole library at once.

- With nothing typed, the sources you cited last come first: **Enter**
  cites the last one again, and **↓ Enter** the one before it.
- Type to search by author, title, year or key. Hebrew works.
- **Tab** goes to the locator field (`p. 10`, `chap. 3`, `עמ׳ 12`).
- **Enter** writes `[@key]`. **⇧Enter** writes `@key`, for a citation
  inside the sentence.

## Your library

The library is everything in the vault, read on this device:

- **BibTeX**: any `*.bib` file.
- **CSL-JSON**: `*.csl.json`, `references.json` or `bibliography.json`
  (Zotero, Zettlr and pandoc all export this format).
- **Zotero**: in the desktop app, run `⌘K → "Citations: copy the Zotero
  library into the vault"`, or press **Copy from Zotero** in the dialog.
  This copies Zotero 7's library from this computer into
  `.lumen/zotero-library.csl.json` (first turn on Settings → Advanced →
  "Allow other applications on this computer to communicate with Zotero").

Keys come from the source: the BibTeX key, CSL's `citation-key`, or a
`Citation Key:` line from Better BibTeX. Otherwise the key is the author's
family name and the year (`austen1813`, `כהן2020`).

## Zotero without the desktop app

On the web and on phones, **⌘K → Citations: sync the Zotero library from
zotero.org (read-only)** reads your library from Zotero's Web API. Zotero
Desktop doesn't need to be open.

1. On zotero.org, open **Settings → Security → Applications** and create a
   key with **read-only** access to your library.
2. Run the command and paste the key. It is kept in this device's secret
   store and sent only to `api.zotero.org`, as the `Zotero-API-Key` header.
   Every request shows in the privacy ledger as a cloud route. A
   **local-only** AI and privacy policy blocks it.
3. Your sources join the cite dialog, the same as the desktop copy. Items
   with notes or PDFs also get a note in `Zotero/`, headed with their
   `[@key]`. The note holds the Zotero notes as Markdown, a link that opens
   each PDF in Zotero, and a link to it on zotero.org.

The next sync asks only for what changed since the last one. If nothing
changed, Zotero answers with one empty response (`304`). Otherwise Lumen
fetches the changed items, up to 50 per request, and drops the deleted ones.
Lumen never writes to Zotero. If Zotero asks the app to slow down
(`Backoff`, `429`), Lumen waits.

## Pandoc syntax

| You write | APA 7 shows |
|---|---|
| `[@austen1813]` | (Austen, 1813) |
| `[@austen1813, p. 10]` | (Austen, 1813, p. 10) |
| `[see @austen1813, pp. 10–12; @darwin1859]` | (see Austen, 1813, pp. 10–12; Darwin, 1859) |
| `[-@austen1813]` | (1813) |
| `@austen1813 [p. 10] writes` | Austen (1813, p. 10) writes |

Locators can be pages, chapters, sections, figures, volumes, paragraphs,
notes or lines, in English or Hebrew. Chicago writes the page bare
(`(Austen 1813, 10)`), and so does MLA (`(Austen 10)`).

A key the library doesn't know stays as you wrote it.

## Styles

Set the style in the note's frontmatter:

```yaml
---
citation-style: il      # apa (default), chicago, mla, il
---
```

- **APA 7**, **Chicago author-date** and **MLA 9** use the 6.13 templates,
  in the note's language (Hebrew notes get ו, ואחרים, עמ׳).
- **il** is APA 7 the way Israeli academic libraries teach it:
  - Hebrew sources come first, in their own list, then the rest.
  - Each source is written in its own language.
  - Hebrew initials take a geresh: `דרשן, ד׳`.
  - The same author and year are told apart by א / ב (a / b for other
    languages).

The reference list goes where the note has pandoc's `::: {#refs}` block,
or at the end of the note. It appears in the preview, when you print to
PDF and in **Export to Word**.

All formatting is the app's own, with no citeproc and nothing fetched.
