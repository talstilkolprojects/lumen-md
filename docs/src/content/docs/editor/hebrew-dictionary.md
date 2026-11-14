---
title: Hebrew dictionary and synonyms
description: Definitions, synonyms and the niqqud of a word, from Hebrew Wiktionary, offline inside the editor.
---

Right-click a Hebrew word in the editor to see its **synonyms**, its **definition** or its
**niqqud**. Everything is looked up on this device, from a dictionary pack you download once.

## Get the dictionary

Command palette (**⌘K / Ctrl+K**) → **Hebrew dictionary and synonyms (download / remove)**.
Lumen shows the pack's size, its number of entries and its licence, and downloads it only
after you agree. The pack comes from Lumen's own site and is checked against its published
size and checksum. It is kept in the browser's storage, so it works offline. Run the same
command again to remove it.

## Use it

- **Right-click** a Hebrew word: **Synonyms**, **Definition**, **Niqqud of the word**.
  **Shift+right-click** opens the browser's own menu (copy, paste, spelling).
- Or put the cursor on the word and run **Look up the Hebrew word at the cursor**.
- Prefix letters are understood: **ובבית** finds **בית**. A synonym you click replaces the
  word and keeps its prefix (**ובבית** → **ובדירה**). The pointed form replaces the word the
  same way; the prefix letters stay unpointed.
- Text with niqqud is looked up without it.
- Synonyms go both ways: if one entry lists another word as a synonym, that word shows the
  first one too.

Nothing changes in the note until you pick a word, and then only that word, if it is
still there.

## Where the words come from

The pack is built from the **Hebrew Wiktionary** (he.wiktionary.org), whose text is licensed
**CC BY-SA 4.0**. For each entry it keeps the pointed headword, the part of speech, up to
four definitions (shortened, without examples) and the synonyms section. The credit is in
**Credits** (command palette) and in the dictionary window, and the pack ships with its
licence (`public/lexicon/LICENSE.md`).

**Why Wiktionary, not Hspell:** Hspell's word lists are AGPL-3.0, which cannot ship inside
Lumen (MIT). Lumen's spelling checker still offers Hspell as a separate download from its
upstream. Wiktionary's CC BY-SA licence applies to the pack, which is a separate file, not
to Lumen's code.

## Build the pack (maintainers)

```bash
curl -LO https://dumps.wikimedia.org/hewiktionary/latest/hewiktionary-latest-pages-articles.xml.bz2
npm run lexicon:build -- hewiktionary-latest-pages-articles.xml.bz2 20261101
```

This writes `public/lexicon/he-wiktionary.json` and `public/lexicon/manifest.json` (size,
sha256, entry count). Commit both; the app offers the download once the manifest exists.
The plan asks for at least 20,000 entries and a lookup of 20 ms or less. The lookup is a
hash lookup plus at most three prefix letters peeled; a test checks 2,000 lookups in a
25,000-entry pack, each under 20 ms.
