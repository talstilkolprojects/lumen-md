---
title: ממשק התוספים (API)
description: האובייקט lumen שתוסף בארגז החול מקבל — כל מתודה, היכולת שהיא דורשת, המגבלות שלה ורכיבי הממשק.
---

ה-`main` של תוסף הוא מודול ES שרץ בארגז החול (ראו
[ארגז החול והרשאות](/he/plugins/sandbox/)). הוא מדבר עם לומן רק דרך
האובייקט הגלובלי `lumen`. כל מתודה מחזירה promise. מתודה שהיכולת שלה לא
אושרה לכם נדחית עם שגיאת `PluginDenied`.

## אירועים

```js
const off = lumen.on(name, (payload) => { … }); // off() מבטל את ההרשמה
```

| אירוע | מתי | מטען |
|---|---|---|
| `command:<id>` | אחת הפקודות שלכם הופעלה | `{ source: "palette" }` |
| `render:<lang>` | בלוק ```` ```<lang> ```` צריך רינדור | `{ requestId, source }` |
| `ui:panel` / `ui:block` | נלחץ כפתור או השתנה שדה בפאנל / בבלוק שלכם | `{ id, kind: "click" \| "change", value? }` |
| `panel:closed` | המשתמש סגר את הפאנל שלכם | — |

כל קריאה ל-handler מקבלת 250ms של מעבד. ההמתנה לקריאת `lumen.*` לא נספרת
בזמן הזה.

## מתודות

| מתודה | יכולת | הערות |
|---|---|---|
| `document.getText()` / `getFileName()` / `getSelection()` | `document:read` | `getSelection()` → `{ from, to, text }` או `null` |
| `document.setText(text)` / `insertText(text)` / `replaceSelection(text)` | `document:write` | הכנסה מחליפה את הבחירה במקום הסמן |
| `vault.list(dir?)` / `vault.read(path)` | `vault:read` | נתיבים יחסיים בלבד: בלי `..` ובלי תיקיות נסתרות. קריאה עד 5MB |
| `vault.write(path, text)` | `vault:write` | `.md`, `.txt`, `.json` או `.csv` בלבד, עד 5MB |
| `commands.register({ id, label, hint? }, handler?)` / `commands.unregister(id)` | `commands` | עד 50 לתוסף. בתווית מופיע "· שם התוסף" |
| `panel.open({ title? })` / `panel.render(tree)` / `panel.close()` | `panel` | פאנל תוסף אחד בכל רגע |
| `renderer.register(lang)` / `renderer.result(requestId, tree)` | `renderer` | עד 10 שפות. שפות שלומן מרנדר בעצמו (`mermaid`, `chart`, `csv`, …) נדחות |
| `settings.get()` / `settings.set(object)` | `settings` | JSON משלכם, עד 64KB |
| `storage.get(key)` / `set(key, value)` / `delete(key)` | `storage` | אחסון מפתח–ערך משלכם: 1,000 מפתחות של עד 1MB כל אחד. נמחק כשמסירים את התוסף |
| `clipboard.writeText(text)` | `clipboard:write` | — |
| `notifications.show(text, "info" \| "success" \| "error")` | `notifications` | מוצג עם שם התוסף בהתחלה |
| `network.fetch(url, { method?, headers?, body? })` | `network:<origin>` | רק למקור המדויק שאושר. בלי עוגיות, בלי הפניות, 30 שניות, עד 5MB. מחזיר `{ status, headers, body }`. נרשם ביומן הפרטיות; נחסם במצב מקומי בלבד |
| `lumen.manifest` | — | המניפסט שלכם (קריאה בלבד) |

מותר להשתמש ב-`console.log` / `warn` / `error`, עד 120 שורות בדקה.

## רכיבי ממשק

פאנלים ובלוקים מרונדרים הם **עצים של הרכיבים האלה**, ושום דבר אחר:

`text {text}` · `heading {level 1–3, text}` · `paragraph {children}` ·
`box {direction "row"|"column", gap, children}` · `list {ordered, items: [[…]]}` ·
`button {id, label, primary?, disabled?}` · `input {id, value?, placeholder?, multiline?}` ·
`checkbox {id, label, checked?}` · `select {id, value?, options: [{value, label}]}` ·
`code {text, lang?}` · `noteLink {target, label?}` (פתק בכספת, אף פעם לא כתובת URL) · `divider`

לעץ יכולים להיות עד 2,000 צמתים, עד 24 רמות קינון, ועד 20,000 תווי טקסט
בכל צומת. רכיב או שדה לא מוכר נדחה.

## דוגמאות

הדוגמאות נמצאות ב-`public/plugins/examples/`:

- `word-stats` — פקודה, פאנל, הגדרות, `document:read`
- `callout` — רנדרר של בלוק קוד ששומר סימוני רשימה ב-`storage`
