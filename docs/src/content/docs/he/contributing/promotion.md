---
title: לפני main, ‏WebKit ו-Safari
description: ‏npm run promote:check מסרב לקדם את main לקומיט שאין לו קבלת WebKit חתומה וקבלת Safari חתומה. ‏WebKit רץ במפעל האימות, ו-Safari אמיתי רץ בתוכנית הקוד הפתוח של BrowserStack.
---

הפלטפורמה שאיבדה פתקים בתרגיל בטיחות הנתונים (#470: ‏376 פתקים בנתיב
ה-OPFS של Safari) היא בדיוק זו שהאימג׳ של Vercel לא יכול לבדוק: ‏WebKit
צריך glibc חדש יותר מזה שיש באימג׳. לכן הכלל (משימה W6.6) הוא: **לא
מקדמים את main לקומיט שאין לו קבלת WebKit וקבלת Safari לאותו קומיט.**

```bash
npm run promote:check                         # the commit you're on
npm run promote:check -- origin/verify/train  # the train you're about to merge
npm run promote:check -- <sha> --pin <key fingerprint>
```

הפקודה יוצאת ב-0 רק כששני התנאים מתקיימים:

- **WebKit:** קבלה מלאה של [מפעל האימות](/he/self-hosting/verification-factory/)
  לאותו קומיט, שבה החבילה `e2e webkit` עברה (כל הספֵּקים, בארבעה
  רסיסים). אם תרגיל בטיחות הנתונים רץ באותה קבלה, גם הוא עבר.
- **Safari:** ריצות Safari שעברו על iPhone אמיתי ועל macOS לאותו קומיט,
  בקבלה של המפעל או בקבלת `safari` נפרדת.

קבלה נספרת רק כשחתימת ה-Ed25519 שלה מאומתת מול מפתח מארח ממאגר הקבלות
(`keys/<host>.pem`). קבלה של קומיט אחר נספרת רק כשלקומיט ההוא יש בדיוק
אותו עץ: מיזוג ל-main שלא משנה שום דבר אחר. מעבירים `--pin` (או
`LUMEN_RECEIPT_KEYS`) עם טביעות האצבע שהמפעל הדפיס בהתקנה. בלי זה, כל
מפתח במאגר הקבלות נחשב מהימן, והבדיקה אומרת את זה.

יציאה ב-1 פירושה סירוב, והפלט מציין מה חסר או מה נכשל. יציאה ב-2 פירושה
שאי אפשר היה לבדוק: קומיט לא מוכר, אין קבלות, או אין מפתח מהימן.

## ‏WebKit: במפעל

המפעל מריץ את כל הספֵּקים בפרויקט `webkit` של `playwright.config.ts`
‏(ה-WebKit של Playwright, בהגדרות "Desktop Safari"), בתוך האימג׳ של
Playwright על Ubuntu 24.04. האימג׳ מגיע עם הספריות של WebKit ל-amd64
ול-arm64. גם בטיחות הנתונים נבדקת שם: ‏`e2e/data-safety.spec.ts` הוא חלק
מהריצה המלאה, וכך גם תרגיל בטיחות הנתונים כשהוא קיים בקומיט.

## ‏Safari: תוכנית הקוד הפתוח של BrowserStack

**מה התוכנית נותנת** (browserstack.com/open-source, נבדק ב-12 בנובמבר
2026): בחינם, ‏"unlimited testing on desktop and mobile: Live, Automate and
Percy", ל-**‏5 משתמשים ו-5 ריצות במקביל**, כל עוד הפרויקט קיים ("lifetime
access"). הדף לא מציין מגבלת דקות, ולא תנאי רישיון, ייחוס או חידוש. טופס
הבקשה מבקש שם, אימייל, סיסמה ו**כתובת הפרויקט**.

**מה רץ:** ‏`npm run safari:run`. המפעל מריץ אותו לרכבות ברגע שיש פרטי
גישה. הסקריפט בונה את האפליקציה עם ה-hooks של ה-e2e, ומריץ את הספֵּקים
האלה דרך ה-SDK של BrowserStack ל-Node, עם BrowserStack Local, כך שהמכשירים
מגיעים לאפליקציה שרצה על המפעל עצמו:

- ‏`e2e/smoke.spec.ts`, ‏`e2e/rtl.spec.ts`, ‏`e2e/first-run.spec.ts`,
  ‏`e2e/locale-switch.spec.ts` ו-`e2e/data-safety.spec.ts`
- ב-**Safari אמיתי על iPhone 17 ‏(iOS 26), ‏iPhone 16 ‏(iOS 18) ו-iPhone 15
  ‏(iOS 17)**. לשתי הגרסאות הישנות חסרים חלקים של OPFS, וזה הנתיב שאיבד
  פתקים.
- ב-**macOS Sequoia, בדפדפן `playwright-webkit`**: ‏BrowserStack מריץ את
  בניית ה-WebKit של Playwright על Mac אמיתי. זה לא אפליקציית Safari.
  ‏Safari האמיתי מגיע מה-iPhone-ים. ‏BrowserStack תומך ב-Playwright על
  Safari אמיתי ב-iOS מיוני 2025, עם Playwright בגרסה 1.50.1 ומעלה.

כל פלטפורמה מקבלת תוצאה משלה: חבילה (`safari ios 17 (iPhone 15)`),
‏commit status, והמכשיר וגרסת ה-iOS שלו בקבלה. זה התיעוד של גרסאות Safari
שנבדקו.

**לא אוטומטי:** בדיקת Word ‏(RTL) והעדכון האוטומטי בדסקטופ שב-15.12 עדיין
דורשות אדם. החלק של Safari ב-15.12 הוא הספֵּקים האלה.

### הצעד של הבעלים, אחרי ש-BrowserStack מאשרים

1. מגישים בקשה ב-**browserstack.com/open-source** עם כתובת הפרויקט
   `https://github.com/talstilkol/lumen-md` (ציבורי, MIT).
2. אחרי האישור מעתיקים את ה-**Username** ואת ה-**Access Key** מלוח
   הבקרה של Automate, ומה-Mac מריצים:

```bash
VM=ubuntu@<the factory's IP>
printf 'BrowserStack username: '; read -r BSU; printf 'Access key: '; read -rs BSK; echo
printf 'BROWSERSTACK_USERNAME=%s\nBROWSERSTACK_ACCESS_KEY=%s\n' "$BSU" "$BSK" | ssh "$VM" 'sudo install -m 600 -o root /dev/stdin /etc/lumen-factory/browserstack.env && sudo systemctl daemon-reload'
unset BSU BSK
```

יחידת ה-systemd של המפעל קוראת את הקובץ הזה אם הוא קיים. פרטי הגישה
מגיעים לקונטיינר הבדיקות כמשתני סביבה, ואף פעם לא בשורת פקודה. ב-Mac
(הגיבוי) כותבים את אותן שתי שורות ל-`~/lumen-factory/etc/browserstack.env`
עם `chmod 600`.

עד ש-BrowserStack מאשרים, ‏`promote:check` מסרב לכל קידום של main. זה
הכלל של התוכנית, לא תקלה.
