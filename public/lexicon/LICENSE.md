# public/lexicon/

**he-wiktionary.json** — Lumen's offline Hebrew dictionary and synonyms (plan W5.26), built by
`scripts/build-hebrew-lexicon.mjs` from a Hebrew Wiktionary dump
(<https://dumps.wikimedia.org/hewiktionary/>; the dump's name is in the pack's `source` field and in
`manifest.json`).

Content: the work of the Hebrew Wiktionary (he.wiktionary.org) contributors, licensed
**Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)**,
<https://creativecommons.org/licenses/by-sa/4.0/>.

Changes made: only the main namespace's Hebrew entries are kept; per entry, the pointed headword, the
part of speech, up to four definitions (shortened to 280 characters, wiki markup and examples
removed) and the synonyms (נרדפות) section's links.

The pack is a separate file that Lumen downloads only when the person asks for it; ShareAlike applies
to this pack and to adaptations of it, not to the app's code (MIT). If you redistribute it or an
adaptation of it, keep this attribution and share it under CC BY-SA 4.0.
