---
title: מדריך הבלוקים הדינמיים
description: שפות בלוקי הקוד המגודרים ש-Lumen מציגה כתצוגות חיות ואינטראקטיביות.
---

התכונה המרכזית של Lumen היא **בלוקים דינמיים**: כותבים בלוק קוד מגודר
ב-Markdown, והתצוגה מציגה אותו כגרף, תרשים, טבלה, מפה או ארגז חול חי. כל בלוק
נופל בחן — אם העיבוד נכשל, עדיין רואים את המקור.

## טבלת עיון מהירה

| גדר | מוצג כ- | הערות |
|---|---|---|
| ` ```mermaid ` | תרשים SVG בשורה (זרימה, רצף, גאנט, מחלקות, מצבים, ER) | ‏Mermaid v11; נטען בעצלות |
| ` ```chart ` | ‏ECharts (קו / עמודות / עוגה / פיזור / מפת חום / רדאר / קופסה / treemap / sunburst / sankey) | מפרט YAML או JSON |
| ` ```csv ` / ` ```tsv ` | ‏DataTable שאפשר למיין ולסנן + הצעת גרף אוטומטית | כותרת עם `title="..."` |
| ` ```json-table ` | ‏DataTable ממערך JSON | נדרש מערך של אובייקטים |
| ` ```sql ` / ` ```pandas ` / ` ```object ` / ` ```data ` | תצוגה טבלאית דרך המציג המשותף `DataBlock` | ‏`pandas` מפענח את הצורה של `to_dict()` של DataFrame |
| ` ```map ` / ` ```geojson ` | מפת Leaflet (אריחים, סמנים, מצולעים, חלוניות) | ‏GeoJSON או מפרט מפה ב-YAML |
| ` ```dot ` / ` ```graphviz ` | תרשים Graphviz דרך WASM | מעובד מקומית — בלי תלות ב-Kroki |
| ` ```plantuml ` / ` ```puml ` | ‏PlantUML דרך kroki.io | יציאה לרשת; אפשר לבטל דרך מצב הפרטיות |
| ` ```abc ` | תווי מוזיקה ב-ABC (פרטיטורה מעובדת) | ‏Abcjs |
| ` ```model ` | מציג מודלים תלת-ממדיים (`<model-viewer>`) | ‏GLB / GLTF |
| ` ```embed ` | הטמעה אוניברסלית (YouTube,‏ Vimeo,‏ Twitter,‏ Loom,‏ CodePen,‏ oembed) | הכתובת בשורת הגוף |
| ` ```html ` / ` ```html-preview ` | תצוגה מקדימה של HTML מנוקה | רשימת היתרים של DOMPurify; שום JS לא רץ בדף |
| ` ```svg ` / ` ```live-svg ` | תצוגה מקדימה של SVG מנוקה בשורה | אותה הקשחה כמו HTML |
| ` ```live-js ` | ארגז חול של JS ‏(Worker מבודד) עם פלט קונסולה | מצבי stdout/stderr/שגיאה; מוגן במגבלת זמן; `shared` = סשן REPL אחד למסמך (ראו בהמשך) |
| ` ```live-lua ` / ` ```lua-live ` | ‏Lua 5.4 ‏(wasmoon WASM) ב-Web Worker, עם פלט `print`/`io.write` וערכים מוחזרים | נטען ב-Run; ‏wasm מאוחסן מקומית (בלי CDN); ‏`timeout=` ב-ms (ברירת מחדל 5000) |
| ` ```live-r ` / ` ```r-live ` | ‏R ‏(webR, ‏WebAssembly): פלט מודפס, הודעות, אזהרות, שגיאות וגרפים של base graphics | נטען בהרצה הראשונה (כ-45 MB, מאוחסן מקומית, במטמון); ‏`timeout=` ב-ms (ברירת מחדל 30000); ‏base R + החבילות המומלצות המצורפות, בלי התקנות מ-CRAN |
| ` ```live-ruby ` / ` ```ruby-live ` | ‏Ruby 3.4 ‏(ruby.wasm) ב-Web Worker בארגז חול: פלט `puts`/`warn`, הערך האחרון (`=> …`), שגיאות עם `block:<line>` | נטען בהרצה הראשונה (כ-30 MB, מאוחסן מקומית, במטמון); ‏`timeout=` ב-ms (ברירת מחדל 10000; לולאה שבורחת נהרגת); ספריית התקן המלאה (`require "json"`,‏ `set`, …), בלי gems; ‏VM חדש לכל הרצה; בלי רשת, אחסון או גשר ל-JS |
| ` ```playground [react\|vue] ` / ` ```web-playground ` | פרויקט רשת קטן מרובה קבצים שרץ חי: קבצים מופרדים בשורות `--- name.ext ---` ‏(HTML,‏ CSS,‏ JS,‏ JSX,‏ TS,‏ JSON); תצוגה, לשונית לכל קובץ, וקונסולה | רץ ב-iframe בארגז חול על מקור משלו (בלי גישה למסמכים שלכם); ‏JSX / TypeScript דרך Sucrase; ‏`react` / `react-dom` ‏(18) ו-`vue` ‏(3, עם מהדר התבניות) זמינים בלי רשת — חבילות אחרות לא; נקודת הכניסה היא `main.*`; ‏`height=` ב-px |
| ` ```live-css ` | תצוגה מקדימה של HTML+CSS ב-iframe בארגז חול | ‏`srcdoc` + דגלי sandbox |
| ` ```live-glsl ` / ` ```glsl ` / ` ```shader ` | ‏fragment shader של GLSL על מרובע | נטען מחדש בכל עריכה |
| ` ```bibtex ` / ` ```bib ` | רשימת ציטוטים (מעוצבת מ-BibTeX) | לחיצה ← העתקת ציטוט |
| ` ```database ` | שאילתת מסד נתונים על כל סביבת העבודה (ה-front matter של ה-Markdown כ״טבלה״) | שפת שאילתות של Lumen |
| ` ```insights ` / ` ```jsonl ` | מנתח JSONL: מסקנות, שכיחויות, גרפים, מחוללי קבצים | בלי מודל חיצוני |
| ` ```code-doctor ` / ` ```fix-json ` | תיקון JSON/JSONL פגום עם diff וממשק לאישור התיקון | מפרק סלחני ב-7 מעברים |

## JavaScript חי — scope משותף (REPL בין בלוקים)

כברירת מחדל כל בלוק ` ```live-js ` רץ ב-Web Worker חדש משלו, כך ששום דבר שבלוק
אחד מגדיר לא נראה לבלוק אחר. מוסיפים `shared` לגדר כדי להפוך את הבלוקים של
מסמך לסשן REPL אחד:

````markdown
```live-js shared
const prices = [12, 7, 30]
function total(xs) { return xs.reduce((a, b) => a + b, 0) }
```

Some prose in between…

```live-js shared
console.log(total(prices))   // 49
```
````

- כל בלוקי ה-`shared` של המסמך הפתוח משתמשים ב-**worker אחד**, וה-scope הגלובלי
  שלו נשמר בין הרצות ובין בלוקים. הצהרות `const` / `let` / `var`,‏ `function`
  ו-`class` ברמה העליונה הופכות לגלובליות של ה-worker הזה, כך שהרצות ובלוקים
  מאוחרים יכולים להשתמש בהן. הצהרות שמקוננות בבלוקים, בפונקציות או בראשי
  לולאות נשארות מקומיות.
- כמו בקונסולת דפדפן, הרצה חוזרת של בלוק יכולה להצהיר שוב על השמות שלו, והרצות
  מאוחרות יכולות להציב מחדש קישורי `const` ברמה העליונה.
- הבלוקים חולקים מצב לפי סדר ה**הרצה**. כל בלוק רץ כשהוא מוצג וכשלוחצים
  **Run**; ההרצות נכנסות לתור ורצות אחת אחרי השנייה.
- ‏`shared=name` (למשל ` ```live-js shared=physics `) נותן scope נפרד עם שם
  בתוך אותו מסמך. מסמכים שונים לעולם לא חולקים scope.
- **Reset scope** (מוצג על בלוקים משותפים) זורק את ה-worker ואת כל הגלובליים
  שבו; ההרצה הבאה מתחילה מאפס. אחרי זה הריצו שוב את הבלוקים שאתם תלויים בהם.
- הבידוד לא משתנה: ל-worker אין DOM ואין גישה לדף, המצב המשותף לא מוסיף תמיכה
  במודולים או בייבוא מהרשת (ה-CSP של הדף חל גם בתוך ה-worker), והרצה שעוברת
  את מגבלת 8 השניות נעצרת. חריגת זמן מסיימת את ה-worker, וגם זה מאפס את
  ה-scope.
- ‏scope שלא בשימוש נזרק חמש דקות אחרי שהבלוק המשותף האחרון של המסמך יורד
  מהמסך.

## Lua חי

````markdown
```live-lua height=200 timeout=3000
local function fib(n) return n < 2 and n or fib(n - 1) + fib(n - 2) end
for i = 1, 10 do io.write(fib(i), " ") end
print()
return _VERSION
```
````

לוחצים **Run** כדי להריץ. שום דבר לא מורד עד אז; ה-`glue.wasm` (כ-270 KB)
מצורף ל-Lumen ומוגש מאותו מקור, כך שהוא עובד בלי רשת ותחת ה-CSP של האפליקציה.
כל הרצה מקבלת Web Worker חדש ומצב Lua חדש:

- ‏`print` ו-`io.write` זורמים לחלונית הפלט; ערכים ש-`return` מחזיר מה-chunk
  מוצגים אחרי `→`.
- שגיאות מציגות את השורה (`block:2: boom`).
- לולאה שבורחת נעצרת אחרי `timeout` ms ‏(100–60000, ברירת מחדל 5000) בעזרת
  hook שסופר הוראות, והדף הורג את ה-worker אם הוא מפסיק להגיב. **Stop** מבטל
  הרצה.
- הערימה של Lua מוגבלת ל-64 MB והפלט שנאסף ל-200,000 תווים.
- ספריות התקן זמינות, חוץ מגישה לתהליכים ולקבצים: ‏`os.exit`,‏ `os.execute`,
  ‏`os.getenv`,‏ `os.remove`,‏ `os.rename`,‏ `io.open`,‏ `io.popen`,‏ `io.read`,
  ‏`require`,‏ `dofile`,‏ `loadfile` ו-`package` הוסרו. ‏Lua לא יכולה להגיע
  לאובייקטים של JavaScript.

## אבטחה והקשחה

כל מציגי ה-HTML, ה-SVG וההטמעות עוברים דרך `src/lib/markupSanitizer.ts`.
המנקה:

- מסיר כל תכונת `on*` בעזרת hook שמתאים לפי תחילית (לא רק לפי רשימת שמות, כך
  שגם מטפלים עתידיים כמו `onpointerdown` נתפסים).
- חוסם תכונות `style` שמכילות `expression(...)`,‏ `url(javascript:...)` או
  `behavior:`.
- מתיר רק כתובות `data:` של תמונות (כל השאר, כולל `data:text/html`, נזרק).
- דוחה `javascript:`,‏ `vbscript:` ופרוטוקולים לא מוכרים.

כל בלוק דינמי עטוף ב-`ErrorBoundary`, כך שבלוק שבור אחד לא מפיל את כל
התצוגה.

## טעינה עצלה

כל בלוק מיובא ב-`React.lazy`. הספרייה של בלוק (Mermaid,‏ ECharts,‏ Leaflet, …)
נטענת רק כשפותחים פתק שמשתמש בה, כך שהוספת סוגי בלוקים לעולם לא מגדילה את
חבילת ההפעלה. לחבילה הזו יש תקציב גודל שנבדק בכל pull request
(`scripts/bundle-budget.mjs`).

## כתיבת בלוק חדש

ראו [ערכת הפיתוח לתוספים](/plugins/sdk/) — כל בלוק הוא רכיב React שנרשם עם
`registerPlugin`. ה-`pluginSystem` מחבר את שפת הגדר שלו לתג, טוען אותו דרך
`Suspense`, ומעביר אותו דרך צינור העיבוד.

## Web Playground

````markdown
```playground react height=260
--- App.jsx ---
import { useState } from "react";
export default function App() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>;
}
--- main.jsx ---
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
createRoot(document.getElementById("root")).render(<App />);
--- style.css ---
button { font: 16px system-ui; }
```
````

- **קבצים:** ‏`--- name.ext ---` פותח קובץ. גוף בלי סימונים הוא קובץ אחד
  (`main.jsx` ל-React, ‏`main.js` אחרת). ‏`index.html` הוא גוף הדף (ברירת מחדל
  `<div id="root">`, או `<div id="app">` ל-Vue); תגי ה-`<script>` שלו לא רצים,
  אז שימו את הקוד בקבצים.
- **ייבוא:** ייבוא יחסי בין קבצים (עם הסיומת או בלעדיה), קובצי CSS / JSON,
  והחבילות שמסופקות: `react`,‏ `react-dom`,‏ `react-dom/client`,
  ‏`react/jsx-runtime` ו-`vue`.
- **בידוד:** כל Run טוען מסמך runner חדש ב-iframe בארגז חול עם מקור אטום
  ומדיניות אבטחת תוכן משלו. הפרויקט לא יכול לקרוא את האחסון, העוגיות או הדף של
  האפליקציה.
