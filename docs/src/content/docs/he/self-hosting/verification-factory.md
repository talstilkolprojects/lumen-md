---
title: מפעל האימות
description: מכונה שנייה בחינם שמריצה כל לילה את כל הבדיקות של כל ראש verify/*‏ ב-Chromium, ‏Firefox ו-WebKit, חותמת קבלה לכל קומיט ומדווחת ל-GitHub כ-commit status, בלי GitHub Actions.
---

Lumen לא משתמש ב-GitHub Actions. עד עכשיו כל בדיקה אמיתית הייתה תלויה
במשבצת בנייה שכורה אחת (Vercel Hobby) ובסביבת Sandbox שחסומה עד דצמבר.
מפעל האימות (משימה W6.5) הוא מכונה משלנו, שמריצה כל לילה את הריצה המלאה:

- כל חבילת vitest בשני רסיסים, כולל החבילות האיטיות שרצות רק בלילה
- כל ספֵּק e2e ב-**chromium, ‏firefox ו-webkit**, ארבעה רסיסים לכל דפדפן
- תרגיל בטיחות הנתונים (#470, הסקריפט `drill:data-safety`) ו-`cargo check` של
  מעטפת הדסקטופ, כשהם קיימים בקומיט; ובימי ראשון גם ריצת mutation
- החבילות שהרתמות ה-offline לא מריצות (`e2eeUi`, ‏`pdfReader`,
  ‏`dictationLocal`, ‏`vaultEncryption`): הקבלה מציינת כל אחת מהן בשמה,
  ו-vitest נכשל אם אחת מהן לא רצה

כל ראש של `verify/*` מקבל **קבלה חתומה** אחת לקומיט המדויק שלו, במאגר
הציבורי `talstilkol/lumen-md-receipts`. הוא מקבל גם commit status אחד לכל
חבילה (`lumen/factory: e2e webkit` וכן הלאה), עם קישור לקבלה. ראש שלא
השתנה מאז הריצה הקודמת מקבל "דופק" שמפנה לקבלה של אותו קומיט בדיוק. ראיה
לא עוברת אף פעם לקומיט אחר. בכל יום ראשון ראשים שלא השתנו רצים שוב, כדי
לתפוס בדיקות לא יציבות.

## המארח: Oracle Cloud Always Free, ‏Ampere A1

נבדק ב-12 בנובמבר 2026 מול הדפים של כל ספק.

| | מה מקבלים ב-0$ | החלטה |
|---|---|---|
| **Oracle Cloud Always Free, ‏Ampere A1** | ‏1,500 שעות OCPU ו-9,000 שעות GB בחודש = **‏2 OCPU‏ (arm64) ו-12 GB**, דולקת תמיד; ‏200 GB אחסון; ‏10 TB תעבורה יוצאת בחודש | **נבחר.** מכונת Ubuntu 24.04 קבועה, בלי הגבלת זמן. ל-Playwright יש אימג׳ Docker ל-arm64 עם שלושת הדפדפנים. |
| Buildkite Free | עד 5 משתמשים, **‏10 משימות במקביל על סוכנים שלנו**, ‏2,000 דקות vCPU של Linux מתארח בחודש, שמירה 30 יום | מתזמר ולא מכונה: הסוכנים שלו עדיין צריכים מארח. אפשר להוסיף אותו מעל המארח הזה בהמשך (W7.21). ‏2,000 דקות מתארחות הן כ-66 דקות ללילה, פחות מריצה מלאה אחת. |
| ה-Mac של טל (launchd) | מה שיש ב-Mac | **הגיבוי.** אותו סקריפט מתקין LaunchAgent. הוא רץ רק כשה-Mac דלוק. |
| GitLab for Open Source | ‏Ultimate עם 50,000 דקות חישוב | לא נבחר: דורש בקשה, קבוצה ב-GitLab וחידוש שנתי, וה-namespace "לא יכול לחתור לרווח". |
| GitHub Actions | — | כלל של הבעלים: לא בשימוש. |

**תנאים שחשוב לדעת:**

- ביוני 2026 Oracle חתכה בחצי את מכסת ה-Ampere החינמית: מ-4 OCPU ו-24 GB
  ל-2 OCPU ו-12 GB. יש מדריכים שעדיין מצטטים את המספרים הישנים.
- Oracle לוקחת בחזרה מכונה חינמית שהייתה בטלה במשך 7 ימים: אחוזון 95 של
  ה-CPU מתחת ל-20%, רשת מתחת ל-20%, ובמכונות A1 גם זיכרון מתחת ל-20%.
  ריצת לילה של כשעתיים שומרת את אחוזון 95 של ה-CPU מעל הסף.
- צורת ה-Ampere החינמית קיימת רק ב**אזור הבית** של החשבון. בוחרים אותו
  בהרשמה ואי אפשר לשנות אותו. באזורים פופולריים מופיעה לעיתים קרובות
  ההודעה "Out of host capacity". נסו availability domain אחר, או נסו שוב
  מאוחר יותר.
- כדאי להישאר בחשבון Always Free. שדרוג ל-Pay As You Go מגן על המכונה
  מפני לקיחה, אבל אז כל מה שמעל המכסה החינמית מחויב.

מקורות: docs.oracle.com/iaas/Content/FreeTier/resourceref.htm (משאבי
Always Free ולקיחת מכונות בטלות), ‏linuxiac.com (השינוי של יוני 2026),
‏buildkite.com/pricing, ‏about.gitlab.com/solutions/open-source/join,
‏playwright.dev/docs/intro (‏Ubuntu 22.04/24.04/26.04 על x86-64 או arm64),
והקובץ `utils/docker/publish_docker.sh` של Playwright (אימג׳ים ל-amd64
ול-arm64).

**מהירות, הערכה שעוד לא נמדדה:** עם 2 OCPU, ה-e2e המלא בשלושה דפדפנים
(כ-330 בדיקות לכל דפדפן) צפוי לקחת 90–110 דקות. היעד בתוכנית הוא פחות
מ-60. אם הלילות הראשונים יאשרו את ההערכה, מעבירים דפדפן אחד ל-Mac
(`LUMEN_FACTORY_HOST=mac`, עם מפתח משלו), או מוסיפים סוכני Buildkite
(W7.21).

## הצעד האחד של הבעלים (כ-25 דקות, פעם אחת)

**בדפדפן:**

1. הרשמה ל-Oracle Cloud ‏(cloud.oracle.com, ‏"Start for free"). מבקשים
   כרטיס אשראי לאימות זהות. על משאבי Always Free לא מחייבים.
2. ‏*Compute → Instances → Create instance*: אימג׳ **Canonical Ubuntu 24.04
   (aarch64)**, צורה **VM.Standard.A1.Flex** עם **‏2 OCPU ו-12 GB**, דיסק
   אתחול 100 GB, כתובת IPv4 ציבורית, והמפתח `~/.ssh/id_ed25519.pub` שלך.
   רשמו את ה-IP הציבורי.
3. ב-GitHub: ‏*Settings → Developer settings → Fine-grained tokens → Generate
   new token*. שם `lumen-factory`, בעלים `talstilkol`, תוקף שנה,
   **Only select repositories: talstilkol/lumen-md**, והרשאת מאגר
   **Commit statuses: Read and write**. שום דבר אחר. העתיקו את הטוקן.

**ואז הדבקה אחת בטרמינל של ה-Mac** (‏gh כבר מחובר שם):

```bash
VM=ubuntu@<the VM's public IP>
gh repo create talstilkol/lumen-md-receipts --public --add-readme --description "Signed nightly test receipts of lumen-md (plan W6.5)"
ssh-keygen -q -t ed25519 -N "" -C lumen-factory -f /tmp/lumen-factory-key
gh repo deploy-key add /tmp/lumen-factory-key.pub --repo talstilkol/lumen-md-receipts --allow-write --title lumen-factory
printf 'Paste the github_pat_ token: '; read -rs TOKEN; echo
curl -fsSL https://raw.githubusercontent.com/talstilkol/lumen-md/chore/verify-factory/scripts/factory/bootstrap.sh -o /tmp/lumen-bootstrap.sh
scp /tmp/lumen-bootstrap.sh "$VM":/tmp/
{ printf '%s\n' "$TOKEN"; cat /tmp/lumen-factory-key; } | ssh "$VM" 'sudo bash /tmp/lumen-bootstrap.sh --secrets-stdin --run-now'
rm -f /tmp/lumen-factory-key /tmp/lumen-factory-key.pub; unset TOKEN
```

אחרי שהענף ימוזג, כותבים `main` במקום `chore/verify-factory` בכתובת
ומוסיפים `--branch main`.

הטוקן והמפתח עוברים בקלט הסטנדרטי של ssh, אף פעם לא כארגומנט בשורת
הפקודה. במכונה הם נשמרים בהרשאה 0600, ורק המשתמש `lumen` יכול לקרוא
אותם. מפתח ה-deploy יכול לכתוב רק למאגר הקבלות. הטוקן יכול רק לפרסם
commit status ב-lumen-md, ולא לדחוף קוד. לכן הקבלות נמצאות במאגר נפרד:
טוקן שיכול לכתוב קבלות ל-lumen-md יכול לדחוף גם ל-`main`, ול-`main` אין
הגנת ענף.

הסקריפט עושה את השאר:

1. מתקין Docker (‏`docker.io` של Ubuntu), ‏git, ‏gh ו-Node 22
2. יוצר משתמש `lumen`, ובמכונה של 12 GB גם קובץ swap של 4 GB
3. שומר את הטוקן ואת מפתח ה-deploy
4. משכפל את קוד המפעל ואת מאגר הקבלות, ויוצר את מפתח החתימה Ed25519
   (`~/.config/lumen-md/nightly-ed25519.pem`, הרשאה 0600)
5. כותב את `/etc/lumen-factory/env`
6. מתקין טיימר systemd לשעה 01:17 שעון ישראל. הטיימר persistent: לילה
   שהוחמץ כשהמכונה הייתה כבויה רץ באתחול הבא.
7. בודק שמאגר הקבלות עונה, שהטוקן רואה את המאגר, ש-Docker רץ ושהמפעל
   יודע לתכנן לילה

‏`--run-now` מתחיל את הלילה הראשון מיד. רואים אותו עם
`journalctl -u lumen-factory -f`.

### על ה-Mac במקום זה (הגיבוי)

מריצים את אותו סקריפט בלי sudo, עם אותם סודות בקלט:
`{ printf '%s\n' "$TOKEN"; cat /tmp/lumen-factory-key; } | bash /tmp/lumen-bootstrap.sh --secrets-stdin`.
ב-Mac הסקריפט בודק שיש node, ‏git ו-gh (‏`brew install node gh`). הוא
מריץ את השלבים ישירות, בלי Docker, ומתקין את ה-LaunchAgent
`dev.lumen-md.factory`. ‏launchd מריץ לילה שהוחמץ בזמן שה-Mac ישן ברגע
שהוא מתעורר. ה-Mac חותם במפתח משלו, `keys/mac.pem`.

## מה לילה כותב

במאגר `talstilkol/lumen-md-receipts`:

| נתיב | מה |
|---|---|
| `commits/<sha>/full-<time>.json` | הקבלה החתומה של ריצה מלאה אחת: כל שלב עם קוד היציאה, משך הזמן, ‏sha256 של הפלט והשורות האחרונות שלו; התוצאה לכל חבילה; חבילות החובה; הבדיקות שנכשלו, וה-PR שהיה האחרון לשנות כל קובץ שנכשל |
| `nights/<date>.json` | הרשימה החתומה של הראשים באותו לילה: רץ, לא השתנה (עם הקבלה של אותו קומיט), או נדחה להמשך |
| `nights/<date>.md` | דוח הבוקר: מה נכשל, מאיזה PR, ומה השתנה מאז הדוח הקודם של אותו ענף |
| `keys/<host>.pem` | החצי הציבורי של מפתח החתימה של כל מארח |

בדיקת קבלה מכל מקום:
`npm run nightly -- --verify commits/<sha>/full-….json`. בדיקת ה-digest
עובדת תמיד. לבדיקת החתימה מעתיקים את המפתח של אותו מארח ל-
`reports/nightly/PUBLIC_KEY.pem`. מספר ששונה שובר את שתיהן.

## פקודות

```bash
npm run factory:run -- --dry-run            # list the heads and what would run tonight
npm run factory:run -- --only verify/train --rerun --max 1
npm run factory:run -- --no-push --no-status   # keep everything on this machine
npm run factory:selftest                    # the bootstrap and a whole night, with Docker, npm and gh emulated
```

בדיקת העצמי מריצה את סקריפט ההתקנה האמיתי ואת `run.mjs` האמיתי, כולל
החתימה והבדיקה שלה, מול מאגרים מקומיים שמחליפים את האמיתיים. ‏Docker,
‏npm, ‏gh, ‏systemd ו-launchd מוחלפים בתוכניות קטנות שרושמות מה התבקשו
לעשות. כך היא מראה שהסקריפטים מחוברים נכון. על האימג׳ האמיתי, על
הדפדפנים ועל חבילת הבדיקות היא לא מראה כלום. אלה ירוצו בלילה האמיתי
הראשון.
