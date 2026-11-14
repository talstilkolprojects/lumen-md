---
title: שחרור גרסה
description: פקודה מקומית אחת בונה, חותמת ובודקת שחרור, ועם ‎--publish מעלה אותו ל-GitHub Releases עם עדכוני שולחן עבודה חתומים. בלי GitHub Actions.
---

שחרור הוא פקודה אחת במחשב של מי שמשחרר. לא צריך GitHub Actions.

```bash
npm run release -- 0.2.0-beta.1 --dry-run     # בונה, חותמת ובודקת הכול; לא מפרסמת כלום
npm run release -- 0.2.0-beta.1 --publish     # הבעלים: commit, תג, בנייה, חתימה, push, שחרור ב-GitHub
```

בסוף הרצת ניסיון (dry run) עץ העבודה חוזר למצבו הקודם: הגרסה,
`CHANGELOG.md` ו-`src-tauri/tauri.conf.json` חוזרים למה שהיו. בתיקייה
`release/` נשארים כל קובצי השחרור, וגם `release/DRY-RUN.md` עם רשימת הקבצים
והפקודות המדויקות ש-`--publish` היה מריץ.

## מה הפקודה עושה

1. **בדיקה מקדימה.** הפקודה מציגה כל מה שחסר (מפתח, כלי, הערות שחרור, עץ
   נקי, ענף `main`, ‏`gh auth`), ולצד כל פריט את הפקודה שמתקנת אותו. הרצת
   ניסיון לא צריכה מפתחות. פרסום צריך את כולם.
2. **גרסה ויומן שינויים.** הגרסה מתעדכנת ב-`package.json`,
   ‏`package-lock.json`, ‏`tauri.conf.json`, ‏`Cargo.toml` ובפרויקט ה-iOS.
   הסעיף ב-`CHANGELOG.md` נכתב מה-PR-ים שמוזגו מאז התג האחרון: שורה לכל
   PR, ממוינת לפי הסוג שבכותרת שלו (Added, ‏Fixed, ‏Performance, …), עם קישור
   ל-PR. הכותרות מגיעות מ-GitHub API; בלי רשת (`--offline`) הפקודה משתמשת
   ב-merge commits.
3. **commit ותג** (רק עם `--publish`): ‏`chore(release): X` ו-`vX`.
4. **המעדכן.** ב-`tauri.conf.json` השמור במאגר יש placeholder:
   ‏`${LUMEN_UPDATER_PUBKEY}`. השחרור ממלא את המפתח הציבורי ואת כתובת העדכון
   ב-GitHub Releases (יציב: `releases/latest/download/latest.json`; בטא: השחרור
   המתגלגל `beta-channel`), ומפעיל חבילות עדכון חתומות. הבנייה נעצרת אם
   המפתח ריק, אם עדיין כתוב בו ה-placeholder, או אם הוא לא מפתח minisign.
   בסוף הקובץ חוזר ל-placeholder.
5. **בניית ווב שחוזרת על עצמה.** ‏`repro-check` בונה פעמיים עם
   `SOURCE_DATE_EPOCH` ומשווה כל קובץ. אחר כך רצות בדיקת תקציב החבילה ובדיקת
   ה-source maps. הקובץ `lumen-web-vX.tgz` יוצא זהה בייט-בבייט בכל מחשב: הקבצים
   ממוינים, הבעלים וההרשאות קבועים, ובכותרת ה-gzip אין זמן.
6. **שולחן עבודה.** ‏`tauri build` רץ עם `TAURI_SIGNING_PRIVATE_KEY`. לשם
   חבילת העדכון של macOS מתווספות הגרסה והארכיטקטורה. ‏`latest.json` נבנה
   מקובצי ה-`.sig`. כל חתימה נבדקת מול מפתח המעדכן, ואותה בדיקה חייבת לדחות
   עותק שהשתנה בו בייט אחד.
   אחר כך `latest.json` עצמו נחתם באותו מפתח מעדכן (`latest.json.sig`, באותו
   פורמט של `.sig` של חבילה). הריצה בודקת את החתימה, ועותק שהשתנה בו בייט אחד
   חייב להידחות. **הריצה מסרבת לפרסם בלי החתימה**: האפליקציה מורידה את
   `latest.json` ואת `latest.json.sig`, מאמתת את החתימה לפני שהיא קוראת משהו
   מה-manifest, ודוחה גרסה שאינה חדשה מהמותקנת ומהגבוהה ביותר שהותקנה אי פעם
   (W11.S2/S3). עם המפתח של הבעלים החתימה היא `tauri signer sign` על הקובץ.
7. **SBOM.** ‏`sbom.cdx.json` (CycloneDX 1.5) מפרט כל חבילה ב-`package-lock.json`
   וכל crate ב-`Cargo.lock`. הוא נבנה בלי רשת.
8. **הערות שחרור.** קודם עברית ואחר כך אנגלית, מתוך
   `release-notes/<version>.he.md` ו-`release-notes/<version>.en.md` (נכתבות
   ביד, כמה שורות כל אחת). אחריהן באה רשימת השינויים המלאה, והסבר איך לאמת
   את ההורדה.
9. **סיכומי ביקורת.** ‏`SHA256SUMS` מפרט כל קובץ. הוא חתום ב-minisign
   (`SHA256SUMS.minisig`), וגם ה-SBOM חתום. אחר כך כל התיקייה נבדקת, ו-`SHA256SUMS`
   שהשתנה חייב להיכשל.
10. **פרסום** (רק עם `--publish`): ‏`git push origin HEAD vX`, ואז
    `gh release create`. בטא היא pre-release ואף פעם לא "latest", ולכן
    משתמשים בגרסה יציבה לא מקבלים אותה. אחר כך `latest.json` עולה לשחרור
    `beta-channel`.

## אפשרויות

| אפשרות | מה היא עושה |
|---|---|
| `--dry-run` | ברירת המחדל: לא נוצרים commit, תג או פרסום |
| `--publish` | השחרור האמיתי (הבעלים) |
| `--fake-build` | רק בהרצת ניסיון: חבילות מדומות כשחסרים `node_modules`, ‏Rust או ה-CLI של Tauri; כל השלבים שאחר כך עדיין רצים. פרסום מסרב לה. |
| `--no-repro` | בניית ווב אחת במקום שתיים |
| `--no-desktop` | רק ווב, SBOM וסיכומי ביקורת |
| `--skip-checks` | בלי typecheck ובלי בדיקות לפני הבנייה |
| `--offline` | כותרות ה-PR מ-git ולא מ-GitHub API |

## מפתחות (נוצרים פעם אחת, אצל הבעלים)

| מפתח | נוצר עם | משמש דרך |
|---|---|---|
| מפתח החתימה של המעדכן | `npx tauri signer generate -w ~/.tauri/lumen-updater.key` | `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) |
| המפתח הציבורי של המעדכן | נכתב לידו (`.key.pub`) | לשמור במאגר בתור `security/updater-key.pub`, או להגדיר `LUMEN_UPDATER_PUBKEY` |
| מפתח השחרור (סיכומי ביקורת, SBOM) | `node scripts/supply-chain/keys.mjs` | `LUMEN_RELEASE_KEY` (+ `LUMEN_RELEASE_PASSPHRASE`); לשמור במאגר את `security/release-key.pub` |

כשחסר מפתח, הרצת ניסיון חותמת במפתחות בדיקה חד-פעמיים ומודיעה על כך.
בשורת ההערה של המפתחות הציבוריים שלהם כתוב `TEST`, ופרסום מסרב להם.

## בדיקת שחרור (כל אחד)

```bash
gh release download v0.2.0-beta.1 --repo talstilkol/lumen-md --dir lumen
cd lumen && minisign -Vm SHA256SUMS -p release-key.pub && sha256sum -c SHA256SUMS
# או בלי minisign:
node scripts/supply-chain/verify-release.mjs lumen --pub security/release-key.pub
```

## מגבלות

- הרצה אחת של `--publish` מעלה את החבילות של המחשב שהיא רצה עליו: חבילות
  macOS מ-Mac. עדיין אי אפשר להוסיף לאותו שחרור חבילות Linux ו-Windows
  ממחשבים אחרים. עד שזה יתאפשר, מפרסמים מה-Mac (וזה כבר נותן לפחות את
  ה-`.dmg`, את חבילת העדכון ואת החתימה שלה, את ה-`.tgz` של הווב ואת ה-SBOM).
- חזרה לגרסה קודמת: `node scripts/release.mjs rollback <bad> --to <good>`
  (ראו `RELEASE.md`).
