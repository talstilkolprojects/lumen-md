---
title: הנוסחאות של Notion ב-Bases
description: פונקציות הנוסחאות של Notion (תאריכים, טקסט, מספרים, רשימות עם current ו-index, ‏lookups דרך קשרים) בתוך נוסחאות ומסננים של ‎.base, ועוד שתיים לעברית.
---

נוסחה או מסנן ב-`.base` יכולים להשתמש בפונקציות הנוסחאות של Notion לצד אלה
של Obsidian, כך שמסד נתונים שעובר מ-Notion שומר על הנוסחאות שלו. כשהשם כבר
שייך לפונקציה של Obsidian (`if`, ‏`min`, ‏`max`, ‏`empty`, ‏`now`, ‏`today`,
‏`link`, ‏`date`, ‏`list`, ‏`number`), נשארת המשמעות של Obsidian, כי קובץ
`.base` צריך לעשות ב-Lumen מה שהוא עושה ב-Obsidian.

## הפונקציות

| קבוצה | פונקציות |
|---|---|
| לוגיקה | ‏`ifs`, ‏`let`, ‏`lets`, ‏`equal`, ‏`unequal`, ‏`prop("Name")` |
| טקסט | ‏`length`, ‏`substring`, ‏`contains`, ‏`test`, ‏`match`, ‏`replace` (ההתאמה הראשונה), ‏`replaceAll`, ‏`lower`, ‏`upper`, ‏`trim`, ‏`repeat`, ‏`split`, ‏`join`, ‏`format`, ‏`concat` |
| מספרים | ‏`add`, ‏`subtract`, ‏`multiply`, ‏`divide`, ‏`mod`, ‏`pow`, ‏`abs`, ‏`round(n, places)`, ‏`ceil`, ‏`floor`, ‏`sqrt`, ‏`cbrt`, ‏`sign`, ‏`exp`, ‏`ln`, ‏`log10`, ‏`log2`, ‏`sum`, ‏`mean`, ‏`median`, ‏`toNumber`, ‏`pi`, ‏`e` |
| תאריכים | ‏`dateAdd`, ‏`dateSubtract`, ‏`dateBetween`, ‏`formatDate`, ‏`parseDate`, ‏`timestamp`, ‏`fromTimestamp`, ‏`year`, ‏`month` (‏1–12), ‏`week` (ISO), ‏`day` (‏1 = שני … 7 = ראשון), ‏`dayOfMonth` (ה-`date()` של Notion), ‏`hour`, ‏`minute` |
| רשימות | ‏`map`, ‏`filter`, ‏`find`, ‏`findIndex`, ‏`some`, ‏`every`, ‏`count`: הביטוי רואה את `current` ואת `index`. ‏`at` (אינדקס שלילי סופר מהסוף), ‏`first`, ‏`last`, ‏`slice`, ‏`sort`, ‏`reverse`, ‏`unique`, ‏`includes`, ‏`flat` |
| קשרים | ‏`relation.<name>` (הפתקים הקשורים), ‏`current.prop("X")` על אחד מהם, ‏`lookup(relation.<name>, "X")`, ‏`rollup.<name>` |
| עברית | ‏`hebrewDate(date)` נותן "ב׳ בכסלו תשפ״ז", ו-`hebrewDate(date, "day" \| "month" \| "year")` חלק אחד. ‏`stripNikud(text)` מסיר את הניקוד |

‏`dateBetween(a, b, unit)` הוא a פחות b ביחידות שלמות, בעיגול לכיוון אפס,
כמו ב-Notion. היחידות הן years, ‏quarters, ‏months, ‏weeks, ‏days, ‏hours,
‏minutes, ‏seconds ו-milliseconds. תאריך או מספר ריקים נותנים תוצאה ריקה, כך
ששורה בלי המאפיין לא מציגה כלום, במקום שגיאה.

## דוגמאות

```yaml
relations:
  subs: { property: Parent, incoming: true }
formulas:
  daysLeft: dateBetween(Due, today(), "days")
  hours: sum(map(relation.subs, current.prop("Estimate")))
  done: round(count(relation.subs, current.prop("Done")) / length(relation.subs) * 100) + "%"
  priority: ifs(Priority == 1, "High", Priority == 2, "Medium", "Low")
  hebrew: hebrewDate(Due)
```

## לסקריפטים ולתוספים

תוסף עם ההרשאה `bases:read` קורא את השורות של תצוגה עם `lumen.bases.query()`.
עם `bases:write`, ‏`lumen.bases.update()` משנה מאפיינים של פתקים מאחורי מסך
אישור אחד לכל קריאה. ראו [API לתוספים](/he/plugins/api/). אוטומציות יכולות
לרוץ [כששורה של base משתנה](/he/workspace/automations/).

## מהירות

‏10,000 פתקים, עם שני מסננים לכל התצוגות, מסנן אחד לתצוגה, עמודת נוסחה ומיון
לפי שני מפתחות, רצים בעשרות אלפיות שנייה אחרי חימום. הצהרות סינון פשוטות
(מאפיין מול ערך, ‏`file.inFolder`, ‏`file.hasTag`, ו-`&&`, ‏`||`, ‏`!` שלהן)
רצות בלי המפרש, עם אותן תוצאות.

## איך זה נבדק

סט זהב של 53 נוסחאות, כמו שמשתמשי Notion כותבים אותן, עם הערכים ש-Notion
מתעד (`src/__tests__/basesNotion.test.ts`). הוא משתמש בכל הפונקציות שלמעלה.
