---
title: CI ב-Buildkite, בלי GitHub Actions
description: Buildkite Free מתזמן את השערים של lumen-md על המכונות שלנו (המארח של מפעל האימות ו-Mac), ומדווח commit status לכל שער בכל PR, עם קבלה חתומה.
---

Lumen לא משתמש ב-GitHub Actions. מפעל האימות
([הדף שלו](/he/self-hosting/verification-factory/)) בודק כל לילה את ראשי
`verify/*`, אבל ה-PR עצמו לא הראה ✓ או ✗. משימה W7.21 מוסיפה את זה:
**Buildkite Free** מתזמן את העבודות, והסוכנים שלנו מריצים אותן:

- המארח של המפעל (Ubuntu) מריץ כל עבודה באימג׳ של Playwright עצמו (Docker)
- ה-Mac של טל מריץ **WebKit על macOS** בכל בנייה (תור `mac`)

כל שער מדווח commit status משלו ל-GitHub‏ (`lumen/buildkite: <gate>`).
העבודה האחרונה חותמת **קבלה** בפורמט של המפעל.

## מה רץ

הקובץ `.buildkite/pipeline.yml` נוצר מתוך `.github/workflows/ci.yml`. השערים
לא נכתבים פעמיים: כל עבודה ב-Buildkite מריצה את טקסט ה-`run:` המדויק של
הצעדים ב-ci.yml.

| עבודה | הצעדים מ-ci.yml | תור |
|---|---|---|
| `static` | typecheck, ‏hygiene, ‏headers, ‏docs sync, ‏plan, מחרוזות קשיחות, DoD, קבצים לא בשימוש, שלמות התיעוד, סחיפת i18n (כולם רצים, והעבודה נכשלת אם אחד נכשל) | linux |
| `lint`, `licenses` | ESLint עם ה-baseline שלו; שער הרישיונות | linux |
| `build` | בנייה עם סודות הקנרית, שתי סריקות הסודות, תקציב החבילה | linux |
| `vitest` ×4, `vitest-merge` | כל החבילה בארבעה רסיסים מאוזנים לפי זמן, מאוחדים, עם שער הכיסוי של 65% מ-ci.yml | linux |
| `e2e-chromium`, `e2e-firefox` | כל הספֵּקים (Firefox תחת xvfb עם GL בתוכנה, כמו ב-GitHub) | linux |
| `e2e-webkit` | כל הספֵּקים, על macOS | **mac** |
| `e2e-prod`, `e2e-headers`, `local-ai`, `ocr-cer` | כמו ב-ci.yml | linux |
| `lighthouse` | רק ב-main וב-PR-ים עם התווית `lighthouse`, כמו ב-ci.yml | linux |
| `receipt` | הקבלה החתומה, אחרי כל השערים (עברו או נכשלו) | linux |

שלוש משימות נוספות שייכות ל-Buildkite בלבד ואין להן צעד ב-ci.yml (`NATIVE_JOBS` ב-`scripts/buildkite/lib.mjs`). הן רצות בכל בנייה, בלי תנאי:

| משימה | מה היא מריצה | תור |
|---|---|---|
| `pr-check` | ‏`npm run pr:check` על ה-PR עצמו (הבסיס, הגוף והתגובות שלו); בנייה שאינה של PR עוברת | linux |
| `security` | ‏`scripts/security-scan.mjs`: ‏gitleaks, ‏npm audit (גבוה וקריטי), ‏cargo audit עם audit-lock, ‏semgrep עם חוקי קוד פתוח (במקום CodeQL). סורק שחסר בסוכן מכשיל את המשימה | linux |
| `security-nightly` | רק בבנייה המתוזמנת: ‏osv-scanner על כל קובצי הנעילה, ‏cargo deny, ‏OpenSSF Scorecard (צריך `GITHUB_AUTH_TOKEN` לקריאה בלבד) ו-SBOM בפורמט CycloneDX ‏(syft) | linux |

הסוכן צריך `gh` עם טוקן קריאה בשביל `pr-check`, ואת `gitleaks`, ‏`semgrep` ו-`cargo-audit` בשביל `security` (ואת `osv-scanner`, ‏`cargo-deny`, ‏`scorecard` ו-`syft` להרצה הלילית). גם `npm run ci:local` מריץ את gitleaks, ‏semgrep ו-cargo audit כשהם מותקנים.

ב-ci.yml יש צעדים שאינם שערים: התקנות, תגובות ל-PR, מטמון הגדלים של main
ואבחון. כל אחד מהם מופיע עם הסיבה ב-`NOT_GATES` שב-`scripts/buildkite/lib.mjs`.

**אף שער לא יכול להיעלם.** הפקודה `npm run ci:pipeline` נכשלת כש:

- יש ב-ci.yml צעד שה-pipeline לא מריץ ולא מפרט עם סיבה
- צעד שינה את שמו, או שנוסף דפדפן למטריצת ה-e2e
- ה-`pipeline.yml` שבריפו שונה ממה ש-ci.yml נותן
- לעבודה יש `soft_fail`, או ניסיון חוזר אחרי כישלון בדיקה (רק סוכן שאבד מקבל ניסיון חוזר)
- WebKit לא בתור של ה-Mac, או מדולג
- שער לא מדווח סטטוס, או שהקבלה לא מחכה לו

אחרי שינוי ב-ci.yml: `npm run ci:pipeline -- --write`, ולשמור את הקובץ בקומיט.

### רסיסים לפי זמן

`vitest --shard` מחלק לפי מספר קבצים, כך שרסיס אחד יכול לקבל את כל הקבצים
האיטיים. העבודה `vitest-plan` אורזת את הקבצים לפי הזמן שנמדד להם בריצה
הקודמת: הארוך ראשון, כל קובץ לרסיס הקל ביותר. הזמנים נשמרים על המארח מהאיחוד
הקודם. בריצה הראשונה האריזה לפי גודל הקובץ. העבודה `vitest-merge` נכשלת כש:

- קובץ מתוכנן לא רץ, או רץ פעמיים
- חסר דוח של רסיס
- אחת מהחבילות שהרתמות הלא-מקוונות מדלגות עליהן לא רצה או נכשלה

הקבלה רושמת את ההפרש בפועל בין הרסיס הארוך לקצר.

### למה המארח מתחיל את הבניות, ולא ה-webhook של GitHub

בכל קומיט ובכל כותרת PR כאן יש `[skip ci]`, וזה מה ששומר את GitHub Actions
כבוי. Buildkite מדלג על בנייה שהודעת הקומיט או כותרת ה-PR שלה מכילות
`[skip ci]`, ‏`[ci skip]`, ‏`[skip-ci]` או `[ci-skip]`
([Buildkite: skipping builds](https://buildkite.com/docs/pipelines/skipping)).
לכן המארח של המפעל מריץ כל 5 דקות את `scripts/buildkite/trigger.mjs` (טיימר
של systemd). הסקריפט יוצר בנייה דרך ה-REST API של Buildkite לכל ראש חדש של
PR פתוח מהריפו הזה, עם הודעה בלי הסימון.

- ראשים מ-forks לא נבנים אף פעם: הקוד שלהם היה רץ על המכונות שלנו.
- קומיט שכבר יש לו בנייה לא נכנס שוב לתור.
- PR-ים שלא השתנו מאז שהטיימר התחיל נשארים בצד. אפשר להוסיף אותם עם `--backfill N`.

## התוכנית החינמית (נבדק 14.11.2026 ב-buildkite.com/pricing)

- עד 5 משתמשים ו**עד 10 עבודות במקביל על סוכנים שלנו**
- ‏2,000 דקות Linux מתארחות בחודש (אנחנו לא משתמשים בהן: הסוכנים שלנו)
- שמירה של 30 יום לבניות ולתוצרים (הקבלות נשמרות ב-`lumen-md-receipts`, ולכן נשארות גם אחרי זה)
- ‏$0, בלי כרטיס אשראי

ה-commit statuses מגיעים מאפליקציית ה-GitHub של Buildkite. לגרסת
"Limited Access" שלה אין גישה לקוד, אבל יש לה הרשאה לכתוב commit statuses
([Buildkite: GitHub](https://buildkite.com/docs/pipelines/source-control/github)).
הסוכנים שלנו משכפלים את הריפו הציבורי בעצמם.

## ההגדרה של הבעלים (פעם אחת, כ-20 דקות)

1. נרשמים ב-buildkite.com (התוכנית החינמית) ורושמים את ה-slug של הארגון.
2. **Settings → Repository Providers → GitHub (Limited Access)**: מתקינים
   על `talstilkol/lumen-md` בלבד.
3. **Agents → ה-cluster ברירת המחדל → Queues**: יוצרים שני תורים מסוג
   self-hosted, ‏`linux` ו-`mac`. תחת **Agent tokens** יוצרים טוקן אחד.
4. **Pipelines → New pipeline** בשם `lumen-md`:
   - ריפו `https://github.com/talstilkol/lumen-md.git`
   - צעדים: `buildkite-agent pipeline upload` בתור `linux`
   - בהגדרות GitHub משאירים את **Update commit statuses** לא מסומן: ה-pipeline
     קובע את הסטטוסים בעצמו
   - לא מוסיפים את ה-webhook של GitHub: הבניות ממנו היו מדולגות בכל מקרה,
     והמארח מתחיל את הבניות
5. **Personal settings → API Access Tokens**: טוקן לארגון הזה עם
   **read_builds** ו-**write_builds** בלבד.
6. המארח של המפעל (אחרי ההגדרה שלו, מהדף של המפעל) וה-Mac:

```bash
# on the Mac, with the factory host in VM=ubuntu@<ip>
printf 'Agent token: '; read -rs AGENT; echo; printf 'API token: '; read -rs API; echo
curl -fsSL https://raw.githubusercontent.com/talstilkol/lumen-md/ci/buildkite/scripts/buildkite/agent-bootstrap.sh -o /tmp/bk.sh
scp /tmp/bk.sh "$VM":/tmp/
printf '%s\n%s\n' "$AGENT" "$API" | ssh "$VM" 'sudo bash /tmp/bk.sh --secrets-stdin --org <org-slug>'
printf '%s\n' "$AGENT" | bash /tmp/bk.sh --secrets-stdin      # this Mac: queue mac
unset AGENT API
```

הסקריפט קורא את הטוקנים מ-stdin, אף פעם לא משורת הפקודה, ושומר אותם בהרשאות
0600. הסוכן:

- רץ כמשתמש של המפעל
- משכפל רק את lumen-md‏ (`allowed-repositories`)
- לא מריץ תוספים ולא hooks מתוך ה-checkout

`--dry-run` מדפיס כל פעולה בלי לשנות דבר. ב-Mac הסוכן רץ בסשן ההתחברות שלך
(LaunchAgent), ולכן ה-Mac צריך להיות מחובר וער כדי ש-`e2e-webkit` ירוץ.

## בדיקה

- `npm run ci:selftest`: הפקודות שנוצרו רצות דרך `run.sh`, כש-Docker, ‏npm
  והסוכן מדומים. הבדיקה מכסה גם את תוכנית הרסיסים על קובצי הבדיקה האמיתיים,
  את הקבלה (נחתמת, נבדקת, ובייט אחד ששונה נדחה), את ה-trigger מול תחליפים
  מקומיים ל-API, ואת ההתקנה לתוך root זמני.
- `node scripts/buildkite/receipt.mjs --verify <receipt.json> --key keys/<host>.pem`:
  בודק קבלה מבנייה או מ-`lumen-md-receipts`.
