/**
 * The sample vault in Hebrew (plan 14.1): the same notes as the English one
 * (./sampleWorkspace), written for a Hebrew reader — right-to-left text,
 * Hebrew file names, links and tags. Generated from code; loaded only when
 * someone picks it.
 */
import { joinPath } from "./workspace";
import type { SampleFile } from "./sampleWorkspace";

export const SAMPLE_ROOT_HE = "דוגמת Lumen";
export const SAMPLE_ENTRY_HE = "התחילו כאן.md";

export function sampleWorkspaceFilesHe(root: string = SAMPLE_ROOT_HE): SampleFile[] {
  const projects = joinPath(root, "פרויקטים");
  return [
    {
      path: SAMPLE_ENTRY_HE,
      content: `---
title: התחילו כאן
tags: [דוגמה, אינדקס]
---

# ברוכים הבאים לכספת הדוגמה של Lumen

התיקייה הזאת היא מאגר ידע קטן ומקושר. כל פתק הוא Markdown רגיל — אפשר לערוך, לשנות שם או למחוק כל דבר.

## לאן ממשיכים

- [[לוח פרויקטים]] — **תצוגת מסד נתונים** שנבנית מה-frontmatter של הפתקים
- [[עיצוב האתר]] — פתק פרויקט עם תרשים **Mermaid**
- [[מדדים]] — **טבלת CSV** ו**גרף**
- [[סיכום שבועי]] — **תבנית** להעתקה בכל שבוע

פתחו את חלונית הקישורים החוזרים בכל פתק כדי לראות אילו פתקים מפנים אליו.

## נסו

- [x] לפתוח את כספת הדוגמה
- [ ] ללחוץ על [[מדדים|קישור]] (גם כינויים עובדים)
- [ ] לסנן את עץ הקבצים לפי התגית \`#פרויקט\`
- [ ] לגרור כרטיס ב[[לוח פרויקטים]]
- [ ] לשכפל את התבנית [[סיכום שבועי]]
`,
    },
    {
      path: "לוח פרויקטים.md",
      content: `---
title: לוח פרויקטים
tags: [דוגמה, מסד-נתונים]
---

# לוח פרויקטים

כל פתק בתיקייה \`פרויקטים/\` שיש בו \`type: project\` מופיע כאן. שנו את \`status:\` של פתק והכרטיס יעבור עמודה.

\`\`\`database
title: פרויקטים לפי מצב
source: ${projects}
type: project
view: kanban
groupBy: status
sortBy: due
fields: [title, owner, due, status]
\`\`\`

אותם נתונים כטבלה:

\`\`\`database
source: ${projects}
type: project
view: table
sortBy: -priority
fields: [title, owner, priority, due]
\`\`\`

חזרה אל [[התחילו כאן]].
`,
    },
    {
      path: "פרויקטים/עיצוב האתר.md",
      content: `---
title: עיצוב האתר
type: project
status: בעבודה
owner: דנה
priority: 3
due: 2026-12-01
tags: [פרויקט, עיצוב]
---

# עיצוב האתר

חלק מ[[לוח פרויקטים]]. מדדי ההשקה נמצאים ב[[מדדים]].

## תהליך השחרור

\`\`\`mermaid
graph RL
  A[סקירת עיצוב] --> B{מאושר?}
  B -- כן --> C[בניית עמודים]
  B -- לא --> A
  C --> D[בדיקות]
  D --> E[השקה]
\`\`\`

## משימות

- [x] סקירת האתר הנוכחי
- [x] שרטוטים לדף הבית ולמחירון
- [ ] בדיקת נגישות
- [ ] הודעת השקה — טיוטה לפי התבנית [[סיכום שבועי]]
`,
    },
    {
      path: "פרויקטים/אפליקציה.md",
      content: `---
title: אפליקציה
type: project
status: מתוכנן
owner: עומר
priority: 2
due: 2027-02-15
tags: [פרויקט, מובייל]
---

# אפליקציה

אפליקציה נלווית שעובדת גם בלי רשת. תלויה במערכת העיצוב של [[עיצוב האתר]].

- [ ] לבחור שיטת סנכרון
- [ ] אב־טיפוס למסך העורך
`,
    },
    {
      path: "פרויקטים/רענון התיעוד.md",
      content: `---
title: רענון התיעוד
type: project
status: הושלם
owner: נועה
priority: 1
due: 2026-09-30
tags: [פרויקט, תיעוד]
---

# רענון התיעוד

שוחרר! מספרי הצפיות נמצאים ב[[מדדים]].

- [x] לשכתב את מדריך הפתיחה
- [x] להוסיף צילומי מסך
`,
    },
    {
      path: "מדדים.md",
      content: `---
title: מדדים
tags: [דוגמה, נתונים]
---

# מדדים

הדביקו CSV בבלוק קוד ו-Lumen יציג טבלה שאפשר למיין, עם הצעות לגרף:

\`\`\`csv title="מבקרים בשבוע"
week,visitors,signups
W1,1200,48
W2,1350,61
W3,1610,70
W4,1980,92
\`\`\`

או גרף מפורש:

\`\`\`chart
xAxis: { type: category, data: [W1, W2, W3, W4] }
yAxis: { type: value }
tooltip: { trigger: axis }
series:
  - { name: הרשמות, type: line, smooth: true, data: [48, 61, 70, 92] }
\`\`\`

בשימוש ב[[עיצוב האתר]] וב[[רענון התיעוד]].
`,
    },
    {
      path: "תבניות/סיכום שבועי.md",
      content: `---
title: סיכום שבועי — {{date}}
type: template
tags: [תבנית]
---

# סיכום שבועי — {{date}}

> שכפלו את הפתק הזה בכל שבוע (או התקינו אותו מ-⌘K ← *הוספת תבנית*) ומלאו את החסר.

## הצלחות

-

## חסמים

-

## בשבוע הבא

- [ ]
- [ ]

פרויקטים מקושרים: [[לוח פרויקטים]]
`,
    },
  ];
}
