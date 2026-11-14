---
title: הוספה חכמה (⌘⇧V)
description: מדביקים כל דבר לחלון אחד — Lumen מזהה את הסוג ועוטפת אותו בבלוק הנכון.
---

`⌘⇧V` פותח חלון אחד עם אזור טקסט גדול. מדביקים **כל דבר** ו-Lumen מבינה מה
לעשות איתו — בעזרת 19 מזהים, מהספציפי (כתובת YouTube) ועד הכללי (בלוק קוד
שהשפה שלו מנוחשת מהתוכן).

## המזהים, לפי הסדר

| סדר | התאמה | פלט |
| --- | --- | --- |
| 1 | ‏YouTube / Vimeo / Spotify / Twitter / TikTok / Reddit / GitHub Gist / Figma / מפות / ועוד 8 | ` ```embed ` |
| 2 | כתובת HTTPS לבד בשורה | קישור Markdown ‏`[url](url)` |
| 3 | `$$…$$` או `\begin{equation}…\end{equation}` | גדר מתמטיקה |
| 4 | `flowchart LR …`,‏ `sequenceDiagram`,‏ `gantt`, … | ` ```mermaid ` |
| 5 | `digraph G { … }` | ` ```dot ` |
| 6 | `@startuml … @enduml` | ` ```plantuml ` |
| 7 | `X:1 T:Test K:C …` (תווי ABC) | ` ```abc ` |
| 8 | `@article{…}` | ` ```bibtex ` |
| 9 | `{ "type": "FeatureCollection", … }` | ` ```map ` ‏(GeoJSON) |
| 10 | ‏YAML עם `view:` + `type:` / `source:` | ` ```database ` |
| 11 | ‏YAML עם `series:` + `xAxis:` | ` ```chart ` |
| 12 | `CREATE TABLE / INSERT INTO / SELECT …` | ` ```sql ` (מפוענח לטבלה) |
| 13 | מערך JSON של אובייקטים אחידים | ` ```json-table ` |
| 14 | ‏JSON תקין אחר | ` ```json ` |
| 15 | ‏HTML עם `<script>` / `<svg>` / `<canvas>` | ` ```htmlpreview ` (iframe אינטראקטיבי) |
| 16 | ‏HTML סטטי אחר | מומר ל-Markdown |
| 17 | `name,age\nalice,30\n…` | ` ```csv ` (טבלה + הצעות לגרפים) |
| 18 | שורות מופרדות בטאבים | ` ```tsv ` |
| 19 | קוד שמזוהה כ-JS / TS / Python / Rust / Go / Java / C / C++ / PHP / Ruby / Dockerfile | ` ```<lang> ` |
| 20 | כל השאר | Markdown רגיל — נכנס כמו שהוא |

ההתאמה הראשונה מנצחת. תג הזיהוי בחלון מראה בדיוק מה זוהה (״Detected as:
🔗 YouTube embed״), ותפריט נפתח מאפשר לבחור אחרת.

## חלונית התצוגה המקדימה

החלון מציג את ה-Markdown המומר באזור תצוגה מקדימה מתחת לשדה. היא מתעדכנת תוך
כדי הקלדה. רואים בדיוק מה עומד להיכנס למסמך לפני שמאשרים עם ⌘↵.

## מיקום ההוספה

- **בסמן** — משתמש ב-`insertText` של העורך, כך שהבחירה מסביב מוחלפת בצורה
  נקייה.
- **בסוף** — מוסיף לסוף המסמך עם שתי שורות חדשות.
- **החלפה** — מחליף את כל המסמך (בזהירות).

## דוגמאות

> מדביקים ״https://twitter.com/elonmusk/status/1585841080431321088״

← Detected as: 🐦 X / Twitter embed ← נעטף כ-```` ```embed ````.

> מדביקים ״name,age\\nalice,30\\nbob,25״

← Detected as: 📊 CSV table ← נעטף כ-```` ```csv ```` ו-Lumen מציעה גרף
עמודות לפי סוגי העמודות.

> מדביקים `function fetch(url) { … }` על כמה שורות

← Detected as: 💻 JS code ← נעטף כ-```` ```js ```` עם הדגשת Shiki.

## קיצור מקלדת

`⌘⇧V` בכל מקום. אפשר להגיע גם דרך:

- תפריט **Insert** בסרגל הכלים ← הפריט הראשון, מסומן ב-✨.
- לוח הפקודות (`⌘K`), חיפוש ״insert anything״.
