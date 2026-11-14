---
title: יום מודלים אמיתיים
description: פקודה אחת שמריצה כל הערכה של מודל אמיתי על מחשב עם Ollama ו-GPU, ממשיכה אחרי עצירה, וכותבת דוח חתום אחד.
---

רוב בדיקות ה-AI של Lumen רצות בבדיקות מול **Ollama מזויף**. הן מוכיחות
שהחיבורים עובדים (פרומפטים, מפענחים, קריאות כלים), לא את איכות המודל.
המספרים האמיתיים צריכים מודל אמיתי על GPU אמיתי. `npm run models:day`
מריץ את כולם בבת אחת.

## לפני שמתחילים

```sh
npm ci
npm run models:day -- check
```

`check` לא מריץ כלום. הוא מראה מה חסר, ולצד כל פריט את פקודת ההתקנה
המדויקת:

- Node 22.6 ומעלה, ו-`npm ci`
- Ollama 0.5 ומעלה (structured outputs), פועל (`ollama serve`)
- GPU: ‏12 GB של VRAM, או Apple Silicon עם 16 GB לפחות
- המודלים, לפי תג מדויק: `ollama pull gemma3:12b`, `ollama pull qwen2.5:7b`,
  `ollama pull qwen2.5-coder:1.5b`, `ollama pull qwen3:0.6b`,
  `ollama pull nomic-embed-text` (כ-15 GB ביחד)
- ל-WER של ההכתבה: Python 3 עם `pip install -r scripts/golden/requirements.txt`, ו-ffmpeg
- למנועים בדפדפן: `npx playwright install chromium`

הריצה מושכת לבד מודלים חסרים, אלא אם מעבירים `--no-pull`.

## הרצה

```sh
npm run models:day
```

`npm run models:day -- plan` מראה את השלבים, מה כל שלב מודד, ואת הזמן
המוצהר שלו. השלבים שרצים כברירת מחדל מוצהרים ל-3 שעות לכל היותר על GPU
של 12 GB. שלב שהסקריפט שלו לא נמצא בענף הנוכחי מסומן **לא זמין**, עם
ה-PR שמוסיף אותו. שלב שצריך משהו שרק לך יש, כמו הקלטות הפגישות
(`--meetings-dir`), מסומן **חסום**. אף אחד מהם לא נחשב כישלון.

| שלב | מה הוא מודד |
|---|---|
| `agents-gemma3`, `agents-qwen` | המקרים של כל סוכן (יעד: 90% ומעלה ו-80% ומעלה) |
| `pdf-chat` | תשובות עם ציטוט לעמוד הנכון, ו-nDCG@5 של הציטוטים |
| `summarize` | משפטי סיכום שמעוגנים במקור |
| `fim` | השהיית השלמה אוטומטית p50 / p95 (יעד: p50 מתחת ל-300ms) |
| `real-tiny` | כל סוכן פעם אחת על `qwen3:0.6b` |
| `rerank` | ה-reranker על HeQ |
| `asr-zipformer`, `asr-web` | WER של ההכתבה על FLEURS-he validation (יעד: 15% לכל היותר) |
| `tool-calls` | קריאות כלים תקינות בשני המודלים (יעד: 95% ומעלה) |
| `bench-models` | כל מנוע בדפדפן ב-Chromium על WebGPU |
| `meetings`, `canvas-draw`, `crosslingual`, `lit-review` | ההערכה של כל פיצ׳ר |
| `dictalm3` (רשות: `--with dictalm3`) | DictaLM 3.0 מול `qwen3:4b` |
| `heldout` (כשמפתח המעריך קיים: `LUMEN_HELDOUT_KEY` או `--heldout-key-file`) | ששת [הסטים המוחזקים](/he/ai/heldout/), אחרי סריקת הזיהום |

## עצירה והמשך

התוצאה של כל שלב נשמרת ברגע שהשלב מסתיים. אפשר ללחוץ Ctrl-C בכל רגע
ולהריץ שוב את אותה פקודה: שלבים שהסתיימו נשמרים, והשלב שרץ מתחיל מחדש.
`--redo <step>` מריץ שוב שלב שהסתיים, ו-`--fresh` פותח ריצה חדשה.

## הדוח

הכול נכתב ל-`eval/results/day/<run>/`:

- `<step>/`: הקבצים של ההערכה עצמה, ו-`log.txt`
- `report.md`: טבלה לכל שלב ולכל סוכן, ואיזו משימה בתוכנית כל שלב מכסה
- `report.json`: ה-commit, המחשב, ה-GPU, ה-digest של כל מודל ב-Ollama,
  וכל קובץ עם ה-sha256 שלו. **קבלה** (sha256 על הדוח כולו) חותמת אותו.

`--sign-key key.pem` חותם את הקבלה גם ב-Ed25519 (יוצרים מפתח עם
`openssl genpkey -algorithm ed25519 -out key.pem`). בדיקת דוח:

```sh
npm run models:day -- verify eval/results/day/<run>/report.json
```

הבדיקה נכשלת אם הדוח או קובץ תוצאה כלשהו השתנו אחרי הריצה. אם השרת היה
המזויף מהבדיקות (`npm run fake-ollama`), הדוח כולו מסומן **WIRING RUN, NOT A MODEL SCORE**.
