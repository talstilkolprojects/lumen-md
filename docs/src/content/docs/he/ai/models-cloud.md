---
title: יום מודלים על GPU חינמי בענן
description: פקודה אחת מריצה את יום המודלים האמיתי, כולל הסטים המוחזקים, על GPU חינמי של Kaggle, ומחזירה את הדוח החתום. ה-Mac של טל הוא רק גיבוי.
---

[יום המודלים האמיתיים](/he/ai/models-day/) צריך GPU. עד עכשיו זה היה ה-Mac
של טל וכשעתיים מזמנו. `npm run models:cloud` מריץ את אותו יום על GPU חינמי
של Kaggle ומחזיר את הדוח החתום. הצעד היחיד של הבעלים הוא להפעיל את החשבון,
פעם אחת.

## הצעד של הבעלים (פעם אחת, כ-5 דקות)

1. להתחבר ל-kaggle.com.
2. **Settings ← Phone verification.** ‏Kaggle צריך מספר טלפון מאומת כדי לתת
   GPU וגישה לאינטרנט במחברות.
3. **Settings ← API ← Create New Token.** לשים את `kaggle.json` שירד
   ב-`~/.kaggle/kaggle.json` (`chmod 600`) במחשב שמריץ את הפקודה, או להגדיר
   `KAGGLE_USERNAME` ו-`KAGGLE_KEY`.

`npm run models:cloud -- setup` בודק את כל זה, וגם את המפתח של
[הסטים המוחזקים](/he/ai/heldout/).

## הפקודה

```sh
pip install kaggle
npm run models:cloud                       # שליחה, המתנה (עד 12 שעות), הורדה ובדיקה
npm run models:cloud -- --ref verify/train-2 --no-wait
npm run models:cloud -- fetch <run> --push # אחר כך; ‏--push שומר אותו בענף eval/day-<run>
```

מה הפקודה עושה:

1. היא יוצרת שני מפתחות לריצה אחת: מפתח Ed25519 שחותם על הדוח, ומפתח
   X25519 לעותק של הסטים המוחזקים (`npm run heldout -- export`). המפתח של
   המעריך עצמו לא יוצא מהמחשב הזה.
2. היא מעלה אותם, יחד עם `run.json` (ה-commit והארגומנטים של models:day),
   כ-dataset **פרטי** ב-Kaggle.
3. היא שולחת את `scripts/cloud/kaggle_kernel.py` כ-kernel פרטי מסוג script,
   עם GPU ‏(`NvidiaTeslaT4`, שני T4 עם 16GB כל אחד) ועם אינטרנט.
4. ה-kernel מתקין Node 22, ‏Ollama, ‏ffmpeg ואת הריפו ב-commit הזה, מריץ
   `npm ci` ומפעיל את `ollama serve`. אחר כך הוא מריץ את `npm run models:day`
   עם מפתח החתימה של הריצה ועם `--with dictalm3`, ולכן הריצה מכסה את
   `qwen2.5:7b`, ‏`gemma3:12b`, ‏`qwen2.5-coder:1.5b` ‏(FIM) ו-DictaLM 3.0
   1.7B. הוא גם נותן ציון לסטים המוחזקים מעותק הריצה. בסוף הוא משאיר את
   `results.tar.gz` ואת `cloud.json`.
5. הפקודה מורידה אותם ובודקת את הקבלה ואת כל קובץ. היא גם בודקת שהחתימה היא
   של המפתח של **הריצה הזאת**, שה-commit הוא זה שהיא ביקשה, שרצו מודלים
   אמיתיים (לא המזויף), ושנמצא GPU. רק אז היא פורסת ל-`eval/results/day/<run>/`.

היא מדפיסה את קבלת W6.18 כפי שנמדדה:

- המודלים שיש להם digest של Ollama (היעד: לפחות 4);
- שיעור קריאות הכלים מול היעד של 95%, ופער אם יש, כפי שהוא;
- משימות ה-AI שיש להן עכשיו מספר אמיתי.

## הכתבה בעברית, בכל מסלול

הריצה מודדת הכתבה בעברית כמו שכל מכשיר מריץ אותה, ב-FLEURS-he validation
ובסט המוחזק `asr-he`:

| מסלול | מנוע | שלב | יעד |
|---|---|---|---|
| טלפון ודפדפן, בזמן אמת | Zipformer2 בהזרמה | `asr-zipformer` | ‏≤ 15% |
| דפדפן, כל משפט או קובץ | ה-turbo של ivrit.ai (קובצי ה-ONNX של האפליקציה, q4f16) | `asr-web` | ‏≤ 15% |
| מחשב שולחני | whisper.cpp עם ה-ggml של ה-turbo של ivrit.ai | `asr-whisper-cpp` | ‏≤ 10% |

השלב המוחזק מדרג את `asr-he` דרך שלושתם, על אותם קטעים. `fetch` מדפיס את
המספר של כל מסלול, אם עמד ביעד או לא, או למה לא נמדד, ואומר מתי ״שליחה
למחשב שלי״ היא הדרך של הטלפון ליעד (הטלפון מעל 15% והמחשב עומד בו).

- `asr-web` מריץ את קובצי המודל של האפליקציה על המעבד (onnxruntime-node),
  ולכן ה-WER שלו הוא של המודל, והוא רץ בענן. רק ההשהיה ב-WebGPU באה
  מ-`bench-models` ב-Mac. ‏Ozen v1 לא נמדד כל עוד הוא כבוי (הרישיון של
  נתוני האימון שלו עוד לא הוסדר).
- למחשב השולחני, ה-kernel בונה את whisper.cpp בתגית גרסה (CUDA על ה-T4,
  ואם זה נכשל, על המעבד) ומוריד את קובץ ה-ggml של ה-turbo של ivrit.ai.
  האפליקציה עוד לא נועצת את הקובץ, ולכן `cloud.json` שומר את המאגר,
  הגרסה, הגודל, ה-sha256 והרישיון שנמדדו, ו-`fetch` מדפיס את הפקודה
  `pin` של סקריפט ה-Whisper השולחני (`whisper:desktop`, ‏W1.17) עם הערכים האלה. אם whisper.cpp לא נבנה
  או שאין קובץ, השלב מדווח כחסום.
- מחוץ ל-kernel, מעבירים ל-`npm run models:day` את
  `--whisper-ggml <file>` (ואת `--whisper-cli`).

## רק הכתבה, בפקודה אחת

```sh
npm run models:cloud -- dictation
```

הפקודה מריצה רק את שלבי ההכתבה בעברית (`asr-zipformer`, `asr-web`,
`asr-whisper-cpp`, והסט המוחזק `asr-he` דרך שלושתם), מחכה ל-Kaggle, בודקת
את הדוח החתום כמו למעלה, ודוחפת את `eval/day-<run>`. הענף הזה גם מעדכן את
`src/ai/dictation/measuredWer.json`, המספרים ש״שליחה למחשב שלי״ קוראת
([הכתבה בעברית](/he/ai/hebrew-dictation/)), כך שהוא מוכן לבדיקה כמו שהוא.
צריך את הצעד של הבעלים שלמעלה ואת המפתח של הסט המוחזק; `--no-push` משאיר
את התוצאה מקומית, ו-`--ref` בוחר commit אחר שנדחף. `fetch` עדיין מדפיס את
הפקודה `whisper:desktop -- pin` לקובץ ה-ggml שנמדד.

`asr-whisper-cpp` הוא שלב רשות של models:day ‏(`--with asr-whisper-cpp`),
כך שיום ברירת המחדל נשאר בתוך שלוש השעות. ההרצה בענן תמיד מוסיפה אותו, כי
ה-kernel בונה את whisper.cpp.

## מה נשאר ל-Mac של טל

השלב שצריך WebGPU בדפדפן אמיתי: `bench-models`. ה-kernel מדלג עליו.
`npm run models:cloud -- mac` מריץ את כל היום במחשב המקומי, כמו קודם.

## למה Kaggle

השוואה מ-12.11.2026:

| אפשרות | GPU | מגבלות | בלי ממשק | החלטה |
|---|---|---|---|---|
| **Kaggle Notebooks** | שני T4 או P100 ‏(16GB) | כ-30 שעות GPU בשבוע (מוצג בהגדרות); עד 12 שעות לריצה; אימות טלפון | כן: `kaggle kernels push / status / output` | **נבחר** |
| Google Colab (חינם) | משתנה, בדרך כלל T4 | לא מפורסמות; עד 12 שעות | אין API. ה-FAQ אוסר לעקוף את ממשק המחברת ושליטה מרחוק בזמני ריצה חינמיים | לא מתאים לריצה בלי אדם |
| Lightning AI (חינם) | דרך קרדיטים לקידום מכירות | סטודיו CPU חינמי אחד; הקרדיטים יכולים להשתנות בכל רגע | יש SDK, אבל זמן ה-GPU החינמי לא מובטח | לא נבחר |
| Hugging Face ZeroGPU | חצי RTX Pro 6000 | 5 דקות GPU ביום לחשבון חינמי, ‏Gradio בלבד, ברירת מחדל של 60 שניות לקריאה | לא: פונקציות בתוך Space של Gradio | לא יכול להריץ את models:day |

ב-Kaggle אפשר להריץ את `ollama serve` כתהליך ברקע בתוך kernel, יחד עם
llama.cpp (ש-Ollama משתמש בו) ועם Whisper (ב-Python, או במנוע ה-ONNX של
הריפו ב-Node). סודות שמצורפים דרך הממשק של Kaggle לא נשמרים כששולחים kernel
דרך ה-API. לכן מפתחות הריצה עוברים ב-dataset הפרטי של הריצה.

**סיכונים:** ‏Kaggle יכול לשנות את המכסה או את התנאים. ריצה אחת משתמשת בכמה
שעות מהמכסה השבועית. ה-dataset של הריצה (מפתחות לריצה אחת ועותק הסטים
המוחזקים) נשאר פרטי בחשבון של הבעלים.

מקורות: [Kaggle CLI: kernels](https://github.com/Kaggle/kaggle-api/blob/main/docs/kernels.md),
[מטא-דאטה של kernel](https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels_metadata.md),
[NVIDIA על 30 השעות בשבוע](https://developer.nvidia.com/blog/how-kaggle-makes-gpus-accessible-to-5-million-data-scientists/),
[fast.ai: אימות טלפון ל-GPU](https://course.fast.ai/Resources/kaggle.html),
[GPU חינמי ב-2026 (ריצות של 12 שעות)](https://gpuperhour.com/blog/free-cloud-gpus-and-credits),
[ה-FAQ של Colab](https://research.google.com/colaboratory/faq.html),
[החיוב ב-Lightning AI](https://lightning.ai/docs/platform/overview/faq/billing.md),
[התיעוד של ZeroGPU](https://huggingface.co/docs/hub/spaces-zerogpu),
[סודות מהממשק נעלמים בשליחה דרך ה-API](https://huggingface.co/spaces/cuilabs/bee/blob/main/scripts/bootstrap_kaggle_secrets.py),
[Ollama במחברת Kaggle](https://dev.to/ifeanyi_idiaye_3f6d81ed8a/run-deepseek-r-1-thinking-model-in-kaggle-notebook-using-ollama-5195).
