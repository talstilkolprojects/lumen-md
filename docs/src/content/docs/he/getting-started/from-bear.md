---
title: מעבר מ-Bear
description: מייצאים פתקי Bear כ-Markdown ומביאים אותם, עם התמונות, ל-Lumen.
---

## ייצוא מ-Bear

1. בוחרים את הפתקים (או **⌘A** בתוך תגית).
2. **File ← Export Notes…**, פורמט **Markdown**, עם **Export attachments**.
   ‏Bear כותבת קובץ `.md` לכל פתק ותיקיית תמונות לידו.

## מביאים ל-Lumen

מכווצים את תיקיית הייצוא ל-zip, או משאירים אותה כתיקייה, ואז
`⌘K → Import notes from another app (Obsidian, Notion, Evernote, Bear, Keep, Logseq, OneNote…)…`. הפתקים והתמונות
נכנסים לתיקייה חדשה, `Imported/<שם>`, והקישורים לתמונות נשארים תקינים.

## מה משתנה

| ב-Bear | ב-Lumen |
|---|---|
| ‏`#tags` ו-`#nested/tags` | אותן תגיות בטקסט; חלונית התגיות מציגה אותן |
| ‏`#multi word tags#` | כותבים `#multi-word-tags` (תגיות ב-Lumen בלי רווחים) |
| ‏`::highlight::` | נשאר כטקסט; ב-Markdown אין הדגשה (השתמשו ב-**מודגש**, או ב-`{==highlight==}` במצב הצעות) |
| ‏`[[note links]]` | אותו תחביר |
| סנכרון בין מכשירים | סנכרון iCloud של Bear לא מגיע ל-Lumen; השתמשו ב-Git או בתיקייה משותפת |
