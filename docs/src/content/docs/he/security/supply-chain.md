---
title: שרשרת האספקה
description: מפענחים שעוברים fuzzing, בנייה שחוזרת על עצמה, SBOM וסכומי ביקורת חתומים מחוץ לרשת לכל שחרור — ואיך כל אחד יכול לבדוק אותם.
---

[מודל האיום](/he/security/threat-model/) מניח שהקוד שאתם מריצים הוא הקוד
ששוחרר. ארבע בדיקות הופכות את זה לבדיק.

## ‏1. המפענחים עוברים fuzzing

כל מה ש-Lumen קורא מקובץ, מקישור, מהלוח או מתוסף עובר דרך מפענח: צינור
ה-Markdown, ‏front matter, ‏BibTeX, ‏JSON ו-JSONL ‏(Code Doctor, ‏Insights),
כתובות (המסנן, ההטמעות, בדיקת ה-CSP), כיוון הטקסט — ו-`.base`, ‏`.excalidraw`,
הערות PDF ו-manifest של תוספים כשהם נכנסים.

```bash
npm run fuzz                                    # 1,000,000 קלטים לכל מפענח
node scripts/fuzz/run.mjs --target bibtex --runs 50000
node scripts/fuzz/run.mjs --target bibtex --seed 1 --from 4242 --runs 1   # הרצה חוזרת של קלט אחד
```

הקלטים נבנים מהחלקים של כל פורמט (עם עברית, ערבית, תווי כיווניות, אימוג'י
וחצאי זוגות surrogate), ואז נחתכים, משוכפלים ומקוננים אלפי רמות. כל מפענח רץ
ב-worker משלו: חריגה שהמפענח לא מתעד היא **קריסה**; קלט אחד שרץ יותר משנייה
הוא **תקיעה** — ה-worker נעצר וההרצה ממשיכה. קלטים שנכשלו נשמרים
ב-`fuzz-findings/` עם הפקודה שמריצה אותם שוב. תנאי המעבר: 0 קריסות ו-0
קלטים מעל שנייה.

‏`--engine fast-check` מריץ את אותם מפענחים דרך
[fast-check](https://fast-check.dev) (עם צמצום דוגמאות) אחרי שהוא מותקן.

**Markdown פתולוגי (תוכנית W4.16).** ההרצה הראשונה מצאה שבעה קלטים (8–14KB)
שהציגו אותם 0.5–2.8 שניות: אלפי `[` או `]` בפסקה אחת, או רשימות מקוננות 231
רמות, גורמים לעבודה של המפענח לגדול בריבוע של אורך הטקסט. פתק כזה היה תוקע את
העורך. עכשיו בלוק (הטקסט שבין שורות ריקות) עם יותר מ-256 סוגריים או יותר מ-32
רמות קינון מוצג כטקסט גולמי, בבלוק קוד, בדיוק כפי שנכתב
(‏`src/renderer/boundMarkdown.ts`). כל פתק אמיתי נשאר רחוק מתחת לשני הגבולות
ומוצג כמו קודם. גם התצוגה החיה מציגה בלוק כטקסט גולמי אחרי שההצגה שלו לקחה
יותר מ-200ms. שבעת הקלטים נעוצים ב-`src/__tests__/markdownSlowInputs.test.ts`
(כל אחד מתחת ל-50ms).

## ‏2. הבנייה חוזרת על עצמה

```bash
npm run repro
```

בונה את אותו commit פעמיים מאפס (עם `SOURCE_DATE_EPOCH` לפי זמן ה-commit)
ומשווה את ה-SHA-256 של כל קובץ ב-`dist/`. כל הבדל מוצג לפי קובץ.

בבניית שחרור אין source maps (תוכנית 11.5), והבדיקה נכשלת אם מופיעה אחת, כך
שאין מפה שיכולה להיות שונה בין שתי בניות. מפות נועדו לבדיקה מקומית בלבד
(‏`LUMEN_SOURCEMAP=1`): ‏`node scripts/supply-chain/repro-check.mjs --sourcemap`
בונה איתן ומראה אילו שדות שונים בכל מפה שאינה זהה.

## ‏3. לכל שחרור יש SBOM

```bash
npm run sbom          # → release/sbom.cdx.json
```

רשימת CycloneDX 1.5 של כל חבילת npm ‏(`package-lock.json`) וכל crate של Rust
‏(`src-tauri/Cargo.lock`): גרסה, כתובת חבילה, ה-hash מקובץ הנעילה והרישיון.
אותם קובצי נעילה — אותם בתים.

## ‏4. כל שחרור נחתם — מחוץ לרשת

מפתח החתימה שייך לבעלים של השחרור ואף פעם לא נכנס למערכת CI.

**פעם אחת** (במחשב של הבעלים):

```bash
LUMEN_RELEASE_PASSPHRASE=… node scripts/supply-chain/keys.mjs --out ~/.lumen-release
cp ~/.lumen-release/lumen-release.pub security/release-key.pub   # רק הקובץ הזה נכנס ל-git
```

שמרו את `lumen-release.key` ואת הסיסמה שלו מחוץ לרשת (מנהל סיסמאות ועותק
שני לא מחובר). אם המפתח מוחלף, שחרורים ישנים נשארים בדיקים עם המפתח הציבורי
הישן.

**בכל שחרור:**

```bash
npm run repro && npm run build
LUMEN_RELEASE_PASSPHRASE=… npm run release:sign -- --key ~/.lumen-release/lumen-release.key \
  --artifact <כל קובץ למחשב / לטלפון>
```

נכתבים `release/SHA256SUMS` (כל קובץ ב-`dist/` וכל artifact),
‏`release/sbom.cdx.json` וחתימת minisign לכל אחד, ואז התוצאה נבדקת. מעלים את
ארבעת הקבצים עם השחרור.

**כל אחד יכול לבדוק שחרור:**

```bash
npm run release:verify                      # החתימות + כל קובץ מול SHA256SUMS
# או בכלים הרגילים:
minisign -Vm SHA256SUMS -P <המפתח הציבורי מ-security/release-key.pub>
sha256sum -c SHA256SUMS
```

החתימות הן minisign רגיל (Ed25519 על BLAKE2b-512), שנעשות עם ההצפנה המובנית
של Node — בלי חבילה נוספת.

## ‏OpenSSF Best Practices

את [תג OpenSSF Best Practices](https://www.bestpractices.dev) מבקש בעל
הפרויקט. מה התג דורש, ואיפה זה נמצא:

| דרישה | כאן |
|---|---|
| מאגר ציבורי, רישיון, מסמכי תרומה ודיווח אבטחה | `LICENSE`, ‏`CONTRIBUTING.md`, ‏`SECURITY.md` |
| ניהול גרסאות, גרסה ייחודית לכל שחרור, הערות שחרור | תגיות git, ‏`CHANGELOG.md`, ‏`RELEASE.md` |
| בדיקות אוטומטיות ומדיניות בדיקות לקוד חדש | vitest ו-Playwright; ‏Definition of done לכל משימה |
| ניתוח סטטי וסריקת תלויות | ‏ESLint, ‏CodeQL, ‏`npm audit`, ‏`cargo audit`, ‏gitleaks (`.github/workflows/security.yml`) |
| ניתוח דינמי (fuzzing) | `npm run fuzz` |
| שחרורים חתומים, בנייה שחוזרת על עצמה | `npm run release:sign` / `release:verify`, ‏`npm run repro` |
| תהליך דיווח פגיעויות עם זמני תגובה | `SECURITY.md` (אישור תוך 48 שעות, לוח זמנים לתיקון תוך 5 ימי עבודה, חשיפה אחרי 90 יום) |
