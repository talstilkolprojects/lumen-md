---
title: Jewish sources from Sefaria
description: Quote a verse, a mishnah or a Talmud folio by its reference, with each text's licence. Keep a copy for offline use, and see every note that cites the same verse.
---

Type a reference the way you write it, such as `בראשית א:א`, `ב״ר א, א`,
`שמות כ׳ ג׳`, `Gen. 1:1-3` or `ברכות ב.`. Lumen brings the text from
[Sefaria](https://www.sefaria.org), the open library of Jewish texts, with
its niqqud and cantillation as they are.

## Quote a source

1. Select the reference in the source editor, or put the cursor on its line.
2. Open the command palette (⌘K) and run **Insert a source from Sefaria…**.
   With nothing selected, Lumen asks for the reference.
3. **Confirm the lookup.** The question says exactly what is sent: only the
   reference (for example `Genesis 1:1`), nothing from your notes.

The quote replaces the reference:

```markdown
> **[[Genesis.1.1|בראשית א׳:א׳]]**
>
> בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים …
>
> — [Sefaria](https://www.sefaria.org/Genesis.1.1) · עברית: Miqra according to the Masorah ([CC-BY-SA](https://creativecommons.org/licenses/by-sa/3.0/)) · English: … (CC-BY-NC) — link only
```

Every version's title and licence are written next to it. The link
`[[Genesis.1.1|…]]` makes the verse a node in the graph.

## Licences: what is copied and what is only linked

Sefaria gives each version of a text, in each language, its own licence.
Lumen reads that licence from Sefaria's own data and follows it:

| Licence | In your note | In the offline copy |
| --- | --- | --- |
| Public Domain, CC0 | the text | the text |
| CC-BY, CC-BY-SA | the text, with its credit and licence | the text, with its credit and licence |
| CC-BY-NC, CC-BY-NC-SA, CC-BY-NC-ND | a link only | not stored |
| Copyright, or no licence noted | a link only | not stored |

**Non-commercial licences count as not free.** A note travels: it syncs,
gets published and gets exported, and Lumen cannot know what it will be used
for. **"No licence noted" means Sefaria has not checked the copyright yet.**
A non-free text is dropped as soon as Sefaria's answer is read. It never
reaches a note, the vault or a cache.

## Keep a copy for offline use

Saving is your choice and never automatic. Use the **Save for offline**
button on the message after a quote, or run **Save this source for offline**.
The copy goes to `Sources/Sefaria/<Book.chapter.verse>.md`:

- **its frontmatter** records every version's title, licence, licence link and
  source, and whether it was copied;
- **its body** holds the free texts only.

Once a source is saved, quoting it again uses the copy: no request, no
question, and it works with no network at all.

## My notes on this verse

Put the cursor on a reference, or open a saved source note, and run **My notes
on this verse**. Lumen lists every note that cites the verse, through a wiki
link (`[[בראשית א:א]]`, `[[Genesis.1.1]]`) or a Sefaria link. The search
reads your vault on this device and sends nothing.

## Privacy

A lookup sends only the reference to `www.sefaria.org`. The privacy ledger
lists each lookup as a consented request, and the cloud-routes table lists it
as `sefaria-texts`. The *local only* policy doesn't block a lookup you
confirmed, the same way it treats a diagram you chose to send.

## What is recognised

- **Books:**
  - the Tanakh, with Hebrew and English names and the usual abbreviations
    (`בר׳`, `ש״א`, `Gen.`, `1 Sam`);
  - Midrash Rabbah (`ב״ר`, `שמו״ר` …);
  - the Mishnah (`משנה ברכות א:א`, `אבות א:א`);
  - the Babylonian Talmud (`ברכות ב.`, `ב״מ נט:`, `Berakhot 2a`).
- **Numbers** can be Hebrew numerals, with or without geresh or gershayim
  (`קי״ט`, `טו`), or digits. A range is written `א:א-ג`.
- **Not supported yet:** commentaries (`רש״י על בראשית א:א`), the Jerusalem
  Talmud, halakhic codes, and ranges that cross chapters.

## About Sefaria

Lumen uses Sefaria's public texts API, which needs no key. "Sefaria" is a
trademark of Sefaria; Lumen is not made or endorsed by Sefaria.
