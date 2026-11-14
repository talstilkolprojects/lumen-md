---
title: ריצות לילה וקבלות
description: npm run nightly מריץ את ציד ה-flakes, בדיקות הביצועים, מיון הביקורות ובריאות התלויות השבועית על המחשב שלך, וכותב לכל אחד דוח חתום, בלי GitHub Actions.
---

Lumen לא משתמש ב-GitHub Actions, ולכן הריצות המתוזמנות (משימה 0.11)
והמדידות שתלויות בהן רצות על המחשב של בעל הפרויקט:

- 0.5: שלושה לילות בלי בדיקה לא יציבה
- 0.14: כמה כישלונות ב-build של preview הרצה מקומית של `ci:local` הייתה
  תופסת

פקודה אחת עושה את זה:

```bash
npm run nightly                  # what is due today
npm run nightly -- --dry-run     # print the plan, run nothing
```

| סוג | מתי | מה רץ |
|---|---|---|
| `flake` | כל לילה | `npm run e2e:flake -- --all --times 5` (chromium, firefox, webkit, חמש ריצות לכל אחד, בלי retries) |
| `perf` | כל לילה | build, תקציב החבילה, פרויקט הביצועים `@nightly`, ו-Lighthouse כשהוא מותקן |
| `triage` | כל לילה | מיון הביקורות של ה-PR-ים הפתוחים, הספירה של 0.14 על 20 ה-PR-ים הראשונים מאז 12.11.2026, ו-`live:meta --self-test` (למטה) |
| `weekly` | בימי ראשון (UTC) | בריאות התלויות (audit, outdated, רישיונות), וציוני mutation כש-`test:mutation` קיים |

`--only flake,perf` בוחר סוגים. המתזמן מעביר `--scheduled`, שמסמן את הדוחות
כמתוזמנים. משימה 0.11 סופרת רק אותם.

## דוחות וקבלות

כל סוג כותב `reports/nightly/<date>-<kind>.json`. הדוח מתעד:

- את הקומיט, והאם העץ היה נקי
- את המחשב: מערכת הפעלה, Node ומספר הליבות, בלי שם המחשב
- כל פקודה עם קוד היציאה והמשך שלה
- את ה-sha256 של הפלט של כל פקודה, עם השורות האחרונות שלו
- את המספרים של הסוג: בדיקות לא יציבות ובדיקות שתמיד נכשלות בכל דפדפן,
  הערות הביצועים, סיכומי הביקורות ומספרי ה-audit

הדוח **חתום**. יש בו ה-sha256 שלו וחתימת Ed25519, שנעשית במפתח שלא יוצא אף
פעם מהמחשב (`~/.config/lumen-md/nightly-ed25519.pem`, הרשאות 0600, נוצר
בריצה הראשונה; `LUMEN_NIGHTLY_KEY` משנה את הנתיב). החצי הציבורי שלו נשמר
בריפו כ-`reports/nightly/PUBLIC_KEY.pem`. כל אחד יכול לבדוק דוח ששמור בריפו:

```bash
npm run nightly -- --verify reports/nightly/2026-11-13-flake.json
```

אם מספר כלשהו בדוח השתנה אחרי הריצה, גם ה-digest וגם החתימה נכשלים.

`reports/nightly/status.json` (גם הוא חתום) מחושב מחדש אחרי כל ריצה
(`npm run nightly -- --status` עושה רק את זה). הוא מתעד:

- **0.5**: כמה לילות רצופים היו, שבכל אחד מהם כל דפדפן רץ חמש פעמים בלי
  בדיקה לא יציבה ובלי בדיקה שתמיד נכשלת (צריך 3)
- **0.11**: אילו מארבעת הסוגים הפיקו דוח מתוזמן (צריך את כל ה-4)
- **0.14**: ב-20 ה-PR-ים הראשונים שנפתחו מאז 12.11.2026, הקומיטים שה-build
  של ה-preview שלהם ב-**Vercel** נכשל. ה-build של ה-preview מריץ חלק
  מ-`ci:local`, אז כל כישלון כזה הוא כישלון ש-`ci:local` היה תופס, חוץ
  מ-`docs:sync`, ש-`ci:local` לא מריץ. ענפי האינטגרציה `verify/*` לא
  נספרים.

`--commit` שומר את `reports/nightly/` בקומיט עם הודעה שכוללת `[skip ci]`. הוא
אף פעם לא דוחף. קומיט שמשנה רק את `reports/` לא מתחיל build ב-Vercel
(`scripts/vercel-ignore.sh`), כך שהקבלות לא מבזבזות את מכסת הפריסות.

## תזמון ב-Mac (launchd)

משתמשים בעותק של הריפו ששמור רק לריצת הלילה, על ענף משלו, כך שריצה אף פעם
לא מתערבבת בעבודה שלך:

```bash
git clone https://github.com/talstilkol/lumen-md ~/lumen-nightly
cd ~/lumen-nightly && git switch -c nightly/receipts && npm ci && npx playwright install
```

שומרים את `~/Library/LaunchAgents/dev.lumen-md.nightly.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.lumen-md.nightly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/lumen-nightly &amp;&amp; git pull -q --rebase origin main &amp;&amp; npm ci --silent &amp;&amp; npm run nightly -- --scheduled --commit</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>/tmp/lumen-nightly.log</string>
  <key>StandardErrorPath</key><string>/tmp/lumen-nightly.log</string>
</dict>
</plist>
```

אחר כך טוענים אותו עם `launchctl load ~/Library/LaunchAgents/dev.lumen-md.nightly.plist`.
launchd מריץ משימה שהוחמצה בזמן שה-Mac ישן ברגע שהוא מתעורר. כדי לפרסם את
הקבלות, דוחפים את הענף (`git push origin nightly/receipts`) או פותחים ממנו
PR. בלינוקס משתמשים ב-cron:

```text
17 2 * * *  cd ~/lumen-nightly && git pull -q --rebase origin main && npm ci --silent && npm run nightly -- --scheduled --commit
```

## למה לא Vercel Cron או משימה מתוזמנת בענן

- **Vercel Cron** רק קורא לפונקציה של פריסה לפי לוח זמנים. הוא לא יכול
  להריץ שלושה דפדפנים חמש פעמים על כל חבילת ה-e2e, והוא היה מבזבז את מכסת
  הפריסות המשותפת.
- **משימה מתוזמנת של Claude Code** פותחת סשן חדש בענן. בסשן הזה אין
  דפדפנים ואי אפשר להתקין חבילות, אז הוא יכול להריץ רק את הסוג `triage`
  (REST API של GitHub) ולקרוא את הקבלות ששמורות בריפו. זה שימושי לסיכום
  בוקר, לא למדידות עצמן.

## בדיקת המטא-דאטה החיה (משימה W6.2)

`npm run live:meta` מוריד מהייצור את `index.html`, ‏`robots.txt` ו-`sitemap.xml`,
ונכשל אם אחד מאלה לא מצביע על `lumen-md.vercel.app`: הקישור ה-canonical,
‏`og:url`, ‏`og:image`, ‏`twitter:image`, כל כתובת ב-JSON-LD, שורת ה-`Sitemap:`
וכל `<loc>` במפת האתר. הוא נכשל גם אם הדומיין שאינו של הפרויקט מופיע בהם
במקום כלשהו. את התבנית של הדומיין הזה בונים מחלקים ב-`scripts/lib/liveMeta.mjs`,
כמו בשער ה-PR, כך שהיא לא כתובה בריפו.

```bash
npm run live:meta                                   # הייצור, אחרי כל פריסה
npm run live:meta -- --url https://<deployment>.vercel.app
npm run live:meta -- --dir dist                     # בנייה, לפני שפורסים אותה
npm run live:meta -- --self-test --json live-meta.json
```

`--self-test` בודק קודם עותק נקי של הדפים. אחר כך הוא שותל הפניה זרה בכל
מקום (canonical, ‏`og:image`, ‏`og:url` למארח אחר, טקסט בגוף הדף, `Sitemap:`,
‏`<loc>`), ונכשל אם הבדיקה פספסה אחת מהן.

מריצים אותה **אחרי כל פריסה לייצור**: ישיבת המיזוג של הבעלים מריצה אותה מיד
אחרי הקידום. בכל לילה הסוג `triage` מריץ אותה גם כן, כך שסטייה מתגלה תוך
יום. הפקודה יוצאת עם 1 על כל בעיה. היא מורידה עם Node, ואם זה לא עובד עוברת
ל-`curl`, שמכבד את `HTTPS_PROXY`.
