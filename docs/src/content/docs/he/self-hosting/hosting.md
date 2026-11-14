---
title: איפה Lumen רץ
description: מה עובד באיזה אירוח — Cloudflare Pages, Netlify, Vercel ותמונת ה-Docker — ואיך כל אחד מוגדר.
---

Lumen היא אפליקציה סטטית: `npm run build` מייצר `dist/`, וכל אירוח שמגיש
קבצים יכול להריץ אותה. ובכל זאת כל אירוח צריך לעשות שלושה דברים נכון: לשלוח
את כותרות האבטחה מ-`security/policy.json` (ה-Content-Security-Policy הקפדנית
של האפליקציה, והמדיניות *האחרת* של שני דפי ה-runner שבלוקי ה-Web Playground
ו-live-js פותחים ב-iframe מבודד), להגיש את זמני הריצה של WebAssembly מאותו
מקור, ולדעת את כתובות השירותים של הפריסה. הטבלה נבדקת ב-`src/__tests__/hosting.test.ts`
מול קובצי ההגדרה, כך שהיא לא יכולה לסטות מהם.

## מה עובד איפה

| יכולת | Cloudflare Pages | Netlify | Vercel | תמונת Docker (compose, Fly) |
|---|---|---|---|---|
| העורך תחת המדיניות המלאה (כותרת תגובה + `<meta>`) | ✅ `_headers` | ✅ `_headers` | ✅ `vercel.ts` | ✅ `deploy/nginx.conf` |
| קישורים עמוקים (נתיבי SPA) | ✅ | ✅ redirect ב-`netlify.toml` | ✅ rewrite | ✅ `try_files` |
| Web Playground (runner מבודד, מדיניות משלו, ממוסגר על ידי האפליקציה) | ✅ `! Header` מנתק את הכלל הכללי | ✅ פונקציית קצה `runner-headers` | ✅ מוחרג מהכלל הכללי | ✅ `location` משלו |
| live-js runner | ✅ | ✅ פונקציית קצה | ✅ | ✅ |
| Workers שצריכים eval (Graphviz, Ruby, בודק TypeScript, webR) עם מדיניות משלהם | ✅ | ✅ | ✅ | ✅ |
| OCR במכשיר (מדיניות ה-worker של tesseract.js) | ✅ | ✅ | ✅ | ✅ |
| זמני ריצה של WebAssembly מאותו מקור (Python, Ruby, ONNX Runtime, מודל ה-VAD של ההכתבה, OCR; ≈100 MB). ‏R ‏(webR, ‏GPL-3.0) לא בבנייה: כל משתמש מוריד אותו מבלוק R, או שהמפעיל מכין אותו עם `npm run webr:local` | ✅ ב-`dist/` | ✅ | ✅ | ✅ `LUMEN_RUNTIMES=full` (ברירת המחדל) · `slim` משמיט אותם |
| כתובות השירותים שלך ב-`connect-src` (`VITE_*_ENDPOINT`) | ✅ בזמן הבנייה | ✅ בזמן הבנייה | ✅ `vercel.ts` בזמן הבנייה | ✅ ארגומנטי בנייה → nginx |
| HSTS | ✅ | ✅ | ✅ | — מסיים ה-TLS שלפניו שולח אותה |
| בידוד חוצה-מקורות (COOP / COEP, WebAssembly רב-תהליכי) | — | — | — | ✅ (החלטה 15.10(7) אם נשאר) |

כל מה שמעל שורת ה-HSTS עובד בכל אירוח. שתי השורות האחרונות הן הבדלים
מכוונים, מוסברים ב-`docs/security/headers.md`.

## תמונה אחת

חבילת ה-compose ופריסת Fly בונות את אותו `Dockerfile`: nginx עם
`deploy/nginx.conf`, מקשיב בפורט 8080 כמשתמש לא-root (`docker-compose.yml`
ממפה אותו לפורט 80). עד משימה 13.2 היו שני Dockerfile עם שתי הגדרות nginx
שונות.

ארגומנטי בנייה:

| ארגומנט | ברירת מחדל | מה |
|---|---|---|
| `VITE_*_ENDPOINT`, `VITE_*_URL`, `VITE_CSP_CONNECT_EXTRA` | ריק | השירותים של הפריסה; נוספים ל-`connect-src` בכותרת ובמדיניות ה-`<meta>` |
| `LUMEN_RUNTIMES` | `full` | `slim` מסיר את זמני הריצה של WebAssembly (≈100 MB; ‏webR אף פעם לא בתמונה, ראו R חי למטה). בלוקי live-python ו-live-ruby, ‏OCR ותמלול מקומי מדווחים אז שזמן הריצה שלהם לא מותקן; כל השאר, כולל ה-Web Playground, התוספים והגופנים של הקנבס, ללא שינוי |

```bash
# התמונה המלאה (compose: make onprem-up; Fly: fly deploy)
docker build -t lumen .
# תמונה קטנה יותר בלי זמני הריצה של WebAssembly
docker build -t lumen --build-arg LUMEN_RUNTIMES=slim .
```

## Netlify

Netlify מחיל את `dist/_headers` על כל תגובה ולא יכול לנתק את הכללים
הכלליים כמו שורות ה-`! Header` של Cloudflare, ולכן שני דפי ה-runner ירשו את
`X-Frame-Options: DENY` ואת ה-CSP של האפליקציה, וה-Web Playground לא רץ שם.
`netlify/edge-functions/runner-headers.ts` רץ רק עבור `/playground-runner.html`
ו-`/livejs-runner.html`, מסיר את חסימת המסגור ומגדיר את מדיניות ה-runner.
מחרוזות המדיניות שבו מיוצרות מ-`security/policy.json`: `npm run headers`
נכשל כשהן סוטות.

## ‏R חי (webR)

הקבצים הבינאריים של webR ‏(R, ‏libgfortran) מופצים תחת GPL-3.0, ולכן אף
בנייה או תמונה של Lumen לא מכילה אותם. ההרצה הראשונה של בלוק `live-r` במכשיר
מציעה להוריד אותו: הרישיון והמקור מוצגים קודם, הקבצים מגיעים מה-CDN של webR
עצמו (`webr.r-wasm.org`, או מחבילת ה-npm ב-`cdn.jsdelivr.net`), כל קובץ נבדק
מול סכומי הביקורת שב-`runtimes/webr.json` של הבנייה, ואז ה-service worker
מגיש אותם מהמקור הזה, גם בלי חיבור. שני המארחים נמצאים ב-`connect-src` רק
בשביל ההורדה הזו. מפעיל שמסכים להפיץ את webR תחת GPL-3.0 יכול להגיש אותו
בעצמו: `npm run webr:local` לפני `npm run build` מכין אותו ב-`public/webr/`,
ובלוק R משתמש בו בלי לשאול.
