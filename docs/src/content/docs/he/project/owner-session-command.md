---
title: פקודת ישיבת הבעלים
description: פקודה אחת לכל ישיבת בעלים. היא מציגה בדיוק מה לעשות בדפדפן, מריצה בשבילך את הפקודות אחרי שאלה, בודקת את התוצאה דרך ה-API-ים, רושמת קבלה חתומה לכל צעד וממשיכה מאיפה שעצרת.
---

משימה W6.20. [ישיבות הבעלים](/he/project/owner-sessions/) כפקודה:

```bash
npm run owner:session -- accounts    # ישיבה 1: חשבונות, מפתחות ומתגים (כל מחשב)
npm run owner:session -- gpu         # ישיבה 2: מודלים ונתונים (GPU בענן, ה-Mac כגיבוי)
npm run owner:session -- devices     # ישיבה 3: מכשירים, שחרורים ומיזוג
npm run owner:session -- status      # מה נעשה, דקות משוערות מול דקות בפועל
npm run owner:session -- check       # רק הבדיקות האוטומטיות: בלי שאלות ובלי רישום
npm run owner:session -- collect     # כל פקודות הבעלים ב-PR-ים הפתוחים, בלי כפילויות ועם שיוך
```

כל צעד עובד כך:

1. הוא מציג מה עושים, עם העמוד המדויק לפתוח.
2. הוא מציע את הפקודות שלו (למשל `gh label create …` או הגדרת Vercel), ומריץ כל אחת רק אחרי שענית כן. ‏`--yes` מריץ אותן בלי לשאול.
3. כשלוחצים Enter, הוא בודק את התוצאה:
   - אוטומטית, איפה ש-API, קובץ או פקודה יכולים לדעת: ‏GitHub דרך `gh api`, ה-REST של Vercel עם ה-`VERCEL_TOKEN` שלך, ‏Hugging Face, ‏BrowserStack, ‏Kaggle, ‏`wrangler`, ‏`gcloud`, ‏ssh או `oci` ל-VM של המפעל, השחרור ב-GitHub
   - בשאלת כן/לא, איפה שרק העיניים שלך יכולות לדעת. התשובה נרשמת כהצהרה.
4. הוא רושם קבלה חתומה לצעד.

צעד עם בדיקה פתוחה נרשם כפתוח. ההרצה הבאה מתחילה שוב בצעד הזה ומוסיפה את הדקות. צעד שהושלם מדולג (`--redo <step>` מריץ אותו שוב). אנגלית: ‏`--lang en`.

## הצעדים

14 פריטי בעלים בשלוש ישיבות (W6.20 מבקשת 15 לכל היותר). לכל צעד יש לפחות בדיקה אוטומטית אחת: ‏41 בדיקות אוטומטיות ו-18 תשובות כן/לא.

| צעד | דק׳ | מה | בדיקות אוטומטיות | כן/לא שלך |
|---|---|---|---|---|
| `accounts/github` | 15 | למזג את #432, להפעיל את ההגנות של GitHub ואת ה-Ignored Build Step של Vercel ‏(W6.10, ‏W6.12) | merged-432, label, private-vulnerability-reporting, secret-scanning, ignored-build-step | — |
| `accounts/vercel-hf` | 15 | מפתחות VITE_ שדלפו (15.18), הטוקן והזרע של Hugging Face, תנאי הנתונים | no-secret-vite, hf-token, golden-seed, flores-terms | common-voice-terms |
| `accounts/signing` | 20 | חשבונות ומפתחות חתימה (אימות החנויות לוקח ימים: להתחיל עכשיו) | updater-key, release-key, android-keystore, asc-key | apple-enrolled, play-console, windows-signing |
| `accounts/test-clouds` | 15 | עננים חינמיים לבדיקות: ‏BrowserStack ‏(Safari, ‏iOS), ‏Firebase Test Lab ‏(Android), ‏Kaggle ‏(GPU) | browserstack, firebase, kaggle | — |
| `accounts/hosts` | 20 | מארחים: ‏Cloudflare Pages והמראה של המודלים, ‏Fly לשרת האיתות ול-relay | wrangler, pages-project, pages-live, mirror-env, signaling, relay-env | — |
| `accounts/factory` | 25 | מפעל האימות על ה-VM החינמי של Oracle | vm-timer, receipts-repo, first-status | — |
| `gpu/models-day` | 20 | יום המודלים האמיתי על ה-GPU החינמי של Kaggle (ה-Mac רק כגיבוי), עם הסטים המוחזקים | heldout-key, eval-branch | — |
| `gpu/golden` | 60 | החלק שלך בסטי הזהב (שעה עכשיו, והשאר על פני כמה ימים) | recordings | text-sets, image-ratings |
| `gpu/archives` | 30 | הארכיונים והספריות שלך: דואר, שיחות, ‏Zotero | zotero-key | mail, chats, zotero |
| `gpu/cargo-zip` | 20 | הייעוץ הקריטי של zip ב-Cargo ועדכוני npm שדורשים התקנה אמיתית | zip-9, known-bad | — |
| `devices/manual-checks` | 60 | מה שרק עיניים וידיים בודקות: ‏Safari, ‏Word, הטלפון, קוראי מסך | safari-receipt | safari-checklist, word-rtl, share-sheet, phone, screen-readers |
| `devices/desktop-release` | 60 | שולחן עבודה: הבנייה ה-native, ‏beta.1 ותרגיל העדכון ל-beta.2, חבילות החנויות, ביקורת הפרטיות | beta1, beta2, bundle, privacy-audit | update-drill, packages |
| `devices/mobile` | 45 | מובייל: בניות חתומות ל-Android ול-iOS לבדיקה פנימית, וריצת robo ב-Firebase | aab, robo | internal-testing |
| `devices/live-and-merge` | 25 | למזג את הרכבות בסוף, ואז לבדוק את האתר החי ולבקש סריקה מחדש | train-merged, security-md, live-meta | recrawl |

ההערכה לישיבה 1 היא 110 דקות. הזמן האמיתי של כל צעד נכנס לקבלה שלו, ו-`status` מציג את שניהם זה לצד זה.

## מה הבדיקות צריכות

מגדירים אותם במעטפת שמריצה את הפקודה. בדיקה שחסר לה טוקן מדפיסה "cannot check" ומשאירה את הצעד פתוח. היא אף פעם לא נספרת כעוברת.

| משתנה או כלי | בשביל |
|---|---|
| `gh auth login` | הבדיקות והמתגים של GitHub |
| `VERCEL_TOKEN` ‏(vercel.com ← Account Settings ← Tokens; אפשר גם `VERCEL_TEAM_ID`, ‏`VERCEL_PROJECT`) | ה-Ignored Build Step ומשתני הסביבה |
| `HF_TOKEN` | התנאים של FLORES+ (קובץ מוגן יורד) |
| `BROWSERSTACK_USERNAME`, ‏`BROWSERSTACK_ACCESS_KEY` | ‏BrowserStack Automate |
| `~/.kaggle/kaggle.json` (הרשאה 600) או `KAGGLE_USERNAME` + `KAGGLE_KEY` | ‏Kaggle |
| `gcloud`, ‏`npx wrangler@4`, ‏`cargo` | ‏Firebase Test Lab, ‏Cloudflare, הייעוץ של zip |
| `LUMEN_FACTORY_VM=ubuntu@<ip>` ‏(ssh), או `oci` + `OCI_COMPARTMENT` | הטיימר הלילי של המפעל |
| `LUMEN_GOLDEN_DIR`, ‏`ZOTERO_API_KEY` | ספירת ההקלטות, המפתח של Zotero |

## קבלות

כל צעד כותב `reports/owner/<session>/<step>.json` בפורמט החתום של קבלות הלילה ושל קורא הקבלות של התוכנית: ‏JSON קנוני, ‏sha256 וחתימת Ed25519.

- בקבלה נרשמים: הקומיט שהרצת עליו, זמני ההתחלה והסיום, הדקות המשוערות ובפועל, קוד היציאה של כל פקודה, ותוצאת כל בדיקה (תשובות ההצהרה מסומנות).
- המפתח נוצר בהרצה הראשונה ב-`~/.config/lumen-md/owner-ed25519.pem` (הרשאה 600; ‏`LUMEN_OWNER_KEY` גובר). החצי הציבורי שלו הוא `reports/owner/PUBLIC_KEY.pem`.
- קבלה ששונתה ביד כבר לא מאומתת, והיא מתעלמים ממנה.
- בסוף, הפקודה מדפיסה את שורת `git add -f reports/owner …` שמכניסה את הקבלות ל-commit.

לוח ״עובד אצל משתמש״ (W6.44) קורא אותן. למשל, ‏`accounts/github` ← `secret-scanning` הוא ראיה לתחום פרטיות ואבטחה.

## איסוף פקודות הבעלים

`collect` קורא את סעיפי הבעלים של כל PR פתוח:
- הכותרות שהוא קורא: "Owner commands", ‏"Owner steps", ‏"Owner items" ו-"The owner's … step"
- כל פקודה היא שורה בבלוק shell, פקודה בתוך הטקסט, או תבליט של משימה
- הוא מאחד כפילויות בין PR-ים ומשייך כל אחת

כל פקודה משויכת לאחד מאלה:

| משויך ל | פירוש |
|---|---|
| צעד | הצעד שמטפל בה |
| agent | ריצת בדיקה או בנייה שסוכנים עושים במארח השני |
| recurring | לולאה לכל רכבת או מיזוג (pr:check, ‏restack, בניית רכבות) |
| coordinator | שינוי שמסלול עושה ב-PR |
| people | צריך אנשים אחרים (מדרגים, דוברים, מתחזק שני) |
| deferred | אופציונלי ונדחה (15.5) |
| obsolete | ריצת GitHub Actions (הפרויקט לא משתמש ב-Actions) |
| none | הסעיף אומר שלא צריך כלום |

פקודה שלא שויכה, או פריט בעלים בתוכנית (15.x) שאף צעד לא נושא ושלא מופיע ברשימת מה שירד מהרשימה, גורמים ל-`collect` לצאת עם 1. כך פקודת בעלים חדשה לא יכולה להתפספס. ‏`collect --write` שומר את התוצאה ב-`scripts/owner/inbox.json`.

ב-12.11.2026: ‏375 PR-ים פתוחים, ל-79 יש סעיף בעלים, ‏236 פריטים שונים:
- ‏149 ב-14 הצעדים
- ‏58 לסוכנים
- ‏20 חוזרים
- ‏4 לרכז
- ‏2 שצריכים אנשים אחרים
- ‏1 נדחה, ‏1 מיושן, ‏1 ״אין״
- ‏0 בלי שיוך

כל 18 פריטי הבעלים בתוכנית מכוסים: 13 בצעדים ו-5 שירדו מהרשימה.
