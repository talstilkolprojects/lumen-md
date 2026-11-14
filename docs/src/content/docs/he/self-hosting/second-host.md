---
title: אירוח שני ובדיקות בלי Vercel
description: למה Cloudflare Pages הוא האירוח השני של Lumen לצד Vercel Hobby, מה כל שכבה חינמית מתירה, איך מעלים לשם את אותה בנייה, מה עושים כשמכסה נגמרת, ואיך מריצים את כל צינור הבדיקות ב-Docker.
---

תוכנית Hobby של Vercel בונה כל ענף, בנייה אחת בכל פעם, 100 פריסות ביום,
והיא **לשימוש אישי ולא מסחרי בלבד**. בנובמבר 2026 מגבלת השימוש ומשבצת
הבנייה היחידה עצרו את הבדיקות של Lumen לשבועות. הדף הזה מתעד את ההחלטה על
אירוח שני ודרך לבדוק בלי שום אירוח (משימה W4.27).

## השכבות החינמיות, זו מול זו

נבדק ב-12 בנובמבר 2026 מול הדפים של כל ספק.

| | ‏Vercel Hobby | ‏Cloudflare Pages Free | ‏Netlify Free | ‏GitHub Pages |
|---|---|---|---|---|
| שימוש מסחרי | ✗ אישי ולא מסחרי בלבד | ✓¹ | ✓¹ | ✗ לא להפעלת עסק או SaaS |
| בניות | 100 פריסות ביום, אחת בכל פעם | 500 בניות בחודש, אחת בכל פעם, 20 דקות כל אחת; **Direct Upload לא נספר** | 300 קרדיטים בחודש, פריסת production עולה 15 (כ-20 בחודש); previews ו-branch deploys ב-0 | 10 בשעה (רך), 10 דקות כל אחת |
| תעבורה | ‏100GB, מיליון בקשות | לא נמדדת | 20 קרדיטים ל-GB ו-2 ל-10,000 בקשות, מאותם 300 | ‏100GB בחודש (רך), אתר עד 1GB |
| לקובץ / קבצים | — | ‏25MiB לקובץ, 20,000 קבצים | — | — |
| כותרות מותאמות (CSP, דפי ה-runner) | ✓ ‏`vercel.json` | ✓ ‏`_headers`, עם `! Header` לניתוק | ✓ ‏`_headers` ופונקציית edge ל-runners | ✗ אין: ה-CSP נשען על `<meta>`, בלי `frame-ancestors`, ‏HSTS רק של GitHub |
| מעבר למגבלה | הפיצ׳רים נעצרים ל-30 יום | הבניות נעצרות; האתר נשאר באוויר | **כל האתרים מושהים** ("Site not available") עד החודש הבא | אזהרות, ואחר כך אולי השעיה |
| בלי GitHub Actions | ✓ | ✓ | ✓ | ✗ פרסום מענף מריץ workflow בשם `pages-build-deployment` |
| עלות חודשית | ‏$0 (‏Pro: ‏$20 למושב מפתח) | ‏$0 | ‏$0 | ‏$0 |

¹ אין הגבלה בדפי התוכניות והמגבלות של הספק, והשוואה של צד שלישי (hostfleet.pages.dev, אפריל 2026) מציינת ששניהם מתירים; כדאי שהבעלים יקרא את תנאי השימוש לפני שסומכים על זה.

מקורות: vercel.com/docs/plans/hobby,‏ developers.cloudflare.com/pages/platform/limits,‏
docs.netlify.com ("How credits work"),‏ docs.github.com/pages (GitHub Pages limits).

## ההחלטה: Cloudflare Pages, ב-Direct Upload

- **Cloudflare Pages** הוא האירוח השני. התעבורה שלו לא נמדדת, האתר נשאר
  באוויר כשמכסה נגמרת, שימוש מסחרי מותר, ו-`public/_headers` כבר כתוב בדקדוק
  שלו: דפי ה-runner מנתקים את המדיניות של האפליקציה עם
  `! Content-Security-Policy`, כך ש-Web Playground ו-live-js עובדים שם בלי
  פונקציית edge.
- **Direct Upload** (‏`npm run pages:deploy`): הבנייה רצה אצלכם, ולכן לא
  משתמשת באף אחת מ-500 הבניות של Cloudflare ובאף אחת מ-100 הפריסות של Vercel.
  חיבור הריפו בלוח הבקרה של Cloudflare הוא אופציונלי; הוא נותן משבצת בנייה
  שנייה לענפים (פקודת בנייה
  `npm run build && npm run pages:check -- --prepare`, תיקיית פלט
  `dist`, ‏`NODE_VERSION=22`).
- **לא Netlify** כמראה: כשהקרדיטים נגמרים כל האתרים מושהים, ו-20 פריסות
  production בחודש זה מעט מדי. ‏`netlify.toml` נשאר למי שמארח שם בעצמו.
- **לא GitHub Pages**: אין כותרות מותאמות (ה-CSP יאבד את `frame-ancestors`
  ודפי ה-runner את המדיניות שלהם), והפרסום שלו רץ על GitHub Actions, שהפרויקט
  לא משתמש בהן.
- **‏Vercel Pro ‏($20 לחודש)** מסיר את מגבלת ה-100 ביום, והוא נדרש בכל מקרה
  כש-Lumen ישמש מסחרית. זו החלטה של הבעלים; האירוח השני לא תלוי בה.

### מגבלה אחת שכדאי להכיר: ‏25MiB לקובץ

‏`ruby+stdlib.wasm` ‏(ruby.wasm, כ-30.6MB) גדול מ-25MiB לקובץ של Cloudflare.
‏`npm run pages:check` מדווח על כל קובץ כזה; ‏`--prepare` (שבו
‏`pages:deploy` משתמש) מסיר אותם מההעלאה הזו ורושם אותם
ב-`dist/pages-dropped.json`. בעותק של Cloudflare בלוקי live-ruby אומרים שאין
להם runtime מותקן — כמו גרסת ה-`slim` של תמונת ה-Docker. כל השאר אותה בנייה.

## להעלות את אותה בנייה

```bash
npx wrangler@4 login                                   # פעם אחת
npx wrangler@4 pages project create lumen-md --production-branch main   # פעם אחת
npm run pages:deploy                    # preview בשם הענף הנוכחי
npm run pages:deploy -- --prod          # production:‏ https://lumen-md.pages.dev
```

כל פריסה נושאת את ה-hash של ה-commit. כדי לוודא ששני האירוחים מגישים את אותה
בנייה של commit, משווים את ה-hash של תוכן ה-chunk הראשי (Vite קורא לו לפי
התוכן שלו):

```bash
for h in https://lumen-md.vercel.app https://lumen-md.pages.dev; do
  curl -s "$h/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
done
```

שתי השורות שוות כששתי הבניות היו עם אותן הגדרות `VITE_*`.

## כשמכסה נגמרת

| מה נגמר | מה עושים |
|---|---|
| פריסות Vercel ‏(100 ביום) או שימוש (השהיה של 30 יום) | previews: ‏`npm run pages:deploy` מהענף. בדיקות: ‏`npm run ci:docker`. ה-production נשאר על הפריסה האחרונה של Vercel; מעבירים תעבורה ל-`lumen-md.pages.dev` רק אם Vercel מפסיק להגיש אותו. |
| בניות Cloudflare ‏(500 בחודש, רק בחיבור Git) | ממשיכים ב-Direct Upload, שלא נספר. |
| שני האירוחים לא זמינים | תמונת ה-Docker ‏(`docker build -t lumen .`, ראו [איפה Lumen רץ](/he/self-hosting/hosting/)) מגישה את אותה אפליקציה בכל מקום. |

## צינור הבדיקות ב-Docker

כשאף אירוח לא יכול לבנות, מריצים אצלכם את כל מה שבניית ה-preview של Vercel
מריצה, בלי GitHub Actions:

```bash
npm run ci:docker                         # כל שלבי ci:local, ‏e2e ב-Chromium
npm run ci:docker -- --only typecheck,test
npm run ci:docker -- --skip e2e
```

‏`Dockerfile.ci` מתחיל מהתמונה של Playwright עצמו לגרסה המדויקת של
‏`@playwright/test` שב-`package-lock.json`, כך שהדפדפנים תואמים ושום דבר לא
יורד בזמן הבדיקות. הוא מתקין עם `npm ci`, מעתיק את ה-checkout (כולל היסטוריית
git: ‏`Dockerfile.ci.dockerignore`) ומריץ `npm run ci:local`. הלוג ודוח
Playwright נשמרים ב-`ci-docker-out/`. זה עובד גם עם Podman:
‏`DOCKER=podman npm run ci:docker`.

## מוכן לייצור בשני המארחים

אותה בנייה מגישה את אותן כותרות ואותם נתיבים בשני המארחים (תוכנית W6.9).
‏`npm run hosts:parity` מדמה כל מארח מתוך ההגדרות שלו ומשווה 17 נתיבי
בדיקה; ‏`pages:deploy` מריץ אותו על ה-`dist/` האמיתי לפני כל העלאה. שלושה
פרטים של Cloudflare שהוא מכסה:

- **2,000 תווים לשורה.** ‏Cloudflare מדלג על שורה ארוכה יותר ב-`_headers`
  בלי להכשיל את הפריסה. לכן מדיניות האפליקציה כתובה בשתי שורות, שהמארח
  מחבר לשתי מדיניויות, והדפדפן אוכף את שתיהן יחד כמדיניות אחת בדיוק.
- **‏`/x.html` עונה 308 אל `/x`.** לדפי ה-runner יש כללים בשני הנתיבים.
- **קטע קוד חסר מחזיר 404.** ‏`pages:check --prepare` כותב את
  `assets/404.html`, כך שקטע קוד מהפריסה הקודמת לא מקבל את ה-HTML של האפליקציה.

העברת הייצור בין מארחים: [מדריך המעבר](/he/self-hosting/cut-over/).
