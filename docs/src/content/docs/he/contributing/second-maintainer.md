---
title: מתחזק שני
description: הכניסה של המתחזק השני של Lumen — הרשאות, הבדיקות המקומיות, איך סוקרים שינוי רגיש ומוסיפים את התווית human-reviewed, דיווחי אבטחה, ומה רק הבעלים מחזיק היום.
---

ל-Lumen יש מתחזק אנושי אחד (טל) וסוכני AI שפותחים את רוב ה-pull requests.
קוד שמגן על המשתמשים — הצפנה, כתיבה לכספת, יומן הפרטיות, CSP — לא יכול
להיות תלוי באדם אחד או להתמזג בלי שאדם קרא אותו. כאן כל מה שמתחזק שני צריך
ביום הראשון.

## 1. הרשאות (טל עושה, כ-10 דקות)

```sh
# הזמנה בתפקיד Maintain (מיזוג, תוויות, advisories; בלי הגדרות או מחיקה).
gh api -X PUT repos/talstilkol/lumen-md/collaborators/<login> -f permission=maintain
```

אחר כך טל מוסיף `‎@<login>` אחרי `‎@talstilkol` בכל שורה של
`.github/CODEOWNERS`, ב-pull request שהוא סוקר בעצמו (הקובץ עצמו הוא נתיב
רגיש). מאז GitHub מבקש את הסקירה שלכם בכל pull request שנוגע בנתיב רגיש.

## 2. מריצים הכול מקומית (בלי GitHub Actions)

הריפו לא מריץ GitHub Actions. כל בדיקה רצה אצלכם:

```sh
git clone https://github.com/talstilkol/lumen-md && cd lumen-md
npm ci
npm run typecheck && npx vitest run          # בדיקות יחידה ורכיבים
npm run build && npm run budget              # בניית production ותקציב החבילה
npx playwright test --project=chromium       # מקצה לקצה
bash tools/native-check/run.sh               # Rust ו-Java בלי רשת (אם קיים בענף)
npm run pr:check -- --base origin/<base> --pr <n> --no-size   # שער ה-PR, לפני מיזוג
```

## 3. סקירה של שינוי רגיש

`npm run pr:check -- --pr <n>` מציג את הקבצים הרגישים שה-pull request משנה
ונכשל עד שהתווית `human-reviewed` עליו, **ונוספה אחרי ה-commit האחרון**.
סוכנים אף פעם לא מוסיפים אותה: היא אומרת "אדם קרא את ה-diff הזה". קוראים את
ה-diff עם השאלות של התחום:

| תחום (הנתיבים ב-`.github/CODEOWNERS`) | שואלים |
|---|---|
| הצפנה (`src/sync/e2ee/`,‏ `src/collab/encryption.ts`,‏ `src/storage/vault/encrypted/`,‏ `src/lib/crypto*`, מחזיק המפתחות, חתימות) | רק WebCrypto ופרימיטיבים של הפלטפורמה, בלי הצפנה בכתב יד? nonce/IV אקראי וחדש לכל הצפנה, אף פעם לא פעמיים עם אותו מפתח? פרמטרי ה-KDF לא הורדו? מפתחות לא נרשמים ביומן, לא נשלחים ולא נשמרים גלויים? ההצפנה המאומתת (GCM) נבדקת לפני שימוש? |
| כתיבה לכספת (`src/storage/vault/`,‏ `src-tauri/vault/`,‏ `src-tauri/src/lib.rs`, תוסף ה-SAF של Android) | כל נתיב נבדק שהוא נשאר בתוך הכספת (`..`, נתיבים מוחלטים, symlinks)? הכתיבה אטומית (קובץ זמני ואז rename)? כשל משאיר את הפתק הישן שלם? |
| פרטיות (`src/ai/privacyLedger.ts`, יומן ה-worker,‏ `src/ai/policy.ts`, טלמטריה) | האם מארח, קטגוריה או כלל חדש מוציאים טקסט של פתקים, מפתחות או מידע אישי מהמכשיר בלי פעולה של המשתמש? ברירת המחדל עדיין מקומית בלבד? |
| CSP, כותרות ומדיניות (`src/build/cspEndpoints.ts`,‏ `public/_headers`,‏ `deploy/`,‏ `scripts/headers.mjs`,‏ `security/`) | אין wildcard חדש, `unsafe-*`, או מארח צד שלישי בלי רשומה ביומן? COOP/COEP לא השתנו בלי כוונה? |
| ניקוי תוכן וארגז החול של התוספים | HTML לא מהימן עדיין עובר ניקוי? ה-iframe של התוספים עדיין בלי `allow-same-origin`? |
| הרשאות native ‏(`src-tauri/capabilities/`,‏ `tauri.conf.json`,‏ `updates.rs`) | אין הרשאת `fs:`/`shell:` רחבה יותר? העדכונים עדיין חתומים ורק משרת השחרורים? |

כשהכול נכון: מאשרים (Approve) את ה-pull request ב-GitHub (האישור שלכם על
ה-commit האחרון מופיע בדוח של pr:check), ואז מוסיפים את התווית:

```sh
gh api -X POST repos/talstilkol/lumen-md/issues/<n>/labels -f "labels[]=human-reviewed"
```

אם מגיעים commits אחרי הסקירה, הבדיקה נכשלת שוב: סוקרים את ה-commits
החדשים, מסירים את התווית ומוסיפים אותה מחדש.

## 4. דיווחי אבטחה

דיווחים מגיעים כ-advisories פרטיים ב-GitHub ‏(`SECURITY.md`). שני
המתחזקים מקבלים אותם. אם טל לא ענה תוך 48 שעות, הדיווח שלכם: מאשרים קבלה,
ממיינים, מתקנים ב-fork הפרטי של ה-advisory, משחררים ומפרסמים.

## 5. מה רק הבעלים מחזיק היום

אלה נקודות כשל יחידות עד שהן משותפות או מופקדות; כל אחת היא צעד של הבעלים
(משימה W4.7):

- פרויקט Vercel והדומיין `lumen-md.vercel.app`;
- מפתח החתימה של עדכוני שולחן העבודה (minisign) והסיסמה שלו;
- חשבונות Apple Developer ו-Google Play ומפתחות החתימה שלהם;
- הרשאות admin בריפו ב-GitHub.

מומלץ: עותק חתום של כל מפתח במנהל סיסמאות משותף לשני המתחזקים (‏1Password
או Bitwarden עם "גישת חירום"), והרשאות admin למתחזק השני אחרי שישה חודשים
של סקירות.
