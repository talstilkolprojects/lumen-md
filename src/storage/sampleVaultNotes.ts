/**
 * The notes of the student and researcher sample vaults, in Hebrew and in
 * English (split out of sampleVaults.ts, plan W4.11). Loaded with it, on
 * demand, so none of this content reaches the startup bundle.
 */
import { SAMPLE_VAULT_BASES } from "./sampleVaultBases";
import type { SampleFile } from "./sampleWorkspace";

export type SampleVaultLang = "he" | "en";

export const ENTRY: Record<SampleVaultLang, string> = { en: "Start Here.md", he: "מתחילים כאן.md" };

export const base = (id: string, lang: SampleVaultLang) => SAMPLE_VAULT_BASES[id][lang];

/* ─── Student ────────────────────────────────────────────────────────── */

export function student(lang: SampleVaultLang): SampleFile[] {
  if (lang === "he") {
    return [
      {
        path: ENTRY.he,
        content: `---
tags: [sample, index]
---

# 🎓 הכספת של הסטודנט/ית

סמסטר א׳ במבנה שעובד: פתק לכל קורס, סיכום לכל הרצאה ומבחן עם תוכנית לימוד.

- [[אלגברה לינארית 1]] ו-[[מבוא למדעי המחשב]] — הקורסים של הסמסטר
- [[הרצאה 1 — מערכות משוואות]] ו-[[הרצאה 1 — אלגוריתמים]] — סיכומי הרצאות
- [[מבחן באלגברה — מועד א׳]] — מבחן עם תוכנית לימוד

הטבלאות מתעדכנות מעצמן מהמאפיינים של הפתקים:

- [[Bases/קורסים.base|קורסים]] · [[Bases/הרצאות.base|הרצאות]] · [[Bases/מבחנים.base|מבחנים]]

פתק חדש מאותו סוג: ⌘K ← „תבניות” ← „קורס באוניברסיטה”.
`,
      },
      {
        path: "קורסים/אלגברה לינארית 1.md",
        content: `---
type: course
course_code: "0366-1101"
lecturer: ד״ר לוי
semester: א
credits: 5
status: פעיל
tags: [course]
---

# אלגברה לינארית 1

## הרכב הציון

| רכיב | משקל |
|---|---|
| מבחן | 80% |
| תרגילים | 20% |

## שעות קבלה

יום ב׳, 14:00–15:00, בניין שרייבר 309.

## הרצאות

- [[הרצאה 1 — מערכות משוואות]]

## מבחנים

- מועד א׳: [[מבחן באלגברה — מועד א׳]]
- מועד ב׳:
`,
      },
      {
        path: "קורסים/מבוא למדעי המחשב.md",
        content: `---
type: course
course_code: "0368-1105"
lecturer: פרופ׳ כהן
semester: א
credits: 6
status: פעיל
tags: [course]
---

# מבוא למדעי המחשב

## הרכב הציון

| רכיב | משקל |
|---|---|
| מבחן | 70% |
| תרגילים | 30% |

## הרצאות

- [[הרצאה 1 — אלגוריתמים]]
`,
      },
      {
        path: "הרצאות/הרצאה 1 — מערכות משוואות.md",
        content: `---
type: lecture
course: "[[אלגברה לינארית 1]]"
lecture: 1
date: 2026-10-25
tags: [lecture]
---

# הרצאה 1 — מערכות משוואות

## רעיונות מרכזיים

1. מערכת משוואות לינאריות ← מטריצה מורחבת.
2. פעולות שורה אלמנטריות לא משנות את קבוצת הפתרונות.

## שאלות למתרגל

- מתי למערכת אין פתרון בכלל?
`,
      },
      {
        path: "הרצאות/הרצאה 1 — אלגוריתמים.md",
        content: `---
type: lecture
course: "[[מבוא למדעי המחשב]]"
lecture: 1
date: 2026-10-26
tags: [lecture]
---

# הרצאה 1 — אלגוריתמים

## רעיונות מרכזיים

1. אלגוריתם הוא סדרת צעדים סופית ומוגדרת היטב.
2. מודדים זמן ריצה לפי מספר הצעדים כפונקציה של גודל הקלט.
`,
      },
      {
        path: "מבחנים/מבחן באלגברה — מועד א׳.md",
        content: `---
type: exam
course: "[[אלגברה לינארית 1]]"
exam_date: 2027-02-08
moed: א
status: בלמידה
grade:
tags: [exam]
---

# מבחן באלגברה — מועד א׳

## תוכנית לימוד

- [x] סיכום [[הרצאה 1 — מערכות משוואות]]
- [ ] מבחנים קודמים: 2024, 2025
- [ ] שעת קבלה לפני המבחן
`,
      },
      { path: "Bases/קורסים.base", content: base("il-course", "he") },
      { path: "Bases/הרצאות.base", content: base("il-lecture", "he") },
      { path: "Bases/מבחנים.base", content: base("il-exam", "he") },
    ];
  }
  return [
    {
      path: ENTRY.en,
      content: `---
tags: [sample, index]
---

# 🎓 The student's vault

A first semester, set up the way that works: a note per course, a summary per lecture, and an exam with a study plan.

- [[Linear Algebra 1]] and [[Intro to Computer Science]]: this semester's courses
- [[Lecture 1 — Linear systems]] and [[Lecture 1 — Algorithms]]: lecture summaries
- [[Algebra exam — Moed A]]: an exam with its study plan

These tables fill themselves from the notes' properties:

- [[Bases/Courses.base|Courses]] · [[Bases/Lectures.base|Lectures]] · [[Bases/Exams.base|Exams]]

A new note of the same kind: ⌘K → "Templates" → "University course".
`,
    },
    {
      path: "Courses/Linear Algebra 1.md",
      content: `---
type: course
course_code: "0366-1101"
lecturer: Dr. Levi
semester: A
credits: 5
status: active
tags: [course]
---

# Linear Algebra 1

## Grading

| Part | Weight |
|---|---|
| Exam | 80% |
| Assignments | 20% |

## Office hours

Monday 14:00–15:00, Schreiber building, room 309.

## Lectures

- [[Lecture 1 — Linear systems]]

## Exams

- Moed A: [[Algebra exam — Moed A]]
- Moed B:
`,
    },
    {
      path: "Courses/Intro to Computer Science.md",
      content: `---
type: course
course_code: "0368-1105"
lecturer: Prof. Cohen
semester: A
credits: 6
status: active
tags: [course]
---

# Intro to Computer Science

## Grading

| Part | Weight |
|---|---|
| Exam | 70% |
| Assignments | 30% |

## Lectures

- [[Lecture 1 — Algorithms]]
`,
    },
    {
      path: "Lectures/Lecture 1 — Linear systems.md",
      content: `---
type: lecture
course: "[[Linear Algebra 1]]"
lecture: 1
date: 2026-10-25
tags: [lecture]
---

# Lecture 1 — Linear systems

## Main ideas

1. A system of linear equations → an augmented matrix.
2. Elementary row operations keep the set of solutions.

## Questions for the TA

- When does a system have no solution at all?
`,
    },
    {
      path: "Lectures/Lecture 1 — Algorithms.md",
      content: `---
type: lecture
course: "[[Intro to Computer Science]]"
lecture: 1
date: 2026-10-26
tags: [lecture]
---

# Lecture 1 — Algorithms

## Main ideas

1. An algorithm is a finite, well-defined sequence of steps.
2. Running time is counted in steps, as a function of the input size.
`,
    },
    {
      path: "Exams/Algebra exam — Moed A.md",
      content: `---
type: exam
course: "[[Linear Algebra 1]]"
exam_date: 2027-02-08
moed: A
status: studying
grade:
tags: [exam]
---

# Algebra exam — Moed A

## Study plan

- [x] Summary of [[Lecture 1 — Linear systems]]
- [ ] Past exams: 2024, 2025
- [ ] Office hours before the exam
`,
    },
    { path: "Bases/Courses.base", content: base("il-course", "en") },
    { path: "Bases/Lectures.base", content: base("il-lecture", "en") },
    { path: "Bases/Exams.base", content: base("il-exam", "en") },
  ];
}

/* ─── Researcher ─────────────────────────────────────────────────────── */

export function researcher(lang: SampleVaultLang): SampleFile[] {
  if (lang === "he") {
    return [
      {
        path: ENTRY.he,
        content: `---
tags: [sample, index]
---

# 🔬 הכספת של החוקר/ת

תזה בתחילת הדרך: עבודה עם מנחה, מאמרים לקריאה ויומן ניסויים.

- [[תזה — זיהוי דיבור בעברית]] — העבודה ואבני הדרך שלה
- [[Transformers לזיהוי דיבור]] · [[זיהוי דיבור בשפות דלות משאבים]] · [[מדדי שגיאת מילים]] — ספרות
- [[ניסוי 1 — מודל בסיס]] ו-[[ניסוי 2 — אוגמנטציה]] — יומן מחקר

- [[Bases/ספרות.base|ספרות]] · [[Bases/יומן מחקר.base|יומן מחקר]] · [[Bases/עבודות.base|עבודות]]
`,
      },
      {
        path: "תזה — זיהוי דיבור בעברית.md",
        content: `---
type: paper
advisor: פרופ׳ אברהם
due: 2027-06-30
status: סקירת ספרות
tags: [seminar]
---

# תזה — זיהוי דיבור בעברית

## שאלת המחקר

האם אוגמנטציה של נתונים מצמצמת את שיעור שגיאת המילים בעברית מדוברת?

## אבני דרך

- [x] הצעת מחקר אושרה
- [ ] סקירת ספרות: [[Transformers לזיהוי דיבור]], [[זיהוי דיבור בשפות דלות משאבים]]
- [ ] [[ניסוי 1 — מודל בסיס]]
- [ ] טיוטה ראשונה למנחה
`,
      },
      {
        path: "ספרות/Transformers לזיהוי דיבור.md",
        content: `---
type: article
authors: Vaswani et al.
year: 2017
doi: 10.48550/arXiv.1706.03762
status: נקרא
tags: [literature]
---

# Transformers לזיהוי דיבור

## הטענה, במשפט אחד

מנגנון קשב לבדו מספיק למידול רצפים.

## מה זה אומר על העבודה שלי

הבסיס של [[ניסוי 1 — מודל בסיס]].
`,
      },
      {
        path: "ספרות/זיהוי דיבור בשפות דלות משאבים.md",
        content: `---
type: article
authors: ""
year: 2023
doi: ""
status: לקריאה
tags: [literature]
---

# זיהוי דיבור בשפות דלות משאבים

## למה לקרוא

רלוונטי ל-[[ניסוי 2 — אוגמנטציה]].
`,
      },
      {
        path: "ספרות/מדדי שגיאת מילים.md",
        content: `---
type: article
authors: ""
year: 2019
doi: ""
status: לקריאה
tags: [literature]
---

# מדדי שגיאת מילים

איך מודדים WER בעברית, כשיש תחיליות (ו־, ה־, ב־) שמשנות את גבול המילה?
`,
      },
      {
        path: "יומן מחקר/ניסוי 1 — מודל בסיס.md",
        content: `---
type: experiment
date: 2026-11-02
project: "[[תזה — זיהוי דיבור בעברית]]"
outcome: WER 31%
tags: [research-log]
---

# ניסוי 1 — מודל בסיס

## השערה

מודל רב-לשוני ללא כוונון יגיע ל-WER מעל 30%.

## תוצאות

WER 31% על סט הבדיקה.

## הצעד הבא

- [ ] [[ניסוי 2 — אוגמנטציה]]
`,
      },
      {
        path: "יומן מחקר/ניסוי 2 — אוגמנטציה.md",
        content: `---
type: experiment
date: 2026-11-09
project: "[[תזה — זיהוי דיבור בעברית]]"
outcome: ""
tags: [research-log]
---

# ניסוי 2 — אוגמנטציה

## השערה

שינוי מהירות ורעש רקע יורידו את ה-WER בשתי נקודות לפחות.
`,
      },
      { path: "Bases/ספרות.base", content: base("il-article-reading", "he") },
      { path: "Bases/יומן מחקר.base", content: base("il-research-log", "he") },
      { path: "Bases/עבודות.base", content: base("il-seminar-paper", "he") },
    ];
  }
  return [
    {
      path: ENTRY.en,
      content: `---
tags: [sample, index]
---

# 🔬 The researcher's vault

A thesis at its start: work with an advisor, articles to read, and a log of experiments.

- [[Thesis — Hebrew speech recognition]]: the thesis and its milestones
- [[Transformers for speech]] · [[Low-resource speech recognition]] · [[Word error metrics]]: literature
- [[Experiment 1 — Baseline]] and [[Experiment 2 — Augmentation]]: the research log

- [[Bases/Literature.base|Literature]] · [[Bases/Research log.base|Research log]] · [[Bases/Papers.base|Papers]]
`,
    },
    {
      path: "Thesis — Hebrew speech recognition.md",
      content: `---
type: paper
advisor: Prof. Avraham
due: 2027-06-30
status: literature review
tags: [seminar]
---

# Thesis — Hebrew speech recognition

## Research question

Does data augmentation lower the word error rate on spoken Hebrew?

## Milestones

- [x] Proposal approved
- [ ] Literature review: [[Transformers for speech]], [[Low-resource speech recognition]]
- [ ] [[Experiment 1 — Baseline]]
- [ ] First draft to the advisor
`,
    },
    {
      path: "Literature/Transformers for speech.md",
      content: `---
type: article
authors: Vaswani et al.
year: 2017
doi: 10.48550/arXiv.1706.03762
status: read
tags: [literature]
---

# Transformers for speech

## The claim, in one sentence

Attention alone is enough to model sequences.

## What it means for my work

The basis of [[Experiment 1 — Baseline]].
`,
    },
    {
      path: "Literature/Low-resource speech recognition.md",
      content: `---
type: article
authors: ""
year: 2023
doi: ""
status: to-read
tags: [literature]
---

# Low-resource speech recognition

## Why read it

It bears on [[Experiment 2 — Augmentation]].
`,
    },
    {
      path: "Literature/Word error metrics.md",
      content: `---
type: article
authors: ""
year: 2019
doi: ""
status: to-read
tags: [literature]
---

# Word error metrics

How is WER measured in Hebrew, where prefixes (ו־, ה־, ב־) move the word boundary?
`,
    },
    {
      path: "Research log/Experiment 1 — Baseline.md",
      content: `---
type: experiment
date: 2026-11-02
project: "[[Thesis — Hebrew speech recognition]]"
outcome: WER 31%
tags: [research-log]
---

# Experiment 1 — Baseline

## Hypothesis

A multilingual model without fine-tuning lands above 30% WER.

## Results

31% WER on the test set.

## Next step

- [ ] [[Experiment 2 — Augmentation]]
`,
    },
    {
      path: "Research log/Experiment 2 — Augmentation.md",
      content: `---
type: experiment
date: 2026-11-09
project: "[[Thesis — Hebrew speech recognition]]"
outcome: ""
tags: [research-log]
---

# Experiment 2 — Augmentation

## Hypothesis

Speed changes and background noise lower the WER by at least two points.
`,
    },
    { path: "Bases/Literature.base", content: base("il-article-reading", "en") },
    { path: "Bases/Research log.base", content: base("il-research-log", "en") },
    { path: "Bases/Papers.base", content: base("il-seminar-paper", "en") },
  ];
}
