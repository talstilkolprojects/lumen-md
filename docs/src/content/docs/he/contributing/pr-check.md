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
- **תמונות מצב (snapshots).** אסור לערוך snapshot ביד (`__snapshots__/`, `*.snap`, ו־`-snapshots/` של Playwright). הקומיט שמשנה snapshot לא משנה שום דבר אחר, ויש בו שורת trailer `Snapshot-Regenerated: npx vitest run <file> -u on <host>` (או `--update-snapshots`) עם שם המארח השני שבו הוא נוצר מחדש (תוכנית W6.15).

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
| ‏`--out <file>` | כתיבת הדוח לקובץ |
