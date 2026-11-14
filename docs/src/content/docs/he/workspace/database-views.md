---
title: תצוגות מסד נתונים
description: טבלה / Kanban / גלריה / לוח שנה בסגנון Notion מעל ה-front matter ב-YAML שלכם.
---

הבלוק `database` הופך כל תיקייה של פתקי Markdown (עם front matter עקבי ב-YAML)
לאוסף שאפשר לשאול עליו — ומציג את התוצאה באחת מארבע תצוגות אינטראקטיביות.

## תייגו את הפתקים

מוסיפים front matter ב-YAML לכל פתק שרוצים לכלול:

```yaml
---
type: book
title: Invisible Cities
author: Italo Calvino
rating: 5
status: reading
cover: https://example.com/cover.jpg
---

(גוף…)
```

השדות לגמרי לבחירתכם — `type` הוא היחיד ש-Lumen מתייחסת אליו באופן מיוחד
(הוא מסנן השורות).

## הוסיפו בלוק database

```database
source: books/         # תיקייה תחת שורש סביבת העבודה
type: book             # סינון לפי frontmatter.type
view: kanban           # table | kanban | gallery | calendar
groupBy: status        # ל-kanban
sortBy: -rating        # '-' בהתחלה לסדר יורד
fields: [title, author, rating, status]
cover: cover           # לכרטיסי הגלריה
```

Lumen סורקת את סביבת העבודה, מוצאת כל פתק שבו `frontmatter.type` שווה ל-`book`,
ומציגה את התצוגה שביקשתם.

## תצוגות

- **טבלה** — קלאסית, אפשר למיין. לחיצה על שורה פותחת את הפתק.
- **Kanban** — עמודות לפי `groupBy`, כרטיסים נגררים (בקרוב), ותצוגה מקדימה של
  3 השדות הראשונים בכל כרטיס.
- **גלריה** — תמונת שער + שדות מרכזיים. ‏`cover: <שם שדה>` קובע איזו כתובת
  מה-front matter תהיה תמונת הכרטיס.
- **לוח שנה** — רשימת אירועים של כל פתק עם `dateField` שאפשר לפענח.

## עדכון חי

עורכים פתק בלשונית אחרת ותצוגת מסד הנתונים מריצה את השאילתה מחדש
אוטומטית (אירוע `lumen-workspace-changed` מפעיל את הרענון).

## טיפים

- שלבו תצוגות — השאירו בלוק database גדול אחד בראש פתק מרכזי ועברו בין
  Kanban לגלריה בפס הלשוניות.
- שלבו עם **הוספה חכמה** — מדביקים מפרט YAML בשורה ריקה ו-Lumen עוטפת אותו
  בגדר `database` בשבילכם.
- בתוך הבלוק מסד הנתונים לקריאה בלבד. כדי לערוך שורה, לוחצים על הכותרת שלה
  ופותחים את הפתק עצמו.
