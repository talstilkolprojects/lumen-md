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
| `read` | `read_note`, `list_notes`, `list_tags`, `get_backlinks` |
| `propose` | `create_note`, `append_note`, `write_note`, `update_frontmatter` — הצעות בלבד |

`lumen mcp enable <client>` בלי `--scopes` נותן `search,read`. מוסיפים
`propose` רק ללקוח שרוצים ממנו הצעות. `lumen mcp disable <client>` חל מהקריאה
הבאה שלו. ההגדרות נשמרות ב-`<vault>/.lumen/mcp.json`; לקוחות לא יכולים לקרוא
או לכתוב שום דבר תחת `.lumen/` (או תיקייה נסתרת אחרת), `..` או נתיב מוחלט.

## חיבור

לכל לקוח נותנים שם `--client` משלו — זה שהופעל. (בלעדיו השרת משתמש בשם
שהלקוח מדווח כשהוא מתחבר.)

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
  lumen mcp approve <id>        # או --all
  lumen mcp reject <id>         # או --all
  ```

הצעה שומרת את הטקסט שממנו היא חושבה. אם הפתק השתנה מאז, אישור לא כותב כלום
וההצעה נמחקת כהתנגשות.

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
