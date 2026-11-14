---
title: ייצוא וייבוא
description: להוציא את כל הכספת כ-.zip או כתיקייה, להכניס כספת Obsidian או ייצוא של Notion, ולהמיר קבצים בודדים מפורמטים רבים ואליהם.
---

הפתקים שלכם הם Markdown רגיל, ותמיד אפשר להוציא אותם מ-Lumen.

## כל הכספת

**ייצוא:** `⌘K → Export the whole vault…`. בוחרים הורדת **‎.zip** או, בדפדפן
שיודע לכתוב לתיקיות (Chrome, ‏Edge), **תיקייה**. כל פתק וכל קובץ מצורף
נכתבים עם נתיב התיקייה שלהם. ייצוא לתיקייה נכנס לתת-תיקייה חדשה
`lumen-vault-<date>`, כך ששום דבר שכבר נמצא בתיקייה שבחרתם לא נדרס. הפתק
שאתם עורכים נשמר קודם.

**ייבוא:** `⌘K → Import notes (zip / folder: Obsidian, Notion, Lumen)…`.
בוחרים ‎.zip או תיקייה. Lumen מזהה:

| מקור | מזוהה לפי | מה הייבוא עושה |
|---|---|---|
| כספת Obsidian | תיקיית `.obsidian/` | פתקים וקבצים מצורפים כמו שהם; ‏`.obsidian/` עצמה מדולגת |
| ייצוא של Notion | רוב שמות הקבצים מסתיימים במזהה של Notion (32 תווים) | המזהים מוסרים מהשמות, והקישורים בין הדפים נכתבים מחדש לשמות החדשים |
| ייצוא של Lumen, או כל תיקייה | אחרת | הכול כמו שהוא |

הכול מיובא ל**תיקייה חדשה** (`Imported/<name>`, ממוספרת כשהשם תפוס), כך
ששום פתק קיים לא נדרס לעולם. שני דפים שמקבלים אותו שם ממוספרים
(`Page 2.md`). ‏`.git`,‏ `.trash`,‏ `__MACOSX` ו-`.DS_Store` מדולגים. בסוף
הייבוא הודעה אומרת כמה פתקים וקבצים נכנסו ולאן.

## מסמך אחד

**החוצה:** תפריט *File* ולוח הפקודות מייצאים את הפתק הפתוח ל-HTML,‏ Word
‏(‎.doc), ‏RTF,‏ LaTeX,‏ reStructuredText,‏ AsciiDoc,‏ Org-mode,‏ OPML,
מצגת (Reveal.js), ‏EPUB,‏ Jupyter ‏(‎.ipynb), ‏PowerPoint ‏(‎.pptx), אתר
סטטי, ו-PDF ‏(`⌘K → Print / Save as PDF…`). טקסט מימין לשמאל שומר על הכיוון
שלו בקבצים המיוצאים.

**פנימה:** פותחים קובץ (`⌘O`) או גוררים אותו לחלון. מלבד Markdown וטקסט,
Lumen ממירה לפתק Markdown את: HTML,‏ RTF,‏ CSV / TSV,‏ JSON,‏ XML,‏ Word
‏(‎.docx וגם ‎.doc הישן), ‏OpenDocument ‏(‎.odt), ‏PowerPoint ‏(‎.pptx),
Excel ‏(‎.xlsx), ‏EPUB,‏ PDF (עם OCR לעמודים סרוקים), ‏MHTML,‏ OPML,‏ LaTeX,
reStructuredText,‏ AsciiDoc,‏ Org-mode, מחברות Jupyter, ‏Apple Pages /
Numbers / Keynote, תסריטי Fountain וארכיוני ‎.zip.

## איך זה נבדק

הלוך-חזור של הכספת (ייצוא ואז ייבוא), זיהוי Obsidian ו-Notion, כתיבה מחדש
של הקישורים של Notion ומספור שמות כפולים — בדיקות יחידה על
`src/storage/exportAll.ts`. לכל ממיר פורמט יש בדיקות משלו.
