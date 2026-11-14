---
title: MCP וה-CLI של lumen
description: לתת ל-Claude Desktop, ל-Claude Code או ל-IDE לחפש ולקרוא בכספת — כבוי כברירת מחדל, הרשאות לכל לקוח, וכל שינוי מחכה לאישורך.
---

אפשר להשתמש בכספת של Lumen מחוץ לאפליקציה בשתי דרכים:

- **שרת MCP** (`@lumen-md/mcp-server`) ללקוחות AI שמדברים
  [Model Context Protocol](https://modelcontextprotocol.io/) — Claude
  Desktop, Claude Code, Cursor, VS Code, Zed;
- **ה-CLI `lumen`** בשבילך בטרמינל: `lumen search`, `open`, `new`,
  `append`, `daily`.

שניהם עובדים על תיקיית הכספת בדיסק. שלושה כללים חלים תמיד:

1. **כבוי כברירת מחדל.** לקוח לא מקבל אף כלי עד שמפעילים אותו.
2. **הרשאות לכל לקוח.** את/ה בוחר/ת מה כל לקוח רשאי לעשות.
3. **אין כתיבה בלי אישור.** כתיבה של לקוח היא רק הצעה; הפתק משתנה כשמאשרים.

## התקנה

השרת עדיין לא פורסם ב-npm, ולכן בונים אותו מהריפו (Node 22 ומעלה):

```bash
git clone https://github.com/talstilkol/lumen-md
cd lumen-md/mcp-server
npm ci
npm run build          # → mcp-server/dist/index.js ו-dist/lumen.js
```

עד שיפורסם ב-npm, מריצים `node /path/to/lumen-md/mcp-server/dist/lumen.js`
במקום `npx -p @lumen-md/mcp-server lumen` שבעמוד הזה, ובהגדרות הלקוח
`"command": "node", "args": ["/path/to/lumen-md/mcp-server/dist/index.js", "--client", "…"]`
במקום `npx -y @lumen-md/mcp-server`.

## הפעלת לקוח

```bash
cd ~/Documents/Lumen            # תיקיית הכספת
npx -p @lumen-md/mcp-server lumen mcp enable claude-desktop --scopes search,read
npx -p @lumen-md/mcp-server lumen mcp status
```

| הרשאה | כלים |
|---|---|
| `search` | `search_notes` — BM25 בעברית ובאנגלית (אותיות השימוש ו ה ב ל מ ש כ וניקוד מטופלים) |
| `read` | `read_note`, `list_notes`, `list_tags`, `get_backlinks`, `bases_query` |
| `propose` | `create_note`, `append_note`, `write_note`, `update_frontmatter`, `bases_update` — הצעות בלבד |

`lumen mcp enable <client>` בלי `--scopes` נותן `search,read`. מוסיפים
`propose` רק ללקוח שרוצים ממנו הצעות. `lumen mcp disable <client>` חל מהקריאה
הבאה שלו. ההגדרות נשמרות ב-`<vault>/.lumen/mcp.json`; לקוחות לא יכולים לקרוא
או לכתוב שום דבר תחת `.lumen/` (או תיקייה נסתרת אחרת), `..` או נתיב מוחלט.

## חיבור

לכל לקוח נותנים שם `--client` משלו — זה שהופעל. (בלעדיו השרת משתמש בשם
שהלקוח מדווח כשהוא מתחבר.)

השם הוא מה שהלקוח אומר על עצמו, לא הוכחה: לקוח שמדווח שם של לקוח אחר מקבל את
הכלים שלו, ובכל מקרה האפליקציה שמפעילה את השרת היא שבוחרת את `--client`. לכן
ההרשאות מפרידות בין האפליקציות שהגדרתם, לא מאפליקציה שמשקרת על עצמה. הפעילו רק
אפליקציות שאתם סומכים עליהן בהרשאות שנתתם, וכל כתיבה עדיין מחכה לאישור שלכם,
יהיה השם אשר יהיה.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS; ב-Windows `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "lumen": {
      "command": "npx",
      "args": ["-y", "@lumen-md/mcp-server", "--client", "claude-desktop"],
      "env": { "LUMEN_VAULT": "/Users/you/Documents/Lumen" }
    }
  }
}
```

**Claude Code** — מכל תיקייה:

```bash
claude mcp add lumen -e LUMEN_VAULT="$HOME/Documents/Lumen" -- npx -y @lumen-md/mcp-server --client claude-code
npx -p @lumen-md/mcp-server lumen mcp enable claude-code --vault "$HOME/Documents/Lumen" --scopes search,read
```

**Cursor** (`~/.cursor/mcp.json`), **VS Code** (`.vscode/mcp.json`, המפתח
`servers`) ו-**Zed** (`context_servers`) מקבלים אותה פקודה ואותם ארגומנטים:
`npx -y @lumen-md/mcp-server --client cursor` (או `vscode`, `zed`) עם
`LUMEN_VAULT` ב-`env`.

## אישור שינויים

`create_note` / `append_note` / `write_note` / `update_frontmatter` של לקוח
כותבים הצעה ל-`.lumen/mcp/pending/` ומודיעים ללקוח ששום דבר עוד לא נכתב.
ההחלטה שלך:

- **ב-Lumen:** ההצעות מופיעות במסך האישור (⌘K ← *AI: Review changes proposed
  by agents*, או התג **לסקירה** בשורת המצב) בתור "הוצע על ידי claude-desktop
  (לקוח MCP)", כל אחת כ-diff. אישור כותב את הפתק; דחייה מוחקת את ההצעה. זה
  דורש שתיקיית הכספת תהיה באפליקציה — אותה תיקייה, או מסונכרנת ב-Git
  (`.lumen/` מסונכרנת כמו הפתקים).
- **בטרמינל:**

  ```bash
  lumen mcp review              # כל ההצעות כ-diff
  lumen mcp approve <id>        # או --client <id>: כל diff, ואז להקליד yes (צריך טרמינל)
  lumen mcp reject <id>         # או --all
  ```

הצעה שומרת את הטקסט שממנו היא חושבה. אם הפתק השתנה מאז, אישור לא כותב כלום
וההצעה נמחקת כהתנגשות.

## גרסאות הפרוטוקול

השרת מדבר בפרוטוקול [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
ובאותו תהליך גם ב-handshake הישן של `initialize`‏ (2025-11-25, ‏2025-06-18,
‏2025-03-26, ‏2024-11-05), כך שלקוחות משני הדורות מתחברים.

- **2026-07-28:** אין handshake ואין סשן. כל בקשה מציינת ב-`_meta` את גרסת
  הפרוטוקול ואת יכולות הלקוח; `server/discover` מחזיר את הגרסאות, היכולות
  וזהות השרת. רשימת הכלים אומרת כמה זמן היא תקפה (`ttlMs`) ושהיא `private`
  (היא תלויה במה שהרשית ללקוח הזה), ומגיעה תמיד באותו סדר.
- **כתיבה מחכה לך:** בחיבור 2026-07-28 הצעה עונה `input_required` עם
  `requestState` חתום. הלקוח שולח שוב את אותה קריאה איתו, ומקבל ״נכתב״, ״נדחה״
  או ״התנגשות״ אחרי שהחלטת — או שוב `input_required` כל עוד לא החלטת. שום
  דבר שהלקוח שולח לא יכול לאשר שינוי: המצב חתום במפתח שנשאר ב-`.lumen/mcp/state.key`,
  קשור ללקוח ולקריאה האלה, ופג אחרי שעה (אז הלקוח פשוט מציע שוב).
- **לא נתמך:** Roots, ‏Sampling ו-Logging (הוצאו משימוש ב-2026-07-28). השרת
  כותב לוגים ל-stderr בלבד.
- **שגיאות:** גרסה לא מוכרת מקבלת `-32022` עם רשימת הגרסאות הנתמכות; בקשה
  בלי ה-`_meta` הנדרש (ובלי handshake) מקבלת `-32602`.

### בדיקה ידנית של לקוח

1. בנה והפעל את הלקוח כמו למעלה, והוסף `--client claude-code` (או
   `claude-desktop`) להגדרות שלו.
2. בקש מהלקוח *לחפש בכספת ״השקה״*, ואז *לקרוא* אחת התוצאות: שתי התשובות
   מגיעות מהפתקים שלך.
3. בקש ממנו *ליצור פתק*: הלקוח אומר שהוא מחכה לאישור, וההצעה נמצאת במסך
   האישור של Lumen. אשר אותה; הפתק מופיע, ו-`lumen mcp log` מראה `proposed`
   ואחר כך `approved`.

## Bases

`bases_query` מחזיר את השורות של תצוגה בקובץ `.base` כ-JSON: ‏`{ view, columns,
rows: [{ path, cells }], total, errors }`, ‏200 שורות בכל פעם (`offset`, ‏`limit`
עד 10,000). השורות מחושבות במנוע ה-Bases של Lumen עצמו, שנארז לתוך השרת בזמן
הבנייה, ולכן הן בדיוק השורות שהאפליקציה מציגה.

`bases_update` מקבל את אותם עדכונים כמו ה-API של התוספים
(`[{ "path": "Tasks/a.md", "set": { "status": "done" } }]`, עד 5,000 שורות). כל
פתק שישתנה הופך להצעה בתור האישורים, כולן תחת אצווה אחת; שום דבר לא נכתב עד
שתאשר. ב-MCP 2026-07-28 הלקוח מחכה (`input_required`) עד שהחלטת על כל פתקי
האצווה, ואז מקבל כמה נכתבו, כמה נדחו וכמה לא נכתבו כי הפתק השתנה.

מהטרמינל:

```bash
lumen bases query Tasks.base --view Open          # מופרד בטאבים; ‏--json ל-JSON
lumen bases update --edits edits.json --dry-run   # מה ישתנה; שום דבר לא נכתב
lumen bases update --edits edits.json             # נכנס לתור של מסך האישור
lumen bases update --edits edits.json --approve   # כל diff בטרמינל; מקלידים yes כדי לכתוב
```

Bases דורשים את חבילת המנוע: בנה את השרת אחרי `npm ci` בשורש המאגר, ואז
`npm run build` בתיקייה `mcp-server/`.

## Lumen כלקוח: שרתים חיצוניים לסוכנים המקומיים

בכיוון ההפוך: הסוכנים של Lumen יכולים להשתמש בכלים של שרתי MCP אחרים, למשל
הצעות החוק וההצבעות של הכנסת, ‏data.gov.il, ספריית Zotero שלך או הקבצים שלך.
שום דבר לא מחובר עד שתוסיף שרת ותפעיל אותו.

- **שרתים:** מקומיים (פקודה במחשב הזה, באפליקציית שולחן העבודה בלבד, או כתובת
  `127.0.0.1`) ומרוחקים (Streamable HTTP). ‏Lumen מדבר MCP 2026-07-28, ועם שרתים
  ישנים עובר ל-handshake הישן.
- **הרשאה לכל שרת ולכל כלי:** *קריאה* (רץ בלי לשאול, רק לכלים שהשרת מסמן לקריאה
  בלבד), *לשאול* (אתה מאשר כל קריאה; ברירת המחדל) או *לחסום* (לא מוצע למודל).
- **מצב טיסה ו-AI מקומי בלבד:** כל שרת מרוחק חסום, ולא נוצר שום חיבור. גם תוכנה
  במחשב הזה נחשבת מרוחקת, כי היא עשויה לפנות לרשת בעצמה, אלא אם סימנת אותה *לא מקוון*. כל קריאה
  לשרת מרוחק נרשמת ביומן הפרטיות.
- **שומר ה-injection:** מה ששרת מחזיר הוא תוכן חיצוני. הוא מנוקה ומסומן לפני
  שהמודל רואה אותו, וכל שינוי או קריאת רשת שהסוכן מנסה אחריו דורשים את האישור שלך.
- **התחברות (OAuth):** ‏Lumen מזדהה במסמך מטא-דאטה של לקוח
  (`https://lumen-md.vercel.app/oauth/client-metadata.json`), משתמש ב-PKCE, בודק
  שתשובת ההתחברות הגיעה מהשרת שאליו פנה (`iss`), ושומר את פרטי ההתחברות של כל
  שרת קשורים לשרת שהנפיק אותם.
- **שרתים מוצעים** (כבויים עד שתפעיל): הכנסת (Knessy, ‏MIT), ‏data.gov.il,
  ‏Zotero, הקבצים שלך.

## היומן

כל קריאה — מותרת, נדחית, הצעה, אישור, דחייה — היא שורה ב-`.lumen/mcp/ledger.jsonl`:
זמן, לקוח, כלי, הרשאה, נתיב הפתק, ההחלטה, וכמה בתים מהכספת יצאו ללקוח. אף
פעם לא טקסט הפתק או השאילתה. `lumen mcp log` מדפיס אותו.

## ה-CLI `lumen`

```bash
lumen search תקציב פגישה         # נתיב, כותרת, השורה שנמצאה (קוד יציאה 3: לא נמצא)
lumen open "תוכנית השקה"         # פותח באפליקציית ברירת המחדל; --print מדפיס
lumen new ideas/one "שורה ראשונה" # יוצר; מסרב אם קיים
lumen append ideas/one.md "עוד"
lumen daily "להתקשר לדנה"        # journal/YYYY-MM-DD.md, מוסיף "- 09:05 להתקשר לדנה"
```

הכספת היא `--vault <dir>`, אחרת `$LUMEN_VAULT`, אחרת התיקייה הנוכחית.
`new`, `append` ו-`daily` הם את/ה במקלדת, ולכן כותבים ישירות (נרשמים ביומן
כלקוח `cli`). התקנה: `npm i -g @lumen-md/mcp-server`, או מתוך עותק של המאגר
`npm run lumen -- search …`.

## מהירות

החיפוש שומר אינדקס בזיכרון, שנבנה בחיפוש הראשון ומתעדכן לפני כל חיפוש (רק
פתקים שהשתנו נקראים מחדש). על 10,000 פתקים חיפוש עונה הרבה מתחת ל-300ms.
