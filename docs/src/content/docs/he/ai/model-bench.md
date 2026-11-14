---
title: מדידת המודלים המקומיים
description: הפקודה npm run bench:models מריצה כל מנוע מקומי על סט הזהב שלו בדפדפן אמיתי, עם WebGPU, וכותבת זמן, זיכרון ואיכות ל־models/registry.json.
---

המנועים המקומיים של לומן נמדדים במקום שבו הם רצים: בדפדפן, דרך הקוד של
האפליקציה עצמה (ה־worker של transformers.js,‏ tesseract.js), על סטי
הזהב שב־`eval/golden/`. המספרים נכתבים ל־`models/registry.json`, ליד
הרישיון של כל מודל.

## הרצה

במחשב עם GPU:

```bash
npm ci
npx playwright install chromium     # פעם אחת
npm run bench:models
```

הפקודה:

1. מפעילה את שרת הפיתוח של Vite ופותחת את `bench/models.html` ב־Chromium,
   בחלון, עם WebGPU.
2. לכל מנוע:
   - טוענת את המודל פעם אחת, כדי שיורד ויישמר במטמון.
   - פותחת דף חדש ומודדת אותו.
3. מדפיסה טבלה וכותבת את המספרים ל־`eval/results/bench-models-<date>.json`.

שום דבר בטבלה או בקובץ אינו פריט, קלט או פלט: רק מספרים.

כדי לשמור את המספרים ברישום:

```bash
npm run bench:models -- --write
```

## מה נמדד

| מספר | מה הוא |
|---|---|
| `loadMs` | טעינת המודל מהמטמון של הדפדפן (הטעינה הראשונה, עם ההורדה, לא נספרת, אלא עם `--no-prime`) |
| `prepareMs` | עבודה שנעשית פעם אחת לכל חלק, למשל הטמעת הקורפוס |
| `p50Ms`,‏ `p95Ms` | הזמן לכל פריט |
| `rssPeakMB`,‏ `rssDeltaMB` | הזיכרון של כל הדפדפן (הדף, ה־workers ותהליך ה־GPU) בשיאו, ומעל הדף במנוחה |
| `jsHeapPeakMB` | ערימת ה־JavaScript של הדף בשיאה |
| `quality` | המדד של הסט עצמו: nDCG@10 לאחזור, CER ל־OCR (לפי מצב), WER ו־CER לדיבור |

דף אינטרנט לא רואה את זיכרון ה־GPU עצמו. הגודל של תהליך ה־GPU, שנספר
ב־`rssPeakMB`, הוא המספר הקרוב ביותר.

## מנועים

| מנוע | סט | מודל |
|---|---|---|
| ‏`bm25` | retrieval | אין: קו הבסיס, מדווח ולעולם לא נכתב |
| ‏`bge-rerank` | retrieval | ‏`onnx-community/bge-reranker-v2-m3-ONNX` על 20 המועמדים של BM25 |
| ‏`e5` | retrieval | ‏`Xenova/multilingual-e5-small`, צפוף, על כל הקורפוס |
| ‏`tesseract` | ocr-he | ‏`tessdata_fast` עברית ואנגלית |
| ‏`whisper-tiny`,‏ `whisper-small`,‏ `whisper-turbo` | asr-he | ‏`onnx-community/whisper-*` |

כל מנוע הוא קובץ ב־`src/bench/engines/`. הקובץ מייצא `BenchEngine` עם:

- מזהה;
- סט הזהב שעליו המנוע נמדד;
- המזהים של המודלים שלו ברישום;
- שלוש פונקציות: `load`, ‏`prepare` (רשות) ו־`run`.

איך כל סט מקבל ציון נקבע ב־`scripts/bench/tasks.mjs`. תכונה שמוסיפה מנוע
מקומי מוסיפה שם את המתאם שלו, וההרצה הבאה מודדת גם אותו.

## מתי המספרים לא נכתבים

‏`--write` שומר תוצאה בתור `measured.<device>` של כל מודל של המנוע רק
כשהתוצאה אמיתית ושלמה:

- בהרצה לא הייתה שגיאה.
- כל פריט בכל חלק נמדד: לא עם `--limit`, ובסט הבדיקה אף חלק לא קטן
  מהגודל שלו.
- המנוע הוא מודל, לא קו הבסיס.
- הרצה ב־WebGPU באמת רצה ב־WebGPU, על GPU אמיתי. הרצה שנפלה ל־WebAssembly
  אינה מספר של WebGPU. גם הרצה על SwiftShader אינה: זו הדמיה במעבד
  ש־Chromium מציע במצב headless כשאין GPU.

## אפשרויות

| אפשרות | משמעות |
|---|---|
| ‏`--engines a,b` | רק המנועים האלה |
| ‏`--backends webgpu,wasm` | גם WebAssembly: הדף לא רואה WebGPU, ולכן האפליקציה בוחרת wasm כמו במכשיר כזה |
| ‏`--split test --dir <dir>` | סט הבדיקה החסוי (נבנה ב־CI) |
| ‏`--limit N` | N הפריטים הראשונים בכל חלק: בדיקה מהירה, לעולם לא נכתבת |
| ‏`--channel chrome` | Chrome המותקן במקום ה־Chromium של Playwright |
| ‏`--headless` | בלי חלון (WebGPU פחות אמין כך) |
| ‏`--url <url>` | שימוש בשרת פיתוח שכבר רץ |
