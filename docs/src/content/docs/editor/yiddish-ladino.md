---
title: Yiddish and Ladino
description: Write Yiddish in YIVO spelling and Ladino in Latin or Hebrew letters — language tags, direction, spelling, and transliteration both ways, on this device.
---

Lumen knows two more Jewish languages besides Hebrew: **Yiddish** and **Ladino**
(Judeo-Spanish).

## Tag a note's language

Put `lang:` in the note's front matter:

```yaml
---
lang: yi        # Yiddish
---
```

| Tag | Language | Direction |
|---|---|---|
| `yi` | Yiddish | right to left |
| `lad-Latn` | Ladino in Latin letters (Aki Yerushalayim spelling) | left to right |
| `lad-Hebr` | Ladino in Hebrew letters | right to left |
| `lad` | Ladino: Lumen picks `lad-Latn` or `lad-Hebr` from the note's letters | |

A note in Yiddish spelling (אַ, אָ, ע as a vowel) is recognised as Yiddish even
without the tag. The tag goes on the editor, the preview and the HTML export
(`<html lang="yi">`), so screen readers, hyphenation and fonts follow it.

Each paragraph still takes the direction of its own text, as in every note. An
English line in a Yiddish note reads left to right.

Yiddish and Hebrew-letter Ladino use a Hebrew face with full pointing (Noto
Sans Hebrew). It ships with Lumen and loads only for such notes.

## Yiddish spelling

Command palette → **Yiddish spelling: word list (download / remove)**.

The word list is
[hunspell-yi](https://github.com/alephreish/hunspell-yi), by Raphael A.
Finkel, Simche Taub and Andrey Rozenberg. It is 2.4 MB and licensed under
GPL-3.0. Because of that licence it is **not part of Lumen**:
- Lumen downloads it only when you run the command, from a fixed version.
- It checks the file's SHA-256 against the expected value.
- It keeps the list on this device only.

With the list installed, every Yiddish paragraph is checked against it, on this
device, and Hebrew paragraphs keep the Hebrew checker. The list writes YIVO
without its two optional points (פ for פֿ, יי for ייִ). Lumen accepts both, and
shows each suggestion as YIVO writes it.

## Transliterate

Select text, then Command palette → **Transliterate the selection (Yiddish,
Ladino)**. Choose one of:

- **Yiddish → YIVO romanisation**: `ייִדיש איז אַ שפּראַך` → `yidish iz a shprakh`.
- **YIVO romanisation → Yiddish**: puts a shtumer alef before an initial vowel,
  final letters at the end, and וּ next to a vov. Common words of Hebrew origin
  keep their Hebrew spelling: `shabes` → שבת, `mishpokhe` → משפּחה.
- **Ladino: Latin → Hebrew letters**, by the Aki Yerushalayim spelling:
  `djudio` → ג׳ודיו, `mujer` → מוז׳יר.
- **Ladino: Hebrew → Latin letters**. In Hebrew letters, י can be *e* or *i*
  and ו can be *o* or *u*, so Lumen says how many vowels it had to guess. Check
  them.

All of this runs on this device. The rules are Lumen's own (MIT).
