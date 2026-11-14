---
title: ממשק הבדיקות של e2e
description: window.__lumen.agentReview קיים רק בפיתוח ובבדיקות.
---

בדיקות הקצה-לקצה מפעילות כמה פונקציות של האפליקציה דרך `window.__lumen`.
אחת מהן, `window.__lumen.agentReview`, מכניסה שינוי
ל[מסך האישור של הסוכנים](/he/ai/agents/) כמו שכלי הכתיבה של סוכן עושה.
סקריפט בדף שהיה יכול לקרוא לה היה יכול להציג לך שינויים שאף סוכן לא הציע,
ולכן היא **לא חלק מהאפליקציה שמתקינים**.

## איפה היא קיימת

| בנייה | `window.__lumen.agentReview` |
|---|---|
| `npm run dev` (שרת הפיתוח של Vite) | כן |
| `npx vitest` (בדיקות יחידה) | כן |
| `VITE_LUMEN_TEST_SURFACE=1 npm run build` (רק בעבודת e2e-prod) | כן |
| `npm run build` (כל גרסה: PWA, שולחן עבודה ומובייל) | **לא** — הקוד מוסר מהחבילה |

בניית הגרסה מחליפה את `import.meta.env.DEV` ואת `VITE_LUMEN_TEST_SURFACE`
בקבועים, ולכן הממשק והפונקציה שמאחוריו נמחקים כשהחבילה עוברת מזעור.

## בדיקת בנייה

```sh
npm run build
npm run check:test-surface
```

`check:test-surface` קורא כל קובץ JavaScript תחת `dist/` ונכשל אם אחד מהם
עדיין קובע או קורא `.agentReview` (מפתחות התרגום כמו `agentReview.title`
הם טקסט ולא נספרים). ה-CI מריץ אותו אחרי בניית הייצור.
