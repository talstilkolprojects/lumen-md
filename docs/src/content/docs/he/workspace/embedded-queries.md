---
title: שאילתות מוטמעות וחיפושים שמורים
description: בלוק ‎```query‎ מציג את הפתקים שמתאימים לחיפוש, בלוק ‎```dataview‎ מריץ שאילתות Dataview נפוצות של Obsidian, וחיפושים שמורים יושבים בסרגל הצד. כולם מתעדכנים כשהכספת משתנה.
---

## בלוקים מסוג query

כותבים חיפוש בבלוק `query`, והתצוגה המקדימה מציגה את הפתקים שמתאימים לו,
ומתעדכנת כששומרים פתקים:

````markdown
```query
tag:project -tag:done
view: table
sort: modified desc
limit: 20
```
````

החיפוש משתמש באותם [אופרטורים](/he/workspace/search-operators/) כמו חלון
החיפוש: מילים, `tag:`,‏ `path:`,‏ `"ביטוי מדויק"`,‏ `/regex/` ו-`-מילה` כדי
להוציא פתקים. שורות בצורה `option: value` קובעות איך זה מוצג:

| אפשרות | ערכים | ברירת מחדל |
|---|---|---|
| `view` | ‏`list`,‏ `table` (פתק, תיקייה, שינוי, תגיות) | `list` |
| `sort` | ‏`relevance`,‏ `name`,‏ `path`,‏ `modified` — ואחריהם `asc` או `desc` | `relevance` |
| `limit` | ‏1–500 | 50 |

שורה שמתחילה ב-`//` היא הערה. הפתק שמחזיק את הבלוק לא מופיע בתוצאות שלו.
אפשרות שלא הצלחנו לקרוא מוצגת מעל התוצאות, ולא נבלעת בשקט.

## בלוקים מסוג dataview

כספות שמגיעות מ-Obsidian מלאות בבלוקים של
[Dataview](https://blacksmithgu.github.io/obsidian-dataview/). ‏Lumen מריץ את
החלק הנפוץ של שפת השאילתות שלו, כך שהם מוצגים כאן גם בלי התוסף:

````markdown
```dataview
TABLE status, due FROM #project WHERE status != "done" SORT due ASC
```
````

- **`LIST [expr]`** ו-**`TABLE [WITHOUT ID] expr [AS "name"], …`**
- **`FROM`**‏ `#tag`,‏ `"folder"`,‏ `[[note]]` (פתקים שמקשרים אליו), עם
  `AND`,‏ `OR`,‏ `-` וסוגריים
- **`WHERE`** השוואות (`= != < > <= >=`), ‏`and` / `or` / `!`,‏ `+ - * /`
- **`SORT`** שדה אחד או יותר, `ASC` / `DESC`; ‏**`LIMIT`** n
- שדות: front matter, שדות בשורה (`key:: value`,‏ `[key:: value]`), ו-
  `file.name`,‏ `file.path`,‏ `file.folder`,‏ `file.link`,‏ `file.mtime`,
  ‏`file.ctime`,‏ `file.size`,‏ `file.tags`,‏ `file.outlinks`
- פונקציות: `contains`,‏ `icontains`,‏ `startswith`,‏ `endswith`,‏ `length`,
  ‏`lower`,‏ `upper`,‏ `date(today)`,‏ `dur(7 days)`,‏ `default`,‏ `choice`,
  ‏`round`,‏ `number`,‏ `string`,‏ `join`,‏ `regexmatch`

‏`TASK`,‏ `CALENDAR`,‏ `GROUP BY`,‏ `FLATTEN` ו-DataviewJS לא נתמכים: הבלוק
אומר זאת במקום לנחש. שום דבר בשאילתה לא רץ כקוד — השפה מפוענחת ומפורשת,
ובדיקה מוודאת שאין `eval` בקוד השאילתות.

## עדכון חי

שני סוגי הבלוקים רצים מחדש כשפתק נשמר, נמחק או משנה שם. בכספת של 1,000
פתקים ההרצה מחדש אחרי שמירה לוקחת הרבה פחות מ-100ms.

## חיפושים שמורים

בחלון החיפוש, **☆ שמירת החיפוש** שומר את החיפוש. החיפושים השמורים מופיעים
בראש סרגל הקבצים; לחיצה פותחת את החלון שוב על אותו חיפוש, ו-× מסיר אותו.
הם נשמרים בדפדפן הזה, לא בכספת.
