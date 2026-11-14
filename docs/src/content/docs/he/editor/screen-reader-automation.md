---
title: קוראי מסך, אוטומטית
description: מסלול קורא המסך בעברית שמריץ Guidepup עם VoiceOver ו-NVDA, ותמונות מצב של עץ הנגישות שרצות עם כל בדיקת קצה לקצה.
---

בדיקות אוטומטיות כמו axe מוצאות רק חלק ממה שחוסם משתמש בקורא מסך.
Lumen בודק את מה שקורא המסך אומר בשתי רמות.

## 1. תמונות מצב של עץ הנגישות (בכל הרצת e2e)

`e2e/aria-hebrew.spec.ts` מקבע את מה שקורא מסך מקבל בממשק העברי: תפקידים,
שמות ומצבים. הבדיקה משתמשת בתמונות המצב של Playwright (aria snapshots)
ב-Chromium, בלי קורא מסך:

- קישור הדילוג מופיע לפני האזור הראשי;
- לכותרות בפתק יש רמה, לתיבות המשימה מצב, ולקישורים שם;
- פלטת הפקודות היא דיאלוג מודאלי עם שם, שדה חיפוש ותוצאות כאפשרויות;
- לדיאלוג קיצורי המקלדת יש שם וכותרת.

```sh
npx playwright test e2e/aria-hebrew.spec.ts --project=chromium
```

## 2. קוראי מסך אמיתיים (Guidepup, ב-Mac או ב-Windows)

`sr/` מריץ עשר משימות מתוך פרוטוקול קורא המסך (תוכנית W1.23)
בעזרת [Guidepup](https://www.guidepup.dev/) ‏(MIT). ‏Guidepup מפעיל את VoiceOver
או את NVDA ומקליט את מה שהם אומרים. משימה עוברת כשהעברית שצריכה להישמע
נאמרה. המשימות נמצאות ב-`sr/journey.ts`.

Guidepup צריך מחשב שולחני אמיתי: הוא משתלט על קורא המסך, על המקלדת ועל
השמע. הוא לא רץ בקונטיינרים של CI או בארגז החול בענן.

### ב-Mac ‏(VoiceOver)

```sh
npm install -D @guidepup/guidepup @guidepup/playwright @guidepup/setup   # פעם אחת
npx @guidepup/setup                                       # פעם אחת: מאפשר להפעיל את VoiceOver מסקריפט
npm run test:sr -- --project=voiceover
```

לפני ההרצה בוחרים ב-VoiceOver Utility את הקול Carmit (עברית).

### ב-Windows או במכונה וירטואלית של Windows ‏(NVDA)

```sh
npm install -D @guidepup/guidepup @guidepup/playwright   # פעם אחת
npx @guidepup/setup                                       # פעם אחת: מתקין NVDA נייד
npm run test:sr -- --project=nvda-chrome
npm run test:sr -- --project=nvda-firefox
```

בוחרים ב-NVDA קול עברי (eSpeak NG בעברית או Microsoft Asaf).

### כל לילה ב-Mac

אחרי שמתקינים את שלוש חבילות `@guidepup/*`, ‏`npm run nightly` ב-Mac (תוכנית
W4.36, [ההרצות הליליות](/he/contributing/nightly/)) מוסיף את הסוג **sr**:
‏`npx @guidepup/setup --ci`, ואז המסע עם VoiceOver. הדוח החתום
‏`reports/nightly/<date>-sr.json` שומר לכל הגדרה את המשימות שעברו, כל חסם
ואת שורת הפרוטוקול. ‏`npm run nightly -- --only sr` מריץ רק אותו.

ההרצה הלילית צריכה Mac מחובר למשתמש (VoiceOver מדבר רק בתוך סשן של
משתמש) עם מסך לא נעול. אם הגנת שלמות המערכת (SIP) פעילה, ‏`@guidepup/setup`
לא יכול לכתוב את ההרשאה בעצמו: פעם אחת, בהגדרות המערכת ← פרטיות ואבטחה,
נותנים למסוף שמריץ את הלילה הרשאת **נגישות** והרשאת **אוטומציה ← VoiceOver**,
וב-VoiceOver Utility מפעילים את **Allow VoiceOver to be controlled with
AppleScript**.

### תוצאות

כל הרצה מדפיסה שורה לטבלת התוצאות של הפרוטוקול, ומוסיפה את
`sr-results/results.json` עם כל מה שנאמר בכל משימה. מדביקים את השורה בטבלת
התוצאות של הפרוטוקול ומעדכנים ממנה את דוח הנגישות. ‏TalkBack נשאר בדיקה
ידנית, פעם בשחרור.
