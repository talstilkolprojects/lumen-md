---
title: שרשרת האספקה: איך גרסה נבנתה, ומי פרסם אותה
description: לכל קובץ בגרסה של lumen-md יש SLSA provenance חתום בידי מארח הבנייה, וחתימת Sigstore בלי מפתח מההתחברות של טל עצמו. פקודה אחת בודקת את שניהם, גם בלי רשת.
---

חתימת minisign‏ (W1.27) מוכיחה איזה מפתח חתם על קובץ. היא לא אומרת איך
הקובץ נבנה. משימה W7.22 מוסיפה לכל קובץ בגרסה שתי הוכחות נפרדות, בלי GitHub
Actions:

1. **איך הוא נבנה.** `provenance.intoto.jsonl` הוא in-toto Statement v1 עם
   predicate של SLSA v1 provenance:
   - כל קובץ בגרסה וה-sha256 שלו
   - הקומיט של lumen-md שממנו נבנה, והאם העץ היה נקי
   - ה-digest של `package-lock.json` ושל `Cargo.lock`
   - הפקודה, מארח הבנייה, זמני ההתחלה והסיום

   מארח הבנייה חותם עליו (DSSE, ‏Ed25519). **מדיניות** קובעת באילו מפתחות של
   מארחים לבטוח, וטל חותם על המדיניות במפתח אחר. לכן מארח בנייה שנפרץ לא יכול
   לערוב לעצמו.
2. **מי פרסם אותו.** לכל קובץ יש `<file>.sigstore.json`, חבילת Sigstore בלי
   מפתח. טל חותם מההתחברות שלו בדפדפן, ו-Fulcio מנפיק תעודה ל-10 דקות לזהות
   הזו. החתימה נרשמת ב-Rekor, יומן השקיפות הציבורי של Sigstore. אין מפתח פרטי
   ארוך-טווח שיכול לדלוף.

## בדיקת קובץ שהורדתם

עם [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) (גרסה 3.0.4 ומעלה):

```bash
cosign verify-blob Lumen_0.2.0-beta.1_aarch64.dmg \
  --bundle Lumen_0.2.0-beta.1_aarch64.dmg.sigstore.json \
  --certificate-identity <the identity in security/sigstore-identity.json> \
  --certificate-oidc-issuer https://github.com/login/oauth
```

עם Node (כל התקנה: הבדיקה משתמשת במאמת של Sigstore שמגיע בתוך npm). היא
בודקת את שתי ההוכחות, לקובץ אחד או לתיקיית הורדה שלמה:

```bash
node scripts/supply-chain/verify.mjs ~/Downloads/lumen-0.2.0-beta.1/
```

הבודק יוצא עם קוד שונה מאפס אם השתנה בייט כלשהו בקובץ כלשהו. הוא גם דוחה:

- חתימה של זהות אחרת, או חבילה שהועתקה מקובץ אחר
- provenance חתום במפתח שהמדיניות לא בוטחת בו, או מדיניות חתומה במפתח אחר
- בנייה מעץ עם שינויים שלא נשמרו בקומיט, או ממארח שהמדיניות לא מונה

**בלי רשת:** מעבירים `--trusted-root trusted_root.json`. הקובץ הזה הוא שורש
האמון של Sigstore, שנשמר קודם עם `cosign trusted-root create` או בבדיקה
מקוונת קודמת. cosign רץ אז עם `--offline`.

cosign ישן מ-3.0.4 נדחה: הוא עלול לקבל חבילה שרשומת ה-Rekor שלה שייכת לקובץ
אחר ([GHSA-whqx-f9j3-ch6m](https://osv.dev/GHSA-whqx-f9j3-ch6m)).

## איך גרסה נוצרת

1. **במארח הבנייה** (המכונה של מפעל האימות, W6.5): הגרסה נבנית תחת
   `attest.mjs`.
   - הסקריפט כותב את ה-provenance וחותם עליו במפתח של המארח, שלא יוצא מהמכונה.
   - כש-[Witness](https://witness.dev) מותקן (`scripts/supply-chain/install-tools.sh`,
     גרסאות נעוצות שנבדקות מול קובצי ה-checksum של הגרסה שלהן), הבנייה רצה
     גם תחת `witness run --step build -a slsa`. ה-attestation של Witness נשמר
     ל-`witness verify`‏ (`verify.mjs --witness`).

   ```bash
   node scripts/supply-chain/attest.mjs --out release -- <the release build: W4.5's release command, #492>
   ```
2. **ב-Mac של טל:** `bash scripts/supply-chain/sign.sh release/`.
   - התחברות אחת בדפדפן לכל קובץ. חבילה לכל קובץ, כולל ה-provenance.
   - אחר כך `verify.mjs` בודק את כל התיקייה.
3. **שער הפרסום.** `verify.mjs release/ --commit <the tag's commit>` חייב לצאת
   עם 0 לפני שמשהו מתפרסם. לכן ה-`latest.json` של העדכון האוטומטי מונה רק
   קבצים שעברו את שתי הבדיקות. מנגנון העדכון של אפליקציית שולחן העבודה שומר
   על בדיקת ה-minisign שלו (W4.5).

חבילת ה-npm של ה-SDK לתוספים מתפרסמת ידנית עם אותם שני קבצים. ה-trusted
publishing וה-provenance האוטומטי של npm עובדים רק מ-GitHub Actions, מ-GitLab
ומה-runners בענן של CircleCI, לא מהמכונה שלנו
([npm: trusted publishers](https://docs.npmjs.com/trusted-publishers)).

### Build type v1

ה-`buildType` ב-provenance הוא הכתובת של הסעיף הזה. הפרמטרים שלו:

- `externalParameters.command`: פקודת הגרסה
- `externalParameters.source`: הריפו והקומיט שלו
- `internalParameters`: גרסת Node, הפלטפורמה והאם העץ היה מלוכלך
- `resolvedDependencies`: הקומיט, ואחריו ה-sha256 של קובצי הנעילה
- `byproducts`: ה-sha256 של יומן הבנייה

## SLSA Build L2, דרישה אחר דרישה

| דרישה | איך lumen-md עומד בה | ראיה |
|---|---|---|
| יש provenance‏ (L1) | `attest.mjs` כותב in-toto Statement v1 עם predicate של SLSA v1, ‏subject לכל קובץ | `verify.mjs`; ‏`supplyChainProvenance.test.ts` |
| ה-provenance שלם | build type, הפקודה, קומיט המקור, ה-digest של קובצי הנעילה, הבונה | המדיניות בודקת build type, בונה ומקור |
| פלטפורמת בנייה מתארחת (L2) | הגרסה נבנית במארח של המפעל, לא במחשב נייד; מזהה הבונה מציין את המארח | בנייה ממארח שהמדיניות לא מונה נכשלת |
| ה-provenance אותנטי (L2) | DSSE חתום במפתח של המארח (0600, רק במארח); המדיניות שבוטחת בו חתומה במפתח אחר | `verify.mjs` נכשל על מפתח אחר, על בייט ששונה, ועל מפתח מדיניות שהוא גם מפתח בנייה |
| ה-provenance מופץ | ה-provenance והחבילות הם קבצים בגרסה; הדף הזה מראה את הפקודות | תיקיית הגרסה |
| זהות המפרסם (מעבר ל-SLSA) | Sigstore בלי מפתח מההתחברות של טל; הזהות וה-issuer נעוצים ב-`security/sigstore-identity.json` | `cosign verify-blob --certificate-identity … --certificate-oidc-issuer …` |

## ההגדרה של הבעלים (פעם אחת)

1. **מפתח המדיניות** ב-Mac. שומרים בקומיט את החצי הציבורי בתור `security/provenance-policy.pub`:

   ```bash
   node scripts/supply-chain/policy.mjs keygen --out ~/.config/lumen-md/policy-ed25519.pem
   ```
2. **המדיניות**, חתומה ב-Mac עם המפתח הציבורי של מארח הבנייה. המפעל שומר אותו
   בקומיט בתור `keys/oracle-a1.pem` ב-`lumen-md-receipts`. שומרים בקומיט את
   המדיניות בתור `security/provenance-policy.dsse.json`, וחותמים שוב לפני
   שהיא פגה (365 יום):

   ```bash
   node scripts/supply-chain/policy.mjs sign --key ~/.config/lumen-md/policy-ed25519.pem --build-key oracle-a1.pem --builder oracle-a1
   ```
3. **הזהות.** מריצים `brew install cosign`, ואז חותמים על קובץ ניסיון אחד עם
   `cosign sign-blob --bundle t.sigstore.json t`. כותבים את האימייל שההתחברות
   מציגה ב-`security/sigstore-identity.json`‏ ("identity"). עד אז `verify.mjs`
   ו-`sign.sh` מסרבים לרוץ ומציינים את ה-placeholder בשמו.
4. **במארח הבנייה:** `sudo bash scripts/supply-chain/install-tools.sh`. רושמים
   ב-PR את ערכי ה-sha256 שהוא מדפיס.

## נבדק בלי רשת

`npm run supply:selftest` מריץ את כל השרשרת על המכונה הזו:

- המדיניות, והבנייה תחת `attest.mjs`
- החתימה דרך `sign.sh`
- ‏11 מקרים שחייבים להיכשל, 9 מהם ב-`verify.mjs`

בדיקת ה-Sigstore היא האמיתית, ‏`@sigstore/verify` מתוך npm. היא בודקת:

- את שרשרת התעודות ואת ה-SCT המוטמע
- את הבטחת ההכללה של Rekor, ואת הוכחת ההכללה עם ה-checkpoint החתום שלה
- את החתימה ואת הזהות

את השירותים של Sigstore משחק `sigstore-local.mjs` עם מפתחות ניסיון. Witness
והתחברות אמיתית ל-Fulcio ירוצו לראשונה במארח וב-Mac האמיתיים.
