---
title: בדיקת ה־PR
description: הפקודה npm run pr:check היא שער ה־PR המקומי שמחליף את Danger.js ואת size-limit. היא מדווחת על גודל החבילה מול הבסיס, על סעיפי תיאור ה־PR, על [skip ci] בקומיטים, על קריאות רשת לא רשומות, על רישיונות ועל כלל הדומיין.
---

לומן לא מריץ GitHub Actions על pull requests. ‏Danger.js ו־size-limit צריכים
Actions, ולכן פקודה מקומית אחת מחליפה אותם (תוכנית 0.19):

```bash
npm run build
npm run pr:check -- --base origin/main --body pr-body.md --build-base --out pr-check.md
```

הדוח הוא Markdown, ומדביקים אותו ב־pull request. הפקודה יוצאת עם קוד 1
כשבדיקה נכשלת. אזהרות לא מכשילות אותה.

## הבדיקות

- **גודל החבילה.** הגודל הדחוס של כל סוג chunk ‏(`npm run budget -- --json`),
  בהשוואה לבסיס, בטבלה. התוצאה של תקציב החבילה עצמו קובעת אם הבדיקה
  עוברת. הגדלים של הבסיס מגיעים מאחת משתי דרכים:
  - ‏`--base-sizes <file>`;
  - ‏`--build-base`, שבונה את בסיס המיזוג ב־worktree זמני שמקושר
    ל־`node_modules` של העותק הזה.
- **קומיטים.** כל כותרת מבסיס המיזוג ועד `HEAD` כוללת `[skip ci]`.
- **תיאור ה־PR.** בקובץ שמועבר עם `--body` יש את כל הסעיפים, ואף אחד
  מהם לא ריק:
  - What and why
  - Definition of done (plan 0.7)
  - Local verification
  - Not verified here
  - Owner commands
- **רשת.** כל קריאה חדשה ששולחת בקשה (`fetch`,‏ `WebSocket`,‏ `EventSource`,‏
  `sendBeacon`,‏ `importScripts`) הולכת לשרת שרשום ביומן הפרטיות
  (`src/ai/privacyLedger.ts`). קריאה שהכתובת שלה מחושבת צריכה במקום זה
  הערה `// privacy-ledger: <rule>`.
- **רישיונות.** לכל חבילת production שנוספה או השתנתה ב־lockfile יש רישיון
  מותר (לא copyleft, לא לא־מסחרי, ולא חסר).
- **דומיין.** אף שורה שנוספה לא מזכירה את הדומיין של הפרויקט.
- **סקירה אנושית (משימה W4.28).** שינוי בנתיב רגיש — כל נתיב
  ב־`.github/CODEOWNERS`: הצפנה, כתיבה לכספת, יומן הפרטיות, CSP ומדיניות
  אבטחה, הרשאות native — צריך את התווית `human-reviewed`, שאדם הוסיף אחרי
  ה־commit האחרון. עם `--pr <n>` התווית והזמן שלה נקראים מ־GitHub (‏`gh api`)
  והבדיקה נכשלת בלעדיהם; בלי `--pr` היא רק מזהירה. טל מריץ אותה עם `--pr`
  לפני כל מיזוג. ראו [מתחזק שני](/he/contributing/second-maintainer/).
- **לכל קובץ רגיש יש בעלים (משימה W8.6).** אילו קבצים רגישים מחושב מהקוד,
  ולא נשמר ביד (`scripts/lib/sensitivePaths.mjs`): קוד שנשלח למשתמשים
  שהנתיב או הטקסט שלו מראים הצפנה, דלת ייצוא או פרסום, sanitizer, ‏sandbox
  של מסגרת, CSP או כותרות אבטחה, קריאת רשת, השחרה, ‏criticMarkup, או צינור
  ה־Markdown ל־HTML והמקומות שמכניסים HTML גולמי. כל קובץ כזה שהשתנה צריך
  שורה ב־`.github/CODEOWNERS`, או רשומה ב־`security/codeowners-exceptions.json`
  עם סיבה ותאריך תפוגה (לכל היותר 90 יום קדימה). חריגה שפג תוקפה או שאין לה
  תאריך מכשילה. כש־PR משנה את CODEOWNERS או את החריגות, נבדק כל העץ. הדוח
  מדפיס את השורות להוספה ל־CODEOWNERS.

הפקודה גם מזהירה:
- כשקוד השתנה ואף בדיקה לא השתנתה;
- כש־PR נכתב על ידי סוכן AI (מוסיפים את התווית `ai-written`).

## אפשרויות

| אפשרות | משמעות |
|---|---|
| ‏`--base <ref>` | הענף שה־PR נכנס אליו (ברירת המחדל: `origin/main`) |
| ‏`--body <file>` | תיאור ה־PR, לבדיקת הסעיפים |
| ‏`--base-sizes <file>`,‏ `--head-sizes <file>` | גדלים שכבר נמדדו |
| ‏`--build-base` | בנייה ומדידה של הבסיס |
| ‏`--no-size` | דילוג על בדיקת הגודל |
| ‏`--pr <n>` | מספר ה־pull request: קריאת התוויות, אירועי התוויות והסקירות (כלל הסקירה האנושית) |
| ‏`--repo <owner/name>` | הריפו, כשה־remote ‏`origin` לא מציין אותו |
| ‏`--out <file>` | כתיבת הדוח לקובץ |

## כל העץ

‏`npm run codeowners:check` מריץ את בדיקת הבעלים על כל קובץ בריפו ויוצא
עם 1 כשיש פער. ‏`-- --list` מדפיס גם כל קובץ רגיש, הכללים שהוא תאם ושורת
ה־CODEOWNERS שמכסה אותו. כך נראית חריגה:

```json
[
  { "path": "src/storage/exportOdt.ts", "reason": "The second maintainer takes it over in W9.1.", "expires": "2027-01-31" }
]
```
