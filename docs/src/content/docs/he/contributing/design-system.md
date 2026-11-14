---
title: מערכת העיצוב
description: האסימונים של Lumen לצבע, ריווח, רדיוס, טיפוגרפיה, הגבהה ותנועה, הכללים שהקוד עומד בהם, והרכיבים המשותפים.
---

כל משטח ב-Lumen נבנה מאותה קבוצת אסימונים (tokens). הם משתני CSS
ב-‎`src/index.css`‎, כך שמצב כהה, ערכות הנושא (הגדרות ← ערכת נושא) ו*הפחתת
תנועה* משנים אותם במקום אחד. סגנונות בתוך הקוד משתמשים בהם דרך
‎`src/ui/tokens.ts`‎.

## אסימונים

| קבוצה | אסימונים | שימוש |
|---|---|---|
| משטחים וטקסט | ‏`--bg`, ‏`--bg-subtle`, ‏`--bg-muted`, ‏`--bg-inset`, ‏`--fg`, ‏`--fg-subtle`, ‏`--fg-muted`, ‏`--border`, ‏`--border-strong`, ‏`--accent`, ‏`--accent-fg` | שלשות HSL: ‏`hsl(var(--bg))`, ‏`hsl(var(--accent) / 0.15)` |
| מצב | ‏`--danger`, ‏`--success`, ‏`--warning`, ‏`--info` | שגיאות ופעולות הרסניות, אישורים, אזהרות, מידע; מותאמים לבהיר ולכהה |
| מעברי צבע | ‏`--gradient-brand`, ‏`--gradient-ai`, ‏`--gradient-success` | הלוגו, כפתור ה-AI, התקדמות — לקישוט בלבד |
| מאחורי חלון | ‏`--overlay` | הרקע של כל דו-שיח |
| הגבהה | ‏`--shadow-sm`, ‏`--shadow-md`, ‏`--shadow-lg`, ‏`--shadow-xl`, ‏`--shadow-accent` | תגים, חלונות קופצים, תפריטים, דו-שיחים; זוהר בצבע ההדגשה |
| ריווח | ‏`--space-1` … ‏`--space-8` (צעדים של 4px) | ריפוד ומרווחים |
| רדיוס | ‏`--radius-sm` ‏4, ‏`--radius-md` ‏6, ‏`--radius-lg` ‏10, ‏`--radius-full` | |
| טקסט | ‏`--text-xs` ‏11 … ‏`--text-xl` ‏18px | |
| תנועה | ‏`--duration-fast` ‏100ms, ‏`--duration-base` ‏250ms, ‏`--duration-slow` ‏350ms; ‏`--ease-out`, ‏`--ease-in-out` | תפריטים וריחוף; דו-שיחים והודעות; חלוניות |

ב-TypeScript: ‏`color.danger`, ‏`color.tint("danger", 0.1)`, ‏`shadow.lg`,
‏`transition(["opacity"], "base")`, ‏`enter("cmdSlideIn")`. ‏`<canvas>` לא
קורא `var()`: מציירים עם `resolvedColor("fg", 0.15)`.

## כללים

1. **אין צבע קשיח ב-‎`src/ui`‎** — לא hex, לא `rgb()` ולא `hsl()` עם מספרים.
   צבעים שאדם בוחר לתוכן שלו (צבעי הפתקים בלוח הציור) הם תוכן, ומסומנים
   ‎`design-allow`‎.
2. **רק `transform` ו-`opacity` זזים**, בשלושת המשכים. שום דבר לא מנפיש
   רוחב, גובה, ‏top/left או שוליים: פס התקדמות משתנה בקנה מידה
   (‎`transform: scaleX()`‎), תפריט מחליק (`translateY`), ריחוף משנה צבע מיד.
3. **הפחתת תנועה מכובדת בכל מקום**: כשההגדרה של המערכת פעילה, אסימוני
   המשך הופכים ל-0, וכלל כללי עוצר כל הנפשה שנשארה.
4. **צדדים לוגיים**: ‏`marginInlineStart`, ‏`insetInlineEnd`, ‏`textAlign:
   "start"` — משטח מתהפך בעברית מעצמו. קואורדינטות מסך מ-
   ‎`getBoundingClientRect()`‎ נשארות פיזיות.
5. **רקע של חלון הוא `var(--overlay)`; צל הוא דרגה בסולם.**

‏`npm run design:check` מריץ את שני השערים: ‏‎`scripts/check-design.mjs`‎
(כללים 1–2 על כל `src/ui`, ואף הנפשת פריסה בכל `src`) ו-
‎`scripts/design-audit.mjs`‎, שמריץ את רשימת הביקורת (כללים 1, 2, 4, 5) על
40 המשטחים שב-‎`scripts/design-surfaces.json`‎. חריג אמיתי מסומן בקוד
‎`design-allow: <סיבה>`‎.

## רכיבים משותפים

| רכיב | איפה | בשביל מה |
|---|---|---|
| דו-שיחים | ‏`uiAlert`, ‏`uiConfirm`, ‏`uiPrompt`, ‏`uiSelect` (‏‎`src/ui/PromptDialog.tsx`‎) | כל שאלה ואישור; אף פעם לא `window.confirm` |
| מסגרת חלון | ‏`.cmd-palette-backdrop` + ‏`.cmd-palette` (‏‎`src/ui/CommandPalette.css`‎) | חלוניות כמו סל המחזור, רופא ה-AI, הגדרות |
| הודעות | ‏`showAiToast()` (‏‎`src/ui/AiToast.tsx`‎), ‏`toast.*` (‏‎`src/store/useToastStore.ts`‎) | הודעות קצרות; `action` לביטול |
| כפתור סמל | ‏`.icon-btn` (‏‎`src/index.css`‎) | כפתורי סרגל וחלוניות |
| פלטת הפקודות | ‏‎`src/ui/CommandPalette.tsx`‎ | לכל פעולה יש פקודה |
