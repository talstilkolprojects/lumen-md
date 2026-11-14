---
title: בדיקות מדולגות
description: כל בדיקה מדולגת אומרת למה, באיזו משימה ועד מתי; npm run hygiene נכשל על בדיקה שלא אומרת, ו-npm run skips מציג את כולן.
---

בדיקה מדולגת נראית כמו כיסוי, אבל לא בודקת כלום. לכן כל קריאה שמדלגת על
בדיקה או דוחה אותה — `test.skip`, `it.skip`, `describe.skip`, `*.skipIf`,
`*.runIf`, `*.fixme`, `*.todo`, ב-`src/` (Vitest) וב-`e2e/` (Playwright) —
נושאת הערה מובנית אחת, באותה שורה או מעליה:

```ts
// skip-reason: <why it cannot run here> | task: <plan id or #PR> | until: YYYY-MM-DD
test.skip(dev, "the service worker runs on the production build only");
```

`npm run hygiene` (ולכן גם ה-build של Vercel ל-preview) נכשל כש:

- לדילוג אין `skip-reason`, או שחסרים בה המשימה או התאריך;
- התאריך עבר (מתקנים את הבדיקה, או מנמקים שוב עם תאריך חדש) או רחוק יותר
  משנה;
- ב-`e2e/` יש יותר מ-15 קריאות דילוג.

## פער של מנוע עובר דרך פונקציה אחת

ל-WebKit של Playwright בלינוקס אין Origin Private File System, ולכן בדיקות
הכספת לא יכולות לרוץ שם. הן קוראות ל-`vaultOrSkip(written, browserName)`
מ-`e2e/_opfs.ts` אחרי שזרעו את הכספת: היא מדלגת רק ב-WebKit, ו**נכשלת**
ב-Chromium וב-Firefox, שבהם כספת שאי אפשר לכתוב אליה היא באג — עד משימה
W4.12 הבדיקות האלה דילגו בשקט בכל המנועים.

## הדוח

`npm run skips` מדפיס כל דילוג עם הנימוק, המשימה והתאריך שלו, ממוין לפי מה
שהוא משאיר בחוץ:

| סוג | משמעות |
| --- | --- |
| engine | הזרימה רצה במנועים האחרים |
| setup | הזרימה רצה רק בסביבה מיוחדת (build של production, שרת הפיתוח, מודל או שירות על המחשב, מדידה שמפעילים במפורש) |
| deferred | `todo`: כתוב, עוד לא בודק כלום |

בסוף הוא מציג את רשימת זרימות הכספת ש-WebKit לא מריץ. `npm run skips --
--json` נותן את אותו הדבר כ-JSON.
