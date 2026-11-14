---
title: העברת הייצור למארח אחר
description: מדריך להעברת הייצור של Lumen מ-Vercel Hobby אל Cloudflare Pages בפחות משעה, לפני התשלום הראשון. הוא עוסק בכתובת החדשה, בפתקים של המשתמשים שנשארים בכתובת הישנה, בהפניה, בבדיקות ובדרך חזרה.
---

תוכנית Hobby של Vercel מיועדת **לשימוש לא מסחרי בלבד**
([הנחיות השימוש ההוגן](https://vercel.com/docs/limits/fair-use-guidelines)).
‏Lumen יגבה תשלום ראשון עם הממסר בתשלום (תוכנית W5.25). לפני כן הייצור צריך
לעבור למארח שמתיר שימוש מסחרי, או ש-Vercel ישודרג ל-Pro ‏(20$ למושב בחודש).
הדף הזה הוא המעבר עצמו. הוא לוקח כ-45 דקות, ואפשר לבטל אותו ב-5 דקות
(תוכנית W6.9).

**השער.** ‏`deploy/hosting.json` קובע מי מארח את הייצור ובאיזו תוכנית.
‏`npm run hosting:gate` מכשיל כל בנייה שגובה תשלום כשהייצור נמצא בתוכנית
שאוסרת שימוש מסחרי. הוא רץ ראשון בכל בנייה של Vercel
(`scripts/vercel-build.mjs`) וב-`pages:deploy`. משתני התשלום הם
`VITE_BILLING_ENDPOINT`, ‏`VITE_ENTITLEMENT_ENDPOINT`, מזהי המחירים
ו-`LUMEN_COMMERCIAL=1`. כך תשלום ראשון לא יכול לצאת על Hobby בטעות.

## למה הכתובת משתנה

‏`lumen-md.vercel.app` שייכת ל-Vercel, ואי אפשר להפנות את ה-DNS שלה למקום
אחר. לכן כתובת הייצור החדשה היא כתובת חינמית חדשה:
**`https://lumen-md.pages.dev`**, תת-הדומיין של Cloudflare לפרויקט Pages.
אפשר להוסיף דומיין משלך מאוחר יותר באותה דרך (לוח הבקרה של Cloudflare ←
הפרויקט ← Custom domains). זה יהיה מעבר שלישי, ולכן כדאי לבחור את הדומיין
לפני שלמשתמשים יש פתקים ב-`pages.dev`, אם אפשר.

## הפתקים של המשתמשים נשארים בכתובת הישנה

‏Lumen שומר הכול קודם כול במכשיר. הפתקים נשמרים באחסון של הדפדפן **לכתובת
אחת** (OPFS ו-IndexedDB נפרדים לכל origin). דפדפן שפותח את
`lumen-md.pages.dev` מתחיל ריק, גם אם השתמש ב-`lumen-md.vercel.app` אתמול.
הפניה פשוטה הייתה מסתירה את הפתקים של כולם. לכן הכתובת הישנה ממשיכה להגיש
את האפליקציה, בבנייה עם `VITE_MOVED_TO` (`src/pwa/hostMoveBoot.ts`), והיא
עושה שני דברים:

- **דפדפן שמעולם לא השתמש בה שם** (‏`localStorage` ריק, נבדק לפני שהאפליקציה
  עולה) עובר מיד לאותו נתיב, שאילתה ו-hash בכתובת החדשה.
- **דפדפן שיש בו פתקים שם** נשאר באפליקציה ומקבל פס הודעה (באנגלית
  ובעברית). הוא מוריד את כל הפתקים והקבצים המצורפים כקובץ `.zip` אחד (ייצוא
  הכספת), ואז פותח את הכתובת החדשה, ושם המשתמש מייבא את הקובץ (ייבוא כספת).
  מי שמסנכרן או משתמש ב-Git יכול במקום זה לחבר שוב את אותו ספק בכתובת
  החדשה.

בכתובת הישנה אין קוד תשלום (השער אוכף את זה), ולכן היא נשארת בתנאי Hobby.
היא רק מעבירה את האנשים הלאה.

## המעבר (כ-45 דקות)

ב-Mac, במאגר, מ-`main`:

```sh
# 1. פעם אחת: חשבון ופרויקט Cloudflare (5 דקות)
npx wrangler@4 login
npx wrangler@4 pages project create lumen-md --production-branch main

# 2. אותו קומיט בשני המארחים, עם בדיקה (10 דקות)
git checkout main && git pull && npm ci
npm run pages:deploy -- --prod        # שער האירוח, בנייה, pages:check --prepare, השוואת מארחים, העלאה
npm run hosts:parity -- --live https://lumen-md.vercel.app https://lumen-md.pages.dev
```

ההשוואה החיה צריכה להסתיים ב-`0 failing`. יש בה הבדל מקובל אחד:
`/missing-image.png`. ‏Vercel עונה 404, ו-Pages עונה עם האפליקציה (ראו
`ACCEPTED` ב-`scripts/lib/hostParity.mjs`). פתחו את הכתובת החדשה ובדקו את
העורך, את קורא ה-PDF ובלוק playground (לדף ה-runner שלו יש מדיניות משלו).
חפשו בקונסולה שגיאות `Content-Security-Policy`.

```sh
# 3. המארח החדש הופך לייצור (5 דקות)
#    deploy/hosting.json: "production": "cloudflare-pages"; קומיט ל-main.
#    מהקומיט הזה מותר לגבות תשלום (בבנייה של Pages בלבד).

# 4. הכתובת הישנה מעבירה הלאה (לוח הבקרה של Vercel ← lumen-md ← Settings ←
#    Environment Variables, ‏Production) (10 דקות)
#    VITE_MOVED_TO = https://lumen-md.pages.dev
#    ואז פריסה מחדש של main ב-Vercel. אף פעם לא משתני תשלום שם.

# 5. בדיקת ההעברה (5 דקות)
#    חלון פרטי על https://lumen-md.vercel.app/notes/x ← מגיע אל
#    https://lumen-md.pages.dev/notes/x. חלון רגיל שיש בו פתקים ← פס ההודעה;
#    "הורדת הפתקים שלי" שומר ‎.zip; מייבאים אותו ב-pages.dev.
```

אחר כך מעדכנים את הכתובת בכל מקום שהיא כתובה בו: ה-README, דפי החנויות,
‏`public/sitemap.xml`, ‏`og:url` ב-`index.html`, וכתובות ההפניה של OAuth
אצל ספקי הסנכרון (Google, ‏Dropbox, ‏GitHub). ספקי OAuth בודקים את ה-origin
המדויק, ולכן הכניסה בכתובת החדשה תיכשל עד שמוסיפים אותה.

## הדרך חזרה (5 דקות)

מוחקים את `VITE_MOVED_TO` ב-Vercel ופורסים מחדש, ומחזירים
`"production": "vercel"` ב-`deploy/hosting.json`. שום דבר לא נמחק באף שלב.
פתקים שמשתמש יצר בינתיים ב-`pages.dev` נשארים שם. פס ההודעה עובד גם בכיוון
ההפוך (בונים את העותק של Pages עם `VITE_MOVED_TO=https://lumen-md.vercel.app`).

## תרגיל: פחות משעה

תנאי הקבלה של W6.9 הוא תרגיל עם שעון: שלבים 2 עד 5 על פריסת ענף
(`npm run pages:deploy` בלי `--prod`, ו-preview של Vercel עם `VITE_MOVED_TO`
לענף הזה בלבד). רושמים את הדקות של כל שלב ב-PR של התרגיל.
