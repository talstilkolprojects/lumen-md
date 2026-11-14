---
title: ישיבות הבעלים
description: כל מה שרק הבעלים יכול לעשות — חשבונות, הרצות GPU, נתוני זהב, מכשירים — בשלוש ישיבות לפי סדר התלויות, עם זמן ופקודה מדויקת לכל פריט, ומכשירים חינמיים בענן במקום טלפונים לבדיקה.
---

**להריץ כפקודה:** ‏`npm run owner:session -- accounts|gpu|devices` מציג כל צעד, מריץ ובודק אותו ורושם קבלה חתומה ([פקודת ישיבת הבעלים](/he/project/owner-session-command/), משימה W6.20). היא מקבצת את הפריטים שלמטה ל-14 צעדים.

משימה W4.7. נאסף ב-12.11.2026 מ-`plan.json` ← `owner` ‏(15.1–15.18) ומסעיפי
"## Owner commands" של כל 300 ה-pull requests הפתוחים (ל-37 יש סעיף כזה). כל
פריט נמצא כאן, עם זמן ופקודה, או ברשימה "ירד מרשימת הבעלים" עם מי שעושה אותו
במקום.

**סדר:** ישיבה 1 (חשבונות) קודם — האימות בחנויות לוקח ימים, וכמה צעדים
אחר כך צריכים את הטוקנים שלה. ישיבה 2 (Mac עם GPU) וישיבה 3 (מכשירים) בכל סדר.
15.1 (מיזוג) בסוף.

פקודות שמגיעות עם pull request פתוח כתובות כסקריפט שהן מריצות (שם ה-PR לידן), כך שהן עובדות בענף של אותו PR עוד לפני המיזוג: ‏`node scripts/models-day.mjs` הוא ה-`models:day` של #443, ‏`bash scripts/pages-deploy.sh` הוא ה-`pages:deploy` של #484.

## הספירה

| | לפני | אחרי |
|---|---|---|
| פריטי התוכנית 15.1–15.18 | 18 | **11** ‏(−39%): ‏15.2, 15.10, 15.16 הוחלטו; 15.5 ו-15.6 נדחו (רשות); 15.14 ו-15.17 רצים בתוך הפקודה האחת של 15.3. **10 ‏(−44%)** כש-BrowserStack יאשר את תוכנית הקוד הפתוח וסוכן יריץ את חלק ה-Safari של 15.12 ב-BrowserStack Automate |
| כל פריטי הבעלים (15.x וסעיפי ה-PR, בלי כפילויות) | 40 | **28** ‏(−30%): הרצות הבדיקה של 14 PR-ים, 3 הורדות נתונים ו-4 נעיצות מודלים עברו לסוכנים |
| זמן הבעלים לפי ההערכות של 15.x | כ-21 ש׳ 40 דק׳ | כ-2 ש׳ 10 דק׳ (ישיבה 1) + כ-2 ש׳ 55 דק׳ בנוכחות וכ-2 ש׳ בלי נוכחות (ישיבה 2) + 5 ש׳ 30 דק׳ נתוני זהב (2.8, על פני כמה ימים) + כ-3 ש׳ 35 דק׳ (ישיבה 3) ≈ 14 ש׳ שלך |
| מכשירים שטל צריך להחזיק לבדיקות Safari / iOS / Android | iPhone, ‏Safari ב-Mac, טלפון Android | אף אחד ל-Safari/iOS (תוכנית הקוד הפתוח של BrowserStack) ולהרצות smoke ב-Android ‏(Firebase Test Lab, מכסה ללא עלות); טלפון עדיין נחוץ לבדיקות share sheet, ווידג׳ט ואפליקציית הקבצים |

## ישיבה 1 — חשבונות, מפתחות ומתגים (כ-2 ש׳ 10 דק׳, ועוד 20 דק׳ ל-1.10 שהוא רשות; כל מחשב)

| # | פריט (מקור) | זמן | פקודה / איפה |
|---|---|---|---|
| 1.1 | **15.18 ‏(P0)** סודות `VITE_*` שדלפו ל-bundle לפני #243 | 20 דק׳ | ‏`npx vercel@latest env ls` (וב-Netlify: ‏`netlify env:list`). כל טוקן או מפתח ביניהם: לבטל אצל הספק, ליצור חדש, ולשמור רק בצד השרת (`vercel env add <NAME> production` בלי הקידומת `VITE_`). אם אין — לרשום "15.18: אין" בתוכנית. |
| 1.2 | השארית של 15.9: טוקן Hugging Face ו-seed לסטי הזהב | 3 דק׳ | ‏`vercel env add HF_TOKEN preview` · ‏`openssl rand -hex 32 \| vercel env add GOLDEN_SEED preview` |
| 1.3 | חלק מ-15.11: תנאי מאגרי הנתונים | 5 דק׳ | מחוברים ל-Hugging Face בחשבון של `HF_TOKEN`: לקבל את התנאים של `openlanguagedata/flores_plus`; לקבל את תנאי המאגר של Common Voice במקום שההורדה של 7.1 מושכת ממנו. |
| 1.4 | הפעלת W4.28 ‏(#481) | 5 דק׳ | ‏`gh label create human-reviewed --repo talstilkol/lumen-md --color 0E8A16 --description "A person reviewed the diff after the last commit"` · ‏`gh api -X PUT repos/talstilkol/lumen-md/private-vulnerability-reporting` · סריקת סודות והגנת push: ‏Settings ← Code security ← להפעיל את שתיהן (חינם לריפו ציבורי; שתיהן כבויות היום). |
| 1.5 | **15.7** חשבונות חתימה — להתחיל עכשיו, האימות לוקח ימים | 30 דק׳ + המתנה | ‏Apple Developer Program ‏($99 לשנה, לאדם פרטי לא צריך D-U-N-S) · ‏Google Play Console ‏($25 פעם אחת, אימות זהות) · ‏Windows: ‏Azure Trusted Signing, או בקשה לחתימת קוד חינמית של SignPath לפרויקטי קוד פתוח (לבדוק את התנאים העדכניים) · מפתח העדכונים של שולחן העבודה: ‏`npx tauri signer generate -w ~/.tauri/lumen-updater.key`, ואז להגדיר `LUMEN_UPDATER_PUBKEY` (ציבורי) ו-`TAURI_SIGNING_PRIVATE_KEY` עם הסיסמה שלו ב-shell שמריץ את בניות השחרור (`scripts/tauri-signing.mjs` קורא אותם); את המפתח הפרטי והסיסמה לשמור במנהל הסיסמאות (עותק שני: הדף *מתחזק שני* §5). |
| 1.6 | מכשירים חינמיים בענן (במקום להחזיק טלפונים לבדיקה) | 10 דק׳ | **תוכנית הקוד הפתוח של BrowserStack:** בקשה ב-browserstack.com/open-source עם כתובת הריפו הציבורי (MIT); התוכנית נתנה לפרויקטי קוד פתוח Live,‏ Automate,‏ App Live ו-App Automate עם 5 משתמשים ו-5 הרצות במקביל על מכשירי iOS ו-Android אמיתיים — התנאים העדכניים בדף הזה (לא הצלחנו לקרוא אותו מהסביבה). **‏Firebase Test Lab ‏(Spark, ללא עלות):** ‏`firebase projects:create lumen-md-test` (או בקונסולה), ואז Test Lab פעיל: 5 הרצות ביום על מכשירים פיזיים ו-10 על וירטואליים ב-Android. שימו לב: Google הוציאה את Test Lab משימוש; הוא נסגר ב-30.9.2027. |
| 1.7 | אירוח שני W4.27 ‏(#484) | 15 דק׳ | ‏`npx wrangler@4 login` · ‏`npx wrangler@4 pages project create lumen-md --production-branch main` · ‏`git checkout chore/second-host && npm ci && bash scripts/pages-deploy.sh --prod` |
| 1.8 | ה-worker של מראת המודלים (#476 צעד 3; הסוכן עושה את צעדים 1, 2, 4, 5) | 10 דק׳ | ‏`cd edge-workers/model-mirror && npx wrangler@4 deploy` (להגדיר `account_id`) · ‏`vercel env add VITE_MODEL_MIRROR_URL production` = ‏`https://lumen-model-mirror.<account>.workers.dev` |
| 1.9 | **15.4** שרתים וממסר הסנכרון (#483) | 30 דק׳ | ‏signaling: ‏`cd sync-server && fly launch --copy-config --no-deploy --name lumen-signal && fly deploy` · הממסר על אותו שרת: ‏`fly secrets set VAULT_RELAY=1 VAULT_RELAY_DIR=/data && fly deploy` · ‏`vercel env add VITE_SYNC_RELAY_URL production`. ‏proxy ה-CORS ל-git: לפי 15.4 בתוכנית. |
| 1.10 | *רשות* — **15.5** אפליקציות OAuth ל-Drive ול-Dropbox ‏(#483); נדחה, רק כדי להציע את שני הספקים האלה | 20 דק׳ | ‏Google Cloud Console ← OAuth client ‏(Web), כתובת חזרה `https://lumen-md.vercel.app/oauth/gdrive`, ‏scope ‏`drive.file` · ‏Dropbox App Console ← scoped app ‏(App folder), כתובת חזרה `https://lumen-md.vercel.app/oauth/dropbox` · ‏`vercel env add VITE_GDRIVE_CLIENT_ID production` · ‏`vercel env add VITE_DROPBOX_APP_KEY production` |

## ישיבה 2 — מודלים ונתונים, על ה-Mac עם ה-GPU (כ-2 ש׳ 55 דק׳ בנוכחות + כ-2 ש׳ בלי נוכחות; עבודת סטי הזהב של 2.8 היא עוד 5 ש׳ 30 דק׳, על פני כמה ימים)

תנאים מוקדמים: ישיבה 1.2–1.3; ‏Ollama מותקן; checkout עם #443 ‏(`models:day`).

| # | פריט (מקור) | זמן | פקודה |
|---|---|---|---|
| 2.1 | **15.3 + 15.14 + 15.17** מודלים אמיתיים, מנועי דפדפן, בדיקות שלב 6; וגם #449 (קריאות כלים) ו-#454 (הכתבה בדפדפן) | 15 דק׳ + כ-2 ש׳ בלי נוכחות | ‏`npm ci && node scripts/models-day.mjs check` (להתקין מה שמסומן ✗) · ‏`node scripts/models-day.mjs` · ואז לדחוף את תיקיית ההרצה כפי שהיא מודפסת (`git switch -c eval/day-<run> && git add -f eval/results/day/<run> && git commit -m "eval: real models day <run> [skip ci]" && git push -u origin HEAD`) |
| 2.2 | הערכת DictaLM-3 ‏(#379; הסוכן ממלא קודם את `models/dictalm3.json` מה-API של HF) | 20 דק׳ | ‏`ollama pull hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF && ollama pull qwen3:4b` · ‏`node scripts/dictalm3.mjs eval --size 1.7B` · ‏`node scripts/dictalm3.mjs decide --json eval/results/dictalm3-decision.json` |
| 2.3 | ‏Whisper של ivrit.ai בשולחן העבודה (#383, ‏W1.17; הסוכן נועץ קודם את המודל) | 25 דק׳ | ‏`brew install whisper-cpp` · להוריד את הקובץ הנעוץ ל-`~/Library/Application Support/app.lumen.editor/whisper/` (הכתובת מודפסת בנעיצה) · ‏`node scripts/whisper-desktop.mjs wer --split test=<golden>/asr-he/test --model <file>` (יעדים: ‏WER ≤ 10%, פחות מ-10 דק׳ לשעת שמע) |
| 2.4 | מהירות זיהוי דוברים (#398; הסוכן נועץ את שתי הרשתות) | 15 דק׳ | בניית dev על ה-M1: לתמלל הקלטה של שעה ולקרוא "RTF" בקונסולה (יעד < 0.25); ‏`node scripts/meetings/der.mjs --golden <dir> --out der-scores.json` אחרי שהפגישות של 2.8 תויגו |
| 2.5 | הערכות סקירת ספרות וציור בקנבס (#438, ‏#404) | 10 דק׳ | ‏`ollama pull qwen2.5:7b && LUMEN_EVAL_LIT=1 npx vitest run --config vitest.eval.config.ts src/agents/eval/litReview.eval.ts` · ‏`node scripts/canvas-draw-eval.mjs --model qwen2.5:7b` |
| 2.6 | חלקי 15.13 על ה-Mac: ‏LoRA מקומי (6.12), מנתח הנתונים מול מודל אמיתי (6.15, 20 שאלות זהב) | 30 דק׳ | לפי סעיפי הבעלים של ה-PR-ים של 6.12 ו-6.15 (`node scripts/models-day.mjs` מכסה את הערכת מנתח הנתונים כש-6.15 ממוזג) |
| 2.7 | הארכיונים שלך (#482 מייל, ‏#478 צ׳אטים) | 30 דק׳ | כ-50 הודעות ישנות בעברית כ-`.eml` ‏(windows-1255 / ISO-8859-8) ו-Gmail Takeout ← ‏⌘K *ייבוא מייל…*; ‏10 צ׳אטים (WhatsApp ב-Android וב-iPhone, ‏JSON של Telegram) ← ‏⌘K *ייבוא צ׳אט WhatsApp או Telegram…*; לשלוח את השורות הראשונות (מושחרות) של כל מה שנקרא לא נכון |
| 2.8 | **15.11** החלק שלך בסטי הזהב | 5 ש׳ 30 דק׳ (בכמה ימים) | ‏20 הקלטות קול והסכמת CC0 ‏(30 דק׳ — מקליטים פעם אחת: הן משמשות גם לפקודות הקוליות של #458 ול-5 הפגישות הקצרות של #398, 20 דק׳) · הגהת 60 משפטי ניקוד ו-50 זוגות שגיאות (1 ש׳ 30) · ‏20 תיאורי תמונות כהפניה (45 דק׳) · ‏30 שאילתות אישיות עם תיוג (1 ש׳) · ‏30 התקפות injection בעברית (45 דק׳) · ‏15 עמודים מצולמים (20 דק׳) · דירוג 50 תרגומים (45 דק׳) |
| 2.9 | **15.15** דירוג תיאורי התמונות המקומיים (אחרי 6.6) | 30 דק׳ | גיליון הדירוג שה-PR של 6.6 מדפיס, 1–5 לכל תמונה, 50 תמונות |

## ישיבה 3 — מכשירים ובדיקות ידניות (כ-3 ש׳ 35 דק׳)

| # | פריט (מקור) | זמן | איך (קודם הענן החינמי) |
|---|---|---|---|
| 3.1 | **15.12** ‏Safari, פריסת המקלדת העברית של W2.8, ‏WebKit של W4.21 | 30 דק׳ | ‏BrowserStack Live (ישיבה 1.6): ‏Safari ב-macOS וב-iPhone, לפתוח את https://lumen-md.vercel.app ולעבור על רשימת 15.12 עם מקור קלט עברי; בלי מכשיר שלך |
| 3.2 | ‏15.12 ‏Word ‏(RTL) והעדכון האוטומטי | 30 דק׳ | לפתוח ב-Word את ה-`.docx` המיוצא מ-#263 ולבדוק כיווניות ורשימות · להתקין בנייה N, לפרסם N+1 כ-prerelease (צריך את מפתח העדכונים של 1.5), *בדיקת עדכונים* ← מתקין ומפעיל מחדש |
| 3.3 | **15.8** בדיקות שחרור לשולחן העבודה, הבנייה ה-native ‏(#479) וחבילות החנויות (#423) | 60 דק׳ | ‏Mac: ‏`npm ci && npm run tauri:build`; ‏Linux: ‏`sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev && cargo check --locked --manifest-path src-tauri/Cargo.toml && npm run tauri:build`; ואז CSP,‏ Graphviz / Python / OCR, כספת בתיקייה, ואותה כספת נפתחת ב-Obsidian · ‏`node scripts/release.mjs packages` ושורות ה-`brew audit` /‏ `winget validate` /‏ `flatpak-builder` /‏ `makepkg` של #423 בכל מערכת |
| 3.4 | החלקים ה-native של iOS ו-Android ‏(#425 ‏W3.4, ‏Xcode לכל `.swift`) | 30 דק׳ | ‏Xcode: להוסיף את קובצי ה-Swift וה-`.lproj` החדשים, את יעד `LumenWidgets` ואת החתימה (1.5), ‏Product ← Build; ‏Android: ‏`cd android && ./gradlew assembleDebug`, ואז הרצת robo ב-**Firebase Test Lab** (בלי טלפון): ‏`gcloud firebase test android run --type robo --app app/build/outputs/apk/debug/app-debug.apk --device model=<id>,version=<api>` (לבחור דגם פיזי מ-`gcloud firebase test android models list`) |
| 3.5 | בדיקות שרק טלפון יכול: ווידג׳ט ו-Siri ‏(#425), ‏share sheet ‏(#478), פתק קולי בפחות משנייה (#376), כספת בתיקייה דרך אפליקציית הקבצים (15.13 / 4.20), סנכרון ברשת המקומית בין שני מכשירים (W2.19) | 30 דק׳ | הטלפון שלך (BrowserStack App Live מכסה את הווידג׳ט וה-share sheet אם מעדיפים: להעלות את ה-APK / IPA) |
| 3.6 | קוראי מסך (W1.23 דרך Guidepup של W4.21) | 20 דק׳ | פקודות ה-Guidepup בסעיף הבעלים של #467 על ה-Mac ‏(VoiceOver) ועל מחשב Windows ‏(NVDA); ‏TalkBack בטלפון |
| 3.7 | **15.1** מיזוג — אחרון | 15 דק׳ | אחרי שריצת ה-e2e על verify/train ירוקה (ה-Vercel Sandbox חוזר ב-1.12): למזג את #431, ואז את השאר לפי התוכנית |

## צריך אנשים נוספים (לתאם; לא בישיבה)

- ‏W1.29 מפגשי שימושיות: ‏5–8 משתמשים דוברי עברית בכל סבב (הערכה של #419).
- ‏#388 מבחן האזנה ל-TTS: ‏5 מדרגים (`node scripts/tts-mos.mjs sheet --raters <5 names>`).
- מתחזק או סוקר שני (W4.28, הדף *מתחזק שני*).

## ירד מרשימת הבעלים

| פריט | במקום |
|---|---|
| ‏15.2 ‏Codex ו-Renovate | הוחלט 10.11: אף אחד מהם (Dependabot פעיל) |
| ‏15.10 רישוי | הוחלט 10.11, סעיפים 1–9 |
| ‏15.16 החלטות מוצר | הואצל ל-Claude ("תחליט לבד כל החלטה"): המתאם מחליט ומתעד |
| ‏15.6 ‏DSN לניטור | נדחה: דוחות השגיאות כבויים כברירת מחדל והם רשות; לחזור לזה כשיהיו משתמשים |
| ‏15.5 ‏client IDs ל-Drive ול-Dropbox | נדחה (שורה 1.10, רשות): שני הספקים מופיעים ברשימת הסנכרון כשה-IDs מוגדרים; שום דבר אחר לא מחכה להם |
| ‏15.14, ‏15.17 | רצים בתוך `node scripts/models-day.mjs` של 2.1 |
| ‏15.9, חלק ההחלטה | הוחלט 10.11 (ריפו ציבורי, ‏GitHub Releases); הטוקן עדיין שלך: שורה 1.2 (נספר בין ה-11) |
| הרצות הבדיקה בסעיפי הבעלים של 14 PR-ים (#401 ‏#404 ‏#408 ‏#411 ‏#413 ‏#418 ‏#424 ‏#426 ‏#429 ‏#434 ‏#437 ‏#440 ‏#441 ‏#473) | סוכנים, ב-Vercel Sandbox מ-1.12, או כל מי שיש לו Docker: ‏`bash scripts/ci-docker.sh` ‏(#484) |
| ‏#391 ספרי EPUB לסט הזהב, ‏#394 קובץ ה-FSRS, ‏#453 מילון ויקימילון | סוכנים ב-Sandbox (הורדות מנחלת הכלל, `npm install --no-save`) |
| נעיצות מודלים: רישיונות #379, קובץ ה-ggml של #383, רשתות זיהוי הדוברים של #398, צעדים 1, 2, 4, 5 של #476 | סוכנים ב-Sandbox (ה-API הציבורי של HF, ‏releases דרך `gh`); לטל נשארות רק הרצות ה-GPU ‏(2.2–2.4) והפריסה של ה-worker ‏(1.8) |
| בדיקות Safari / iOS על המכשירים של טל (15.12, ‏W2.8) | תוכנית הקוד הפתוח של BrowserStack ‏(3.1) |
| ‏smoke ב-Android על טלפון | הרצות robo ב-Firebase Test Lab ‏(3.4) |
