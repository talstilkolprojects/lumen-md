---
title: שילוב MCP ‏(Claude Desktop,‏ Cursor, …)
description: חושפים את סביבת העבודה של Lumen כשרת Model Context Protocol, כך שכל סוכן AI יכול לקרוא, לכתוב ולחפש בפתקים שלכם.
---

Lumen כוללת שרת [MCP](https://modelcontextprotocol.io/). מגדירים אותו פעם
אחת, ו-Claude Desktop /‏ Cursor / כל לקוח שמכיר MCP יכולים לקרוא את סביבת
העבודה, לכתוב פתקים חדשים ולחפש מחרוזות — מתוך השיחה, בלי ממשק נוסף.

## התקנה

השרת עדיין לא פורסם ב-npm, ולכן בונים אותו מהריפו (Node 22 ומעלה):

```bash
git clone https://github.com/talstilkol/lumen-md
cd lumen-md/mcp-server
npm ci
npm run build          # → mcp-server/dist/index.js
```

## הגדרת Claude Desktop

עורכים את `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lumen": {
      "command": "node",
      "args": ["/path/to/lumen-md/mcp-server/dist/index.js"],
      "env": {
        "LUMEN_WORKSPACE": "/Users/you/Documents/Lumen"
      }
    }
  }
}
```

מפעילים מחדש את Claude Desktop. סמל 🔌 מופיע בשדה השיחה — סביבת העבודה של
Lumen היא עכשיו חלק מההקשר של Claude.

## הכלים שהסוכן מקבל

| כלי | פרמטרים | מחזיר |
| --- | --- | --- |
| `read_note` | `path` | גוף ה-Markdown המלא |
| `write_note` | `path`,‏ `content` | מחרוזת אישור |
| `list_notes` | — | רשימה, שורה לכל קובץ `.md` / `.txt` |
| `search_workspace` | `query`,‏ `limit?` | התאמות מחרוזת עם מספרי שורות |
| `append_note` | `path`,‏ `content` | מוסיף לסוף פתק קיים |
| `delete_note` | `path`,‏ `confirm: true` | מסרב בלי `confirm: true` (הגנת בטיחות) |
| `update_frontmatter` | `path`,‏ `set?`,‏ `unset?` | משנה מפתחות YAML; הגוף לא נגעים בו |
| `list_tags` | — | מפה של תגית ← כמות בכל סביבת העבודה |
| `get_backlinks` | `path` | פתקים שמכילים `[[wiki-link]]` לפתק הזה |

## דוגמאות

> *קרא את הפתק שלי על deep learning וסכם את השאלות הפתוחות.*

‏Claude קורא ל-`search_workspace("deep learning")` ← התוצאות הראשונות ←
`read_note` על כל אחת ← מחבר סיכום עם ציטוטים שמקשרים בחזרה לפתקים שלכם.

> *שמור את 5 ההודעות האחרונות שלי כפתק חדש בשם "Meeting prep — Q3".*

‏Claude קורא ל-`write_note("meetings/2026-q3-prep.md", "...")` — הפתק נכתב
מיד ל-`LUMEN_WORKSPACE`; אפליקציית הרשת רואה אותו אחרי ה-Git pull הבא (ראו
בהמשך).

> *סמן כל פתק תחת `2024/` כארכיון.*

‏Claude קורא ל-`list_notes` ← מסנן ל-`2024/` ← מריץ בלולאה
`update_frontmatter(path, { set: { status: "archived" } })`. הגופים נשארים
שלמים; רק ה-front matter נכתב מחדש.

> *אילו פתקים מקשרים ל-"Project Aurora"?*

‏Claude קורא ל-`get_backlinks("projects/project-aurora.md")` ← מחזיר כל פתק
שמכיל `[[Project Aurora]]`.

## גבול האבטחה

השרת **מסרב לכל נתיב שמכיל `..` ולנתיבים מוחלטים**. סוכן רואה רק קבצים תחת
`LUMEN_WORKSPACE`. הריצו את השרת רק על תיקיות שהייתם מרגישים בנוח להראות
לסוכן.

## סנכרון עם אפליקציית הרשת

שרת ה-MCP הוא תהליך Node — הוא לא יכול להגיע ישירות ל-OPFS שבדפדפן. הדפוס
המקובל: מחברים את סביבת העבודה של Lumen לריפו Git
(`⌘K → Git: clone repository…`), משכפלים את אותו ריפו לנתיב שהגדרתם
ב-`LUMEN_WORKSPACE`, ומשתמשים ב-`git pull` / push כדי לשמור על שני הצדדים
מסונכרנים.
