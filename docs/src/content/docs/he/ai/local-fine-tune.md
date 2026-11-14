---
title: אימון מודל על הסגנון שלך, במחשב הזה
description: מתאם LoRA שמאומן על הפתקים שלך במחשב Mac או NVIDIA ומשמש ב-Ollama. שום דבר לא עולה לרשת.
---

`⌘K ← אימון ה-AI על הסגנון שלי` מציע עכשיו **קודם את המסלול המקומי**. Lumen מייצא את הפתקים שלך כנתוני אימון יחד עם סקריפט. מריצים את הסקריפט במחשב שלכם, והתוצאה מופיעה ב-Ollama כמודל `lumen-style`. האימון בענן (OpenAI) עדיין מוצע מתחתיו.

## שלבים

1. בוחרים את הפתקים ללמוד מהם (תיקייה, או את כולם) ואת סוג המחשב, ולוחצים על **ייצוא נתוני האימון והסקריפט**. מתקבל `lumen-lora.zip`, ובו:
   - `train.jsonl` ו-`valid.jsonl`: דוגמאות בפורמט שיחה, חתוכות מהפרוזה של הפתקים. frontmatter, קוד וטבלאות לא נכללים. כשיש [פרופיל סגנון](/he/ai/agents/), הטון והכללים שלו נכנסים להנחיית המערכת.
   - `heldout.json`: בערך פתק אחד מכל עשרה, שלא מאמנים עליו לעולם. הוא משמש לבדיקת התוצאה.
   - `train-mac.sh` או `train-nvidia.sh`.
2. פותחים את הקובץ ומריצים את הסקריפט בתיקייה שלו.
   - **Mac (Apple silicon):** הסקריפט מריץ `mlx_lm.lora` על Mistral 7B Instruct (Apache-2.0), אחר כך `mlx_lm.fuse --export-gguf`, ויוצר Modelfile עם `FROM` של ה-GGUF. MLX יכול לייצא GGUF רק עבור Llama,‏ Mistral ו-Mixtral, ולכן מודל הבסיס הוא Mistral.
   - **NVIDIA:** הסקריפט מאמן עם PEFT דרך ספריית הליבה של Unsloth (Apache-2.0). הוא לא משתמש ב-Unsloth Studio, שהוא AGPL. אחר כך הוא ממיר את המתאם עם `convert_lora_to_gguf.py` של llama.cpp ויוצר Modelfile עם `ADAPTER`.
3. בוחרים את `lumen-style` כמודל Ollama בהגדרות ה-AI.

## האם הוא קרוב יותר לסגנון שלך?

```bash
node scripts/lora/style-eval.mjs --heldout heldout.json --base mistral:7b-instruct --tuned lumen-style
```

שני המודלים ממשיכים את הפתיחה של כל פתק שמור. הסקריפט מקודד את ההמשכים ואת הפתקים השמורים עם מודל ה-embeddings המקומי שלכם (`nomic-embed-text` כברירת מחדל) ומשווה את ממוצע ה-cosine לפתקים השמורים. היעד הוא שיפור של לפחות 10% לעומת מודל הבסיס. הכול רץ מול ה-Ollama המקומי שלכם.
