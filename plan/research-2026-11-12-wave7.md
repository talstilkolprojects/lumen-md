# גל 7 — הרחבות ומחקרים חדשים: ממצאים, מקורות ורעיונות שנדחו

*12.11.2026. בסיס: `origin/chore/dod:plan/plan.json` (280 משימות, W1–W5), ‏`plan/research-2026-11-12.md`, וגם `research/wave6.json` (48 משימות של סשן מקביל), כדי לא לשכפל. כל המקורות נקראו בסשן הזה, אלא אם כתוב אחרת. המשימות נמצאות ב-`research/wave7.json`: ‏25 משימות, ‏9 ב-P1 ו-16 ב-P2, כ-185 שעות, ו-7 מסומנות ★.*

**כללים שנבדקו בסקריפט:**
- סדר המפתחות זהה לתוכנית.
- כל `dep` קיים ב-plan.json.
- אף P1 לא תלוי ב-P2.
- הדומיין שאינו שלנו לא מופיע.
- אין שימוש ב-GitHub Actions.

הפניות למשימות W6.x ול-W7.x מופיעות רק בתוך הצעדים, לא ב-`dep`.

---

## 1. מה המובילים שלחו ב-2026, ומה חסר ל-Lumen

| כלי | מה יצא (תאריך) | מה חסר אצלנו | משימה |
|---|---|---|---|
| Heptabase | מיומנויות AI דרך ״/״ (23.7), ‏״Break down book״ (14.8), חיפוש ומיון ב-backlinks וייצוא CSV (27.8), חיפוש בבלוקי קוד ורשימות מקופלות (31.8), ‏MCP ל-Claude Code, ‏ChatGPT ו-Codex (3.11), ‏CLI 0.10 (6.11) | מיומנויות שהמשתמש מגדיר; חיפוש ב-backlinks | W7.1, ‏W7.3 |
| Readwise | ‏Global Ghostreader עם starter skills, ‏Readwise 2.0 שסורק הדגשות עט ומרקר מספרים מודפסים, ‏MCP ו-CLI (8.2026) | סריקת הדגשות מנייר; מיומנויות | W7.2, ‏W7.1 |
| Zotero 8 / 9 | ‏8.0 (22.1.2026): דיאלוג ציטוט מאוחד, הערות ברשימת הפריטים, ערכות נושא לקורא, שינוי שם רציף של קבצים מצורפים. ‏9 (עד 4.2026): הקראה, שמירת מיקום, הערות אוטומטיות, ציטוטים פעילים | רוב זה כבר בתוכנית (W2.16, ‏W1.14, ‏W2.6, ‏W6.47) | — |
| Obsidian 1.12 (27.2.2026) | ‏CLI, גרירת גודל תמונה, ניקוי קבצים מצורפים במחיקה, שמירת HTML בהעתקה, סרגל חיפוש ב-Bases | הגרירה, הניקוי וההעתקה כ-HTML | W7.3 |
| Tana (5.2026) | ‏Types ו-Attributes, סיכום פגישה חי, סוכן קולי ״Hey Tana״, סוכנים מוגדרים בשפה טבעית שרצים לפי לוח זמנים, אישור לפני שינויי AI | רוב זה בתוכנית (W2.7, ‏6.16, ‏W5.20, ‏W5.24, ‏5.11) | — |
| Capacities | גרסה 70: ‏CalDAV, היסטוריית גרסאות והערות PDF. גרסה 71: עריכת מאפיינים בכמות, הקלטה ותמלול. גרסה 72: לוחות לבנים וגרף גלובלי | ‏CalDAV; עריכה בכמות | W7.20, ‏W7.4 |
| iA Writer 8 (17.6.2026) | ‏Liquid Glass, מתאר, פלטת פקודות, צבעי מחבר | צבעי מחבר כבר ב-5.9 | — |
| AnythingLLM 1.14.1 | ‏Meeting Assistant עם זיהוי דוברים, ‏custom skills עם בקשת אישור, צילומי מסך ב-HD לעוזר שולחן העבודה | צילום מסך לפתק; מיומנויות | W7.16, ‏W7.1 |
| Khoj | חיפוש מקומי, צ׳אט עם מודל מקומי או בענן, ‏Org/Markdown/PDF/Notion | אין פער חדש (5.4, ‏6.8) | — |

**הערות:**
- **Anytype, ‏Craft, ‏Bear, ‏AFFiNE, ‏Logseq ו-Reflect** נסקרו ב-`research-2026-11-12.md`, ולא מצאתי אצלם חידוש מאז.
- **Reor:** לא מצאתי מקור עדכני מ-2026.

**מקורות:**
- https://wiki.heptabase.com/changelog
- https://readwise.io/reader/update-aug2026
- https://www.zotero.org/support/8.0_changelog
- https://www.mondragon.edu/en/web/biblioteka/-/gestor-bibliografico-zotero-9
- https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/
- https://outliner.tana.inc/blog/tana-current-may-2026
- https://capacities.io/whats-new
- https://9to5mac.com/2026/06/17/ia-writer-8-brings-liquid-glass-design-clear-icon-support-more/
- https://docs.anythingllm.com/changelog/v1.14.1
- https://docs.khoj.dev/features/all_features
- https://tessl.io/registry/skills/github/kepano/obsidian-skills/obsidian-bases

---

## 2. עברית וישראל: מה שאף אחד לא נותן היטב

### Dicta

- **DictaLM 3.0 24B Thinking:**
  - **רישיון:** ‏Apache-2.0, לפי כרטיס המודל.
  - **בסיס:** ‏Mistral-Small-3.1-24B.
  - **תאריך:** 1.12.2025.
  - **יכולות:** קריאת כלים.
  - **מסקנה:** זה עדכון ל-W2.4, שם ה-24B עדיין מסומן "רישיון null", ולא משימה חדשה. צריך לרשום שם את הרישיון המאומת.
- **ה-API של הנקדן:** לא מצאתי תנאי שימוש רשמיים. התוצאה היחידה בשם "Dicta" הייתה מוצר אחר שאינו קשור (dicta-web.onrender.com). לכן לא שולחים טקסט לנקדן בענן. W2.5 (DictaBERT-char-menaked, ‏CC BY 4.0, מקומי) נשאר הדרך.

**מקורות:**
- https://featherless.ai/models/dicta-il/DictaLM-3.0-24B-Thinking/readme
- https://dicta-web.onrender.com/terms.html

### הקראה עברית

**אין עדיין קול עברי עצבי שמותר להפיץ.**

- **ה-checkpoints של Phonikud:** ‏"non commercial (cc-nc)".
- **ILSpeech:** ‏"Non commercial" (כשעתיים, שני דוברים).
- **MMS ו-SASPEECH:** ‏NC, כפי שכבר כתוב ב-6.2.
- **מה כן אפשר:** ‏Phonikud מציין שאפשר לכוונן TTS עם שעתיים של נתונים, ושהוא עובד עם Piper. ‏ReNikud (IEEE SLT 2026) משפר את ה-G2P.
- **רישיון הקוד** של שני הפרויקטים לא מופיע בדפים שנקראו, וצריך לאמת אותו בשער 0.10.
- **המסקנה:** ההקראה העברית תשתחרר רק מקורפוס CC0 משלנו (W7.10).

**מקורות:**
- https://huggingface.co/Phonikud/phonikud-tts-checkpoints
- https://huggingface.co/datasets/Phonikud/ILSpeech
- https://phonikud.github.io/
- https://renikud.github.io/

### נתונים ממשלתיים

- **הלמ״ס:**
  - **רישיון:** "רישיון פתוח למידע", גרסה 2.1 (3.1.2016).
  - **מה מותר:** שימוש מסחרי ויצירות נגזרות.
  - **ייחוס:** חובה, בנוסח קבוע: שם המוצר, תאריך השליפה, קישור לנתונים וקישור לתנאים.
  - **מה אסור:** הצלבה לזיהוי אנשים.
- **data.gov.il:**
  - **ה-FAQ:** מתיר שימוש חופשי, עם ציון שם האתר, שם המאגר ותאריך העדכון (כך צוטט בדיון OSM; דף הרישיון עצמו לא נפתח בסשן).
  - **ה-API:** ‏CKAN ‏`datastore_search`, בלי מפתח.
  - **משימה:** W7.6.

**מקורות:**
- https://www.cbs.gov.il/he/Pages/%D7%A8%D7%99%D7%A9%D7%99%D7%95%D7%9F-%D7%A9%D7%99%D7%9E%D7%95%D7%A9.aspx
- https://community.openstreetmap.org/t/new-gov-data-source/61963
- https://apis-hub-eosin.vercel.app/en/guides/datagov-il-ckan-beginner-guide

### חקיקה והכנסת

- **סעיף 6 לחוק זכות יוצרים, תשס״ח-2007:** "לא תהא זכות יוצרים בחוקים, בתקנות, בדברי הכנסת ובהחלטות שיפוטיות". לכן מותר לשמור עותק מלא.
- **OData של הכנסת:**
  - **התוכן:** ‏44 טבלאות וכ-1.5 מיליון רשומות (knesset-data).
  - **אי-עקביות:** הרישיון במאגר הנגזר לא עקבי (odc-by מול CC-BY-SA-4.0). אנחנו שולפים מהמקור, לא מהמאגר הנגזר.
  - **גרסה:** ‏Knessy (MIT) מתאר את ה-API כ-v3, ו-knesset-data כ-v4. צריך לבדוק בזמן המימוש.
- **משימה:** W7.5.
- **פסקי דין:** בשלב ב׳ בלבד, אחרי בדיקת תנאים.

**מקורות:**
- https://sherut.haifa.ac.il/extprojects/scill/images/pdf/Copyright_Law_2007_Hebrew.pdf
- https://huggingface.co/datasets/ZeAlenu/knesset-data/blob/main/README.md
- https://github.com/amnir/knessy

### כתב יד עברי

**אין פתרון פתוח ושמיש.**
- **HebHTR:** מזהה רק מילה בודדת, אין לו רישיון, והמאגר בארכיון מ-3.3.2024.
- **מחקר גרונינגן (2025):** עסק במגילות ים המלח, עם תוצאות חלשות.
- **LightOnOCR-2-1B (Apache):** אין עדות לעברית.
- **Qwen3-VL-2B (Apache):** ‏OCR ב-32 שפות, ולא ידוע אם עברית ביניהן.
- **HebOCRBench:** מוציא במפורש כתב יד מחבילת הדפוס.

**המסקנה:** מדד מוחזק, ואחריו דיו מקוון (W7.11). ‏HebOCRBench משמש מדד חיצוני לדפוס (W7.12).

**מקורות:**
- https://github.com/Lotemn102/HebHTR
- https://arxiv.org/abs/2508.10356
- https://www.themoonlight.io/review/lightonocr-a-1b-end-to-end-multilingual-vision-language-model-for-state-of-the-art-ocr
- https://featherless.ai/models/Qwen/Qwen3-VL-2B-Instruct
- https://huggingface.co/datasets/ssdataanalysis/hebocrbench-v1

### יידיש ולדינו

- **מילון YIVO ליידיש (Hunspell):**
  - **הבעיה:** הרישיון בדף לא עקבי. בטבלה כתוב CC BY 4.0, ובתיאור כתוב GPLv3+ או CC BY-SA 3.0.
  - **ההחלטה:** הורדה ביוזמת המשתמש בלבד, לא אריזה בבנייה.
- **לדינו:**
  - **מה קיים:** מילון מקוון (CC BY-SA 4.0).
  - **מה חסר:** אין קובץ Hunspell שעובד.
  - **ההחלטה:** טבלת תעתיק משלנו (W7.9).

**מקורות:**
- https://extensions.libreoffice.org/extensions/yiddish-spell-checker-yivo
- https://mailman.cs.huji.ac.il/pipermail/linux-il/2022-June/013551.html

### לוח אקדמי

- **הפורמט:** כל מוסד מפרסם PDF משלו. אוניברסיטת חיפה פרסמה את תשפ״ז ב-27.11.2025: סמסטר א׳ מ-11.10.2026, מועד א׳ 11.1–5.2.2027, מועד ב׳ 7.2–28.2.2027.
- **זכויות:** תאריכים הם עובדות, ולכן חבילת נתונים בריפו לא מעוררת שאלת זכויות.
- **משימה:** W7.8.

**מקור:**
- https://www.haifa.ac.il/wp-content/uploads/2025/12/2026-7.pdf

### פרויקט בן-יהודה

- **ההיקף:** ‏67,141 יצירות של 4,185 יוצרים.
- **הזכויות:** חלק מהיצירות ברשות הציבור, וחלק פורסמו באישור היוצרים.
- **ה-dump:** קיים dump ציבורי של יצירות רשות הציבור בלבד (עודכן 7.3.2026). הרישיון שלו לא הופיע בדף שנקרא.
- **משימה:** W7.7.

**מקורות:**
- https://benyehuda.org/page/english
- https://relatedrepos.com/gh/projectbenyehuda/public_domain_dump

---

## 3. AI מקומי שמעשי ב-2026

### embeddings ו-reranker

- **EmbeddingGemma 2 (6.10.2026):**
  - **רישיון:** ‏Apache-2.0, בלי שער גישה.
  - **שפות:** יותר מ-140.
  - **ממדים:** ‏Matryoshka, ‏768→512/256/128.
  - **זיכרון:** כ-191MB לטקסט בלבד.
- **Qwen3-Reranker-0.6B:** ב-ONNX, ‏Apache, ‏q4 או int8, ‏WebGPU, ‏`pipeline('text-ranking')`.
- **Qwen3-Embedding-0.6B:**
  - **מה ידוע:** ‏ONNX קיים לפי תוצאות החיפוש.
  - **מה לא אומת:** הדף נחסם בסשן (PROVENANCE_REQUIRED). צריך לאמת אותו בשער 0.10.
- **הבעיה בסט הקיים:** ב-7.6 גם BM25 לבד וגם עם reranker קיבלו nDCG@10 = 1.0, כלומר הסט רווי.
- **המסקנה:** סט קשה, ואחריו תחרות בין המודלים (W7.13).

**מקורות:**
- https://mixed-news.com/en/?p=35813
- https://huggingface.co/onnx-community/Qwen3-Reranker-0.6B-ONNX

### transformers.js 4

- **מה חדש (9.2.2026):** ‏runtime של WebGPU שנכתב מחדש ב-C++, ‏bundle ‏web קטן ב-53%, ותמיכה במודלים מעל 8B.
- **מה זה אומר לנו:** אנחנו כבר על 4.3.1, ולכן אין משימת שדרוג.

**מקור:**
- https://huggingface.co/blog/transformersjs-v4

### AI מובנה ב-Chrome

- **Translator, ‏Language Detector ו-Summarizer:** יציבים מ-Chrome 138. ‏Translator תומך ב-`he`, בשולחן עבודה בלבד.
- **Prompt API:**
  - **זמינות:** לאתרים ב-Chrome 148, לפי הטבלה. הטקסט באותו דף לא עקבי.
  - **פלט מובנה:** ‏`responseConstraint` עם JSON Schema, מ-Chrome 137.
  - **עברית:** הדף לא אומר אם היא נתמכת, ולכן צריך למדוד.
- **Summarizer:** אנגלית בלבד, כפי שכבר כתוב ב-6.11.
- **משימה:** W7.14.

**מקורות:**
- https://developer.chrome.com/docs/ai/built-in-apis
- https://developer.chrome.com/docs/ai/structured-output-for-prompt-api?hl=en
- https://developer.chrome.com/docs/ai/translator-api

### speculative decoding

- **מה השתנה:** ‏Ollama 0.34 (5.9.2026) מפעיל MTP כברירת מחדל, עם `draft_num_predict 3`.
- **מה מרוויחים:** פי 1.3–2.4 בטוקנים לשנייה.
- **הבעיות:**
  - פלט לא תמיד זהה בטמפרטורה 0.
  - נסיגה ב-qwen3.8 ‏(17.4 מול 75.1 tok/s).
  - ‏draft חיצוני לא מתאים מאט ב-73%.
- **בדפדפן (web-llm):** לא מצאתי עדות ל-speculative decoding.
- **משימה:** W7.15.

**מקור:**
- https://runaihome.com/blog/ollama-034-speculative-decoding-default-home-lab-2026/

### ראייה מקומית

- **Qwen3-VL-2B-Instruct:** ‏Apache, ‏OCR ב-32 שפות (19.10.2025). משמש לצילומי מסך (W7.16) ולכתב יד (W7.11).
- **Florence-2 ו-SmolVLM:** כבר ב-6.6.

---

## 4. תאימות ותקנים

- **MCP 2026-07-28:**
  - **הסרות:** סשנים, ה-handshake של `initialize` ו-SSE resumability.
  - **תוספות:** ‏`server/discover`, ‏`resultType`, ‏`CacheableResult` ‏(ttlMs, ‏cacheScope), ו-MRTR במקום בקשות מהשרת.
  - **הוצאו משימוש:** ‏Roots, ‏Sampling ו-Logging.
  - **מה זה אומר לנו:** השרת של W2.3 צריך הגירה (W7.17). חסר גם צד לקוח (W7.18).
- **AT Protocol / Standard.site:**
  - **מה זה:** ‏Lexicons של publication, ‏document ו-subscriptions, שנבנו על ידי Leaflet, ‏pckt.blog ו-Offprint.
  - **Bluesky:** מציג תצוגה מקדימה עשירה מ-27.5.2026.
  - **מי עוד תומך:** ‏WordPress ו-Sequoia, כלי CLI לאתרים סטטיים.
- **ActivityPub:** ‏Bridgy Fed מגשר מאמרי Standard.site לפדיברס מ-25.3.2026. לכן אין צורך בשרת ActivityPub משלנו (W7.19).
- **CalDAV:**
  - **הספרייה:** ‏tsdav ברישיון MIT, ותומכת בדפדפן.
  - **מגבלת הדפדפן:** ‏CORS, ולכן בשולחן העבודה דרך Tauri.
  - **מתחרים:** ‏Capacities הוסיפו CalDAV בגרסה 70 (W7.20).
- **כבר בתוכנית, בלי משימה חדשה:**
  - ‏JSON Canvas: ‏4.17.
  - ‏Obsidian Bases: ‏W1.11, ‏W4.30 ו-W6.34.
  - ‏CSL-JSON: ‏W2.16.
  - ‏W3C Web Annotation: ‏4.14 ו-W1.14.
  - ‏Readwise, ‏Kindle ו-Kobo: ‏W2.15.
- **Agent Skills:** ‏obsidian-skills של kepano הוא תקדים לחבילת מיומנויות שמלמדת סוכנים חיצוניים את הפורמטים של העורך (W7.1).

**מקורות:**
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://atproto.com/blog/standard-site-bluesky-timeline
- https://blog.anew.social/long-form-comes-to-bridgy-fed/
- https://cdn.jsdelivr.net/npm/tsdav@2.3.3/README.md

---

## 5. כלים לתהליך הפיתוח: אימות אמיתי בלי GitHub Actions ובלי תשלום

**מה כבר מכוסה:** ‏W6.5 (מארח שני בלילה), ‏W6.6 (WebKit ו-BrowserStack), ‏W6.8 (Vercel מתחת ל-38 דקות, ‏e2e ברסיסים) ו-W6.24 (Codemagic). המשימות כאן משלימות אותן, ולא מחליפות.

### טבלת השוואה

התנאים נבדקו ב-12.11.2026.

| אפשרות | התנאים | החלטה |
|---|---|---|
| **Buildkite Free** | 5 משתמשים, 10 jobs במקביל בסוכנים שלנו, ‏2,000 דקות Linux מתארחות, שמירה 30 יום, תוכנית לקוד פתוח בפנייה | **נבחר כמתזמר** (W7.21). הסוכנים: המארח של W6.5 וה-Mac (launchd). את האינטגרציה עם commit status צריך לאמת בתיעוד שלהם |
| Cloudflare Workers Builds | ‏3,000 דקות בחודש, בנייה אחת במקביל, עד 20 דקות, ‏2 vCPU, ‏8 GB | **לא כשער**. כבונה שני לבדיקת הבנייה המשתחזרת (W7.23) |
| Codeberg Woodpecker | בקשה ידנית ואישור מתנדב, "as-is, might break", ‏amd64 בלבד, ‏"reasonable" | **מראה וגיבוי בלבד** |
| Forgejo runner על macOS | נבנה מהקוד, ‏v12.6.4 | אפשרי, אבל Buildkite פשוט יותר |
| SourceHut builds | תשלום חובה, ‏4/8/12 אירו בחודש, ויש סיוע כספי | **נדחה** |
| BrowserStack OSS | ‏Live, ‏Automate ו-Percy ללא הגבלה, ‏5 משתמשים, ‏5 סשנים במקביל, לכל משך הפרויקט | כבר ב-W4.7 ו-W6.6; ‏**Percy נוסף ב-W7.25** |
| LambdaTest / TestMu | לא הצלחתי לקרוא דף תנאים רשמי, רק אתרי השוואה | **נדחה עד שיש תנאים מהיצרן** |
| Vercel Hobby | בנייה עד 45 דקות, פריסה אחת במקביל, ‏100 בנייות בשעה, ‏100 פריסות ביום | בתוכנית (W1.35, ‏W6.8). הרסיסים לא רצים במקביל ב-Hobby, ולכן מקבילות דורשת סוכנים (W7.21) |
| רסיסי vitest | ‏`--shard` עם `--reporter=blob` ואז `--merge-reports`, מחולקים לפי קבצים | בתוך W7.21, ומאוזנים לפי זמן |
| OSS-Fuzz | דורש "significant user base and/or critical to global IT infrastructure", ומייל של committer שמחובר לחשבון Google | **נדחה עכשיו**. נבחן שוב אחרי בטא עם משתמשים. ‏fast-check (W1.27, ‏W4.16) נשאר |
| SLSA בלי Actions | ‏Witness (in-toto, ‏CNCF): ‏`witness run -a slsa`, חתימה במפתח או Sigstore keyless, ‏`witness verify` עם policy חתום, גם בלי רשת | **נבחר** (W7.22). Witness הוא כלי פיתוח שלא נארז; צריך לאמת את הרישיון |
| Sigstore keyless מקומי | ‏`cosign verify-blob --bundle --certificate-identity --certificate-oidc-issuer` | בתוך W7.22 |
| npm provenance | ‏trusted publishing רק מ-GitHub Actions, מ-GitLab.com ומ-CircleCI בענן; ‏runner עצמאי עוד לא נתמך | **נדחה**. ה-SDK של התוספים מתפרסם ידנית עם attestation |
| mutation | כבר ב-0.15, ‏W4.17 ו-W6.16 | אין משימה חדשה |

**מקורות:**
- https://buildkite.com/pricing/
- https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- https://docs.codeberg.org/ci
- https://angu-software.codeberg.page/devops/2026/03/01/forging-a-mac-os-compatible-forgejo-actions-runner.html
- https://sourcehut.org/pricing/
- https://www.browserstack.com/open-source
- https://agentdeals.dev/vendor/browserstack
- https://vercel.com/docs/limits
- https://v4.vitest.dev/guide/improving-performance
- https://google.github.io/oss-fuzz/getting-started/accepting-new-projects/
- https://helpnetsecurity.com/2026/10/26/witness-open-source-software-supply-chain-tool
- https://docs.sigstore.dev/cosign/verifying/verify/
- https://docs.npmjs.com/trusted-publishers

---

## 6. רעיונות שנדחו, ולמה

### רישיונות

- **API הנקדן של Dicta בענן:** אין תנאי שימוש רשמיים שאפשר לאמת, וזה גם סותר את עיקרון המקומיות.
- **קולות Phonikud, ‏ILSpeech, ‏MMS ו-SASPEECH:** כולם NC.
- **HebHTR:** בלי רישיון ובארכיון.
- **LightOnOCR לעברית:** אין עדות.
- **מילון YIVO בתוך הבנייה:** הרישיון לא עקבי, ולכן רק הורדה ביוזמת המשתמש.

### לא נחוץ

- **שרת ActivityPub משלנו:** דורש inbox ו-WebFinger חיים. ‏Bridgy Fed עושה את זה בלי שרת.
- **Matrix כערוץ שיתוף:** ‏matrix-crdt הוא alpha, ויש לנו כבר relay (W4.8, ‏W6.23).
- **Solid pods:** לא נבדק לעומק בסבב הזה. לא מצאתי ביקוש בקהל שלנו.

### שירותים ותשתיות

- **SourceHut:** תשלום חובה.
- **LambdaTest:** אין תנאים מהיצרן.
- **OSS-Fuzz:** דרישת בסיס המשתמשים.
- **Cloudflare כשער ראשי:** ‏20 דקות ובנייה אחת במקביל.
- **npm trusted publishing:** אין תמיכה ב-runner עצמאי.

### כבר בתוכנית

- **שדרוג transformers.js ל-v4:** כבר על 4.3.1.
- **Summarizer של Chrome לעברית:** אנגלית בלבד (6.11).
- **רסיסי vitest כמשימה נפרדת:** אוחד ל-W7.21, ו-W6.8 מכסה את ה-e2e.
- **פיצ׳רים של Tana, ‏Zotero 9 ו-iA Writer:** קולי, פגישות, הקראה, צבעי מחבר — כבר בתוכנית (W5.20, ‏W2.7, ‏6.16, ‏W2.6, ‏5.9).

### נדחה לסבב הבא

- **קורא RSS ו-newsletters:** חסר בתוכנית, אבל לא קראתי בסבב הזה מקור עדכני שמתאר את הפיצ׳ר אצל המתחרים. צריך לבדוק ב-Readwise Reader.
- **speculative decoding בדפדפן:** לא נמצאה עדות ב-web-llm.

---

## 7. סדר מומלץ

1. **W7.17** (הגירת MCP), כי הלקוחות החדשים כבר מדברים 2026-07-28.
2. **W7.15** (הצמדה ב-eval), לפני יום המודלים (W4.6, ‏W6.18).
3. **W7.21 ← W7.22** (CI אמיתי, ואחריו provenance), יחד עם beta.1 (W4.5, ‏W6.43).
4. **W7.13 ו-W7.12** (מדידה: embeddings ו-OCR חיצוני).
5. **W7.5** (חקיקה וכנסת), ה-★ עם הערך הגבוה ביותר ב-P1.
6. **W7.14 ו-W7.1** (פלט מובנה ומיומנויות).
7. **P2 לפי ביקוש בבטא:** W7.6–W7.11, ‏W7.24, ‏W7.19, ‏W7.20 ואחרות.
