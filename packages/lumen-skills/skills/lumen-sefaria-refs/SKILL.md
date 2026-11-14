---
name: lumen-sefaria-refs
description: Write and recognise references to Jewish sources the way Lumen links them to Sefaria (Hebrew and English forms), and the source notes Lumen keeps. Use when a note cites Tanakh, Mishnah, Talmud or other Jewish texts.
license: MIT
---

# Jewish-source references in Lumen

Lumen recognises references as people write them and links them to Sefaria:

| Form | Example |
| --- | --- |
| Hebrew, colon | `בראשית א:א`, `שמות כ:ב-ג` |
| Hebrew, comma | `ב״ר א, א` |
| Hebrew, geresh | `שמות כ׳ ג׳` |
| English | `Gen. 1:1-3`, `Genesis 1:1` |
| Talmud folio | `ברכות ב.`, `Berakhot 2a` |
| Wiki link | `[[בראשית א:א]]`, `[[Genesis.1.1]]` |

1. A wiki link `[[Genesis.1.1]]` makes the verse a node in the graph; use it when the note discusses the verse.
2. Offline copies live at `Sources/Sefaria/<Book.chapter.verse>.md`. Do not edit them by hand.
3. **Licences:** only Public Domain, CC0, CC-BY and CC-BY-SA texts may be copied into a note, with their credit.
   For CC-BY-NC* or copyrighted versions, write the reference and a link only.
4. Quote word for word, keeping niqqud and punctuation as in the source (see `lumen-niqqud`).
