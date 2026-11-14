---
title: עוזבים את Evernote או Notion?
description: איך מוציאים את הפתקים מ-Evernote, ‏Notion, ‏Apple Notes, ‏Google Keep, ‏OneNote או Obsidian, ומכניסים אותם ל-Lumen בצעד אחד, עם לחיצה אחת לביטול.
---

Lumen שומר את הפתקים שלך כקובצי Markdown פשוטים במכשיר שלך. כדי להביא
אותם מאפליקציה אחרת צריך שני צעדים: לייצא מהאפליקציה ההיא, ולבחור את
הייצוא ב-Lumen. הייבוא נכנס לתיקייה חדשה, `Imported/<name>`. שום דבר שכבר
יש לך לא משתנה, ו**ביטול** מחזיר את כל הייבוא.

**[לפתוח את אשף הייבוא ב-Lumen](https://lumen-md.vercel.app/?import=evernote)**.
בביקור ראשון, הצעד האחרון בהגדרה מציע במקום זה **הביאו את הפתקים שלכם**.

כל סעיף כאן מתאר את הייצוא של האפליקציה האחרת כמו שדף העזרה שלה מתאר
אותו, ומקשר אליו. אם הצעדים שם השתנו, עדיף ללכת לפיהם.

## Evernote

1. פותחים את **אפליקציית שולחן העבודה** של Evernote ל-Mac או ל-Windows. מ-Evernote Web אי אפשר לייצא.
2. בוחרים מחברת, או עד 100 פתקים, ואז קליק ימני ← **Export…** ← **ENEX**.
3. ב-Lumen בוחרים **Evernote** ואת קובצי ה-`.enex`. כל מחברת הופכת לתיקייה.

מקור: [העזרה של Evernote, ‏"Export notes and notebooks as ENEX or HTML"](https://help.evernote.com/hc/articles/209005557).

<!-- screenshot: leaving/evernote-export.png (W10.M9) -->

עוד פרטים: [מעבר מ-Evernote](/he/getting-started/from-evernote/).

## Notion

1. ב-Notion מייצאים את סביבת העבודה או עמוד בפורמט **Markdown & CSV**, כולל עמודי משנה.
2. ב-Lumen בוחרים **Notion** ואת קובץ ה-`.zip` כמו שהגיע. כל מסד נתונים הופך לקובץ `.base` עם אותן עמודות.

מקור: [העזרה של Notion, ‏"Export your content"](https://www.notion.com/help/export-your-content).

<!-- screenshot: leaving/notion-export.png (W10.M9) -->

עוד פרטים: [מעבר מ-Notion](/he/getting-started/from-notion/).

## Apple Notes

1. ב-Notes ב-Mac בוחרים פתק, ואז **File ← Export To** ← **Markdown** (או PDF). המדריך של Apple מתאר פתק אחד בכל פעם.
2. שמים את הקבצים שיוצאו בתיקייה אחת. ב-Lumen בוחרים **Apple Notes** ואת התיקייה, או קובץ `.zip` שלה.

מקור: [Apple, ‏"Import, export and print notes on Mac"](https://support.apple.com/guide/notes/not201900c07/mac).

<!-- screenshot: leaving/apple-notes-export.png (W10.M9) -->

## Google Keep

1. ב-Google Takeout בוחרים רק את **Keep** ומורידים את קובץ ה-`.zip`.
2. ב-Lumen בוחרים **Google Keep** ואת ה-`.zip` כמו שהגיע. תוויות הופכות לתגיות, ופתקים בארכיון עוברים ל-`Archive/`.

מקור: [העזרה של חשבון Google, ‏"How to download your Google data"](https://support.google.com/accounts/answer/3024190).

<!-- screenshot: leaving/keep-takeout.png (W10.M9) -->

## OneNote

1. ב-OneNote: ‏**File ← Export** ← *Export current:* ‏**Page** או **Section**, ואז בוחרים פורמט.
2. ‏Lumen קורא עמודים שנשמרו כ-**Single File Web Page (`.mht`)**. ב-Lumen בוחרים **OneNote** ואת קובצי ה-`.mht`.

מקור: [התמיכה של Microsoft, ‏"Export a copy of a page, section or notebook"](https://support.microsoft.com/en-au/office/export-a-copy-of-a-page-section-or-notebook-0958461c-fc32-4659-9341-707d5a457e09). אילו פורמטים מוצעים תלוי בגרסת OneNote שלך. הדף לא מזכיר `.mht`, אז כדאי לבדוק את רשימת הפורמטים אצלך.

<!-- screenshot: leaving/onenote-export.png (W10.M9) -->

## Obsidian

כספת Obsidian היא כבר תיקייה של קובצי Markdown, אז אין מה לייצא:

- **פתיחת תיקיית Obsidian** בהגדרה משתמשת בכספת במקום שבו היא נמצאת, בלי להעתיק כלום.
- או מייבאים עותק: בוחרים **Obsidian** ואת התיקייה או קובץ `.zip` שלה.

עוד פרטים: [מעבר מ-Obsidian](/he/getting-started/from-obsidian/).

## אחרי הייבוא

האשף מראה מה נכנס, מה לא ולמה. הוא גם מציע חיפוש בפתקים שזה עתה יובאו,
ו**ביטול**. הרשימה המלאה של מה שכל ממיר שומר ומדלג עליו נמצאת ב[ייצוא
וייבוא](/he/workspace/export-import/).
