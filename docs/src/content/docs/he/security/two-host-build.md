---
title: נבנה זהה בשתי תשתיות
description: כל commit ל-main נבנה ב-Vercel ושוב ב-Cloudflare Workers Builds, מאותו lockfile, וכל קובץ בשתי הבניות מושווה.
---

בנייה שמשתחזרת רק על אותה מכונה לא מוכיחה הרבה. ענף ה-main של Lumen נבנה
בשתי תשתיות שונות:

- **Vercel**, שמגיש את האפליקציה ב-lumen-md.vercel.app;
- **Cloudflare Workers Builds**, בתוכנית החינמית. שם רק בונים ומגישים את
  התוצאה לצורך השוואה, ומשתמשים לא מגיעים לשם.

שתי הבניות משתמשות באותו commit ובאותו `package-lock.json`. אם כל קובץ יוצא
עם אותו SHA-256, שום דבר נסתר לא נכנס לבנייה באף אחד מהצדדים.

## איך זה עובד

1. כל בנייה כותבת `/.well-known/lumen-build.json`: ה-SHA-256 של כל קובץ
   ב-`dist`, עם ה-commit, ה-hash של ה-lockfile, גרסת Node והתשתית שבנתה.
   ב-Vercel זה השער `manifest`; ב-Cloudflare זה `npm run build:repro`.
2. בכל לילה המארח השני מריץ

   ```sh
   npm run repro:two-hosts -- --a https://lumen-md.vercel.app --b https://lumen-md-repro.<account>.workers.dev --verify-fetch --diffoscope
   ```

   הפקודה משווה את שני ה-manifests קובץ אחר קובץ. היא גם מורידה כל קובץ
   מכל אתר ובודקת אותו מול ה-manifest של אותו אתר, כך שגם מארח שמגיש בתים
   שונים ממה שבנה נתפס. לכל קובץ שונה נוצר דוח diffoscope.
3. בנייה זהה מקבלת הצהרת in-toto ("נבנה זהה בשתי תשתיות") עבור ה-attestation
   של השחרור (W7.22). קובץ ההיסטוריה שומר את מספר ה-commits הרצופים הזהים.

## יעדים

- 10 commits רצופים שבהם 100% מהקבצים זהים, כולל קובצי `.map` (בשחרור אין
  כאלה).
- הבנייה ב-Cloudflare נמשכת לכל היותר 15 דקות, מול מגבלה של 20 דקות.
- ‏$0: התוכנית החינמית של Workers Builds נותנת 3,000 דקות בנייה בחודש.
