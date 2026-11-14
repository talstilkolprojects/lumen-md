---
name: lumen-niqqud
description: Handle Hebrew niqqud (vowel points) and cantillation in Lumen notes correctly when reading, searching, comparing, quoting or editing Hebrew text. Use when Hebrew text has or needs niqqud, or when matching Hebrew with and without vowels.
license: MIT
---

# Niqqud in Lumen

Niqqud are Unicode combining marks (U+05B0–U+05BD, U+05BF, U+05C1–U+05C2, U+05C4–U+05C5, U+05C7);
cantillation marks are U+0591–U+05AF. Lumen stores them as typed and never strips them from a note.

1. **Do not add or remove niqqud** in a note unless asked. A quotation keeps the niqqud of its source.
2. **Comparing and searching:** remove the marks from both sides first (and normalise to NFC), so
   `שָׁלוֹם` matches `שלום`. Lumen's search does this already.
3. **Full and defective spelling** (כתיב מלא/חסר) are different strings: `צריך` vs `צרך` are not the same word. Treat a
   ו or י difference as a possible spelling variant, not an error.
4. **Adding niqqud** when asked: vocalise whole words; never leave half a word pointed. Mark uncertain words
   for the user instead of guessing.
5. Keep the marks in the order Unicode NFC gives; do not insert spaces or ZWJ between a letter and its marks.
