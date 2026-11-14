---
title: Very large vaults
description: How Lumen stays fast with 100,000 notes. The search index holds one copy of the text, is kept between sessions, and is updated one note at a time, and big embedding indexes are stored compactly.
---

This page picks up where [Large vaults and long notes](/workspace/large-vaults/) leaves off. Heavy users reach 50,000 to 100,000 notes, which is where most note apps
slow down. Lumen is measured against a synthetic vault of 100,000 notes:
190 million characters, two thirds of them Hebrew, all with wiki links.

| Measured (100,000 notes) | Limit | Result |
|---|---|---|
| Search: a word, Hebrew with prefixes, a phrase, or a miss | < 200 ms | 73–148 ms |
| Save → in the index | < 50 ms | 9 ms |
| Memory of the search index | < 1.5 GB | 757 MB (it was 4.3 GB) |
| Memory of the notes on the app's main thread | | 67 MB (it was 364 MB) |
| Building the index from scratch, in the background worker | | 7 s (it was 29 s) |

## What makes it fast

- **One copy of the text.** Each note's search text (lower-cased, and for
  Hebrew folded for niqqud, final letters and prefixes) is stored once, in
  chunks of 256 notes, not two or three times per note. A query is one scan
  per chunk.
- **The text lives only in the index.** The app's main thread keeps a small
  summary of each note: its links, tags, frontmatter and length. The graph and
  the tags view read that summary, and renames happen inside the index.
- **Saving touches one chunk.** Saving a note rebuilds only its chunk's search
  text.
- **The index survives a restart.** After changes, the notes the index holds
  are saved in the browser's database while it is idle, with each note's
  modification time. The next time the app opens, the index opens from there
  right away, and Lumen checks the vault's files behind it: a note changed,
  added or deleted while the app was closed is read again or dropped, like
  any other change. A note's saved text is used only when both its
  modification time and its size still match the file; a saved index from an
  older version of Lumen, which has no sizes, is not used, and its notes are
  read once. Two edits that leave both the time and the size the same can't be
  told apart. Each vault gets a random id of its own, kept in
  `.lumen/vault-id`, so two folders never share a saved index. Search, backlinks, the tags panel,
  the graph, link completion and the other views wait for that check, so
  what they first show is already up to date. If that check is slow, a view
  that lists notes doesn't wait for it: it shows them once the check is done; if the
  vault can't be listed at all within a minute, the saved index is set aside
  and the notes are read from the vault. If the saved index is
  missing or out of date, Lumen just builds it in full. In an [encrypted vault](/security/vault-encryption/)
  the saved index is encrypted and signed inside the worker, and a copy that
  was changed is refused, so an encrypted vault no longer reads and decrypts
  every note when it opens.
- **All of this runs off the main thread.** The index lives in a worker, so
  opening the app and typing are never blocked by it. The file tree shows a
  limited number of rows per folder.
- **Compact embeddings.** When the semantic index holds more than 50,000
  passages, their vectors are kept in memory as 8-bit integers. That is a
  quarter of the memory, with scores within 1% of the full-precision ones.
  Vectors are unpacked one note at a time, when a search needs them.

## Measuring it yourself

```sh
npm run perf:vault100k                  # 100,000 notes, fails if a limit is broken
npm run perf:vault100k -- --soak 1440   # 24 hours of random edits, deletes and searches
```
