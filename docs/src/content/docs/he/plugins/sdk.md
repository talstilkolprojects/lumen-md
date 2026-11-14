---
title: ערכת פיתוח לתוספים
description: בונים תוסף Lumen משלכם בתוך 60 שניות עם create-lumen-plugin.
---

תוספים של Lumen הם מודולי ESM קטנים שרושמים בלוקים, פקודות וחלוניות צד
משלהם. האפליקציה טוענת אותם ב-`import(url)` דינמי, כך שאין צנרת בנייה ללמוד —
כותבים פונקציה ומפרסמים קובץ JS.

:::caution[בשכתוב]
התוספים עוברים לסביבת הרצה מבודדת עם בקשת הרשאה לכל יכולת (תוכנית 11.2);
העמוד הזה יוחלף כשזה ייכנס. ‏`create-lumen-plugin` עדיין לא ב-npm: מריצים אותו
מ-`packages/create-lumen-plugin` במאגר.
:::

## התחלה ב-30 שניות

```bash
npx create-lumen-plugin my-cool-plugin
cd my-cool-plugin
npm install
npm run dev
```

פותחים את Lumen ← `⌘K` → **Plugin gallery** ← **Load unpacked** ← בוחרים
את `dist/my-cool-plugin.js`.

## הממשק

כל תוסף מייצא פונקציית ברירת מחדל `activate(api)`. לארגומנט `api` יש
השיטות האלה:

```ts
interface LumenPluginAPI {
  registerBlock(lang: string, component: ComponentType<{ source, meta }>): () => void;
  registerCommand(cmd: { id, label, hint?, icon?, action }): () => void;
  toast(message: string, kind?: "info" | "success" | "warning" | "error"): void;
  getDocContent(): string;
  setDocContent(content: string): void;
  onDocChange(cb: (content: string) => void): () => void;
}
```

‏`activate` יכולה להחזיר פונקציית ניקוי שרצה כשהמשתמש מכבה או מסיר את
התוסף — השתמשו בה כדי לקרוא לפונקציות הביטול שה-API החזיר, ולפרק טיימרים
ו-DOM שיצרתם.

## מודל ההרשאות

‏`lumen-plugin.json` מצהיר על ההרשאות שהתוסף צריך:

| הרשאה | ניתנת כברירת מחדל | מה היא מאפשרת |
| --- | :---: | --- |
| `register-block` | ✅ | להוסיף מציג לבלוק קוד |
| `register-command` | ✅ | להוסיף פקודות לפלטה |
| `register-panel` | ✅ | להוסיף חלונית בסרגל הימני |
| `read-doc` | ✅ | לקרוא את המסמך הפעיל |
| `write-doc` | ✅ | לשנות את המסמך הפעיל |
| `workspace-read` | ❌ — שואלת את המשתמש | לרשום ולקרוא את כל הפתקים |
| `workspace-write` | ❌ — שואלת את המשתמש | ליצור פתקים ולכתוב עליהם |
| `network-fetch` | ❌ — שואלת את המשתמש | לשלוח בקשות HTTP החוצה |

## פרסום

1. ‏`npm run build` מייצר את `dist/<name>.js` — חבילת ESM אחת, React מחוצה לה
   (Lumen מביאה משלה).
2. מעלים את ה-dist ל-npm או לכל CDN ‏(jsDelivr / unpkg).
3. פותחים PR על
   [`public/plugins/registry.json`](https://github.com/talstilkol/lumen-md/blob/main/public/plugins/registry.json)
   כדי שהתוסף יופיע ברשימה. שדות חובה: `id`, ‏`name`, ‏`description`,
   ‏`version`, ‏`icon`, ‏`url`.

## דוגמה: בלוק CSV עם אימוג׳י בכותרות

```tsx
// src/index.ts
import type { LumenPluginAPI } from "./types";
import { EmojiCsv } from "./block";

export default function activate(api: LumenPluginAPI) {
  return api.registerBlock("emoji-csv", EmojiCsv);
}

// src/block.tsx
export function EmojiCsv({ source }: { source: string }) {
  const [head, ...rows] = source.split("\n");
  const cols = head.split(",");
  return (
    <table>
      <thead>
        <tr>{cols.map((c) => <th key={c}>{c} 📊</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.split(",").map((c, j) => <td key={j}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
```

זה כל התוסף. בלוקי ` ```emoji-csv ` מוצגים עכשיו עם כותרות האימוג׳י בכל מקום
ש-Lumen מציג Markdown.
