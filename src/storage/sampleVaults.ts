/**
 * Sample vaults for Israeli use cases (plan W3.6): a student, a researcher
 * and a writer, each in Hebrew and in English.
 *
 * Every vault is a folder of plain Obsidian-compatible Markdown (frontmatter
 * with English keys, `[[wiki-links]]`) plus `.base` views over it — the same
 * notes the gallery's templates make, already filled in, so a new user sees
 * the templates, the links and the Bases views working together.
 *
 * Safety contract, as for the sample workspace: NEVER overwrites. A file is
 * written only when its path is free, so running the command again is
 * idempotent and the user's edits survive.
 *
 * This module is loaded on demand (from the command), so the Hebrew and
 * English content never reaches the startup bundle.
 */
import { joinPath, workspaceHasFile, writeWorkspaceFile } from "./workspace";
import type { SampleFile } from "./sampleWorkspace";
import { student, researcher, ENTRY, base } from "./sampleVaultNotes";
import type { SampleVaultLang } from "./sampleVaultNotes";
export type { SampleVaultLang } from "./sampleVaultNotes";

export type SampleVaultId = "student" | "researcher" | "writer";

export const SAMPLE_VAULT_IDS: readonly SampleVaultId[] = ["student", "researcher", "writer"];

export interface SampleVault {
  id: SampleVaultId;
  lang: SampleVaultLang;
  /** Folder the vault is written into. */
  root: string;
  /** Path, relative to the root, of the note to open first. */
  entry: string;
  files: SampleFile[];
}

const ROOTS: Record<SampleVaultId, Record<SampleVaultLang, string>> = {
  student: { en: "Sample vault — Student", he: "כספת לדוגמה — סטודנטים" },
  researcher: { en: "Sample vault — Researcher", he: "כספת לדוגמה — מחקר" },
  writer: { en: "Sample vault — Writer", he: "כספת לדוגמה — כתיבה" },
};

/* ─── Writer ─────────────────────────────────────────────────────────── */

function writer(lang: SampleVaultLang): SampleFile[] {
  if (lang === "he") {
    return [
      {
        path: ENTRY.he,
        content: `---
tags: [sample, index]
---

# ✍️ הכספת של הכותב/ת

רומן בעבודה: פרקים עם יעד מילים, ודמויות שמקושרות לפרקים שבהם הן מופיעות.

- פרקים: [[פרק 1 — הרכבת לבאר שבע]] · [[פרק 2 — הדירה בשכונה ד׳]] · [[פרק 3 — שבת]]
- דמויות: [[נועה]] · [[סבא יוסף]] · [[עמית]]

- [[Bases/כתב היד.base|כתב היד]] · [[Bases/דמויות.base|דמויות]]
`,
      },
      {
        path: "פרקים/פרק 1 — הרכבת לבאר שבע.md",
        content: `---
type: chapter
chapter: 1
pov: "[[נועה]]"
words_goal: 3000
status: טיוטה
tags: [chapter]
---

# פרק 1 — הרכבת לבאר שבע

## מה הפרק הזה משנה

[[נועה]] חוזרת לעיר אחרי עשר שנים, ומחליטה לא לספר ל[[סבא יוסף]] למה.

## סצנות

1. התחנה בתל אביב, שש בבוקר.
2. השיחה עם [[עמית]] ברכבת.
`,
      },
      {
        path: "פרקים/פרק 2 — הדירה בשכונה ד׳.md",
        content: `---
type: chapter
chapter: 2
pov: "[[נועה]]"
words_goal: 3000
status: ראשי פרקים
tags: [chapter]
---

# פרק 2 — הדירה בשכונה ד׳

## סצנות

1. המפתח מתחת לעציץ.
2. [[סבא יוסף]] כבר ער.
`,
      },
      {
        path: "פרקים/פרק 3 — שבת.md",
        content: `---
type: chapter
chapter: 3
pov: "[[סבא יוסף]]"
words_goal: 2500
status: רעיון
tags: [chapter]
---

# פרק 3 — שבת

ארוחת שישי, ו[[עמית]] מגיע בלי להודיע.
`,
      },
      {
        path: "דמויות/נועה.md",
        content: `---
type: character
role: ראשית
age: 34
tags: [character]
---

# נועה

## רוצה

לסגור את הבית של סבתא בלי לפתוח את מה שקרה בו.

## מופיעה ב-

- [[פרק 1 — הרכבת לבאר שבע]]
- [[פרק 2 — הדירה בשכונה ד׳]]
`,
      },
      {
        path: "דמויות/סבא יוסף.md",
        content: `---
type: character
role: משנה
age: 88
tags: [character]
---

# סבא יוסף

## איך מדבר

משפטים קצרים, ותמיד שאלה בסוף.
`,
      },
      {
        path: "דמויות/עמית.md",
        content: `---
type: character
role: משנה
age: 35
tags: [character]
---

# עמית

חבר מהתיכון של [[נועה]]; עובד בסורוקה.
`,
      },
      { path: "Bases/כתב היד.base", content: base("il-book-chapter", "he") },
      { path: "Bases/דמויות.base", content: base("il-character", "he") },
    ];
  }
  return [
    {
      path: ENTRY.en,
      content: `---
tags: [sample, index]
---

# ✍️ The writer's vault

A novel in progress: chapters with a word goal, and characters linked to the chapters they appear in.

- Chapters: [[Chapter 1 — The train to Beersheba]] · [[Chapter 2 — The flat in Dalet]] · [[Chapter 3 — Shabbat]]
- Characters: [[Noa]] · [[Grandpa Yosef]] · [[Amit]]

- [[Bases/Manuscript.base|Manuscript]] · [[Bases/Characters.base|Characters]]
`,
    },
    {
      path: "Chapters/Chapter 1 — The train to Beersheba.md",
      content: `---
type: chapter
chapter: 1
pov: "[[Noa]]"
words_goal: 3000
status: draft
tags: [chapter]
---

# Chapter 1 — The train to Beersheba

## What this chapter changes

[[Noa]] comes back to the city after ten years, and decides not to tell [[Grandpa Yosef]] why.

## Scenes

1. The Tel Aviv station, six in the morning.
2. The talk with [[Amit]] on the train.
`,
    },
    {
      path: "Chapters/Chapter 2 — The flat in Dalet.md",
      content: `---
type: chapter
chapter: 2
pov: "[[Noa]]"
words_goal: 3000
status: outline
tags: [chapter]
---

# Chapter 2 — The flat in Dalet

## Scenes

1. The key under the flowerpot.
2. [[Grandpa Yosef]] is already awake.
`,
    },
    {
      path: "Chapters/Chapter 3 — Shabbat.md",
      content: `---
type: chapter
chapter: 3
pov: "[[Grandpa Yosef]]"
words_goal: 2500
status: idea
tags: [chapter]
---

# Chapter 3 — Shabbat

Friday dinner, and [[Amit]] turns up unannounced.
`,
    },
    {
      path: "Characters/Noa.md",
      content: `---
type: character
role: lead
age: 34
tags: [character]
---

# Noa

## Wants

To close up her grandmother's house without opening what happened in it.

## Appears in

- [[Chapter 1 — The train to Beersheba]]
- [[Chapter 2 — The flat in Dalet]]
`,
    },
    {
      path: "Characters/Grandpa Yosef.md",
      content: `---
type: character
role: supporting
age: 88
tags: [character]
---

# Grandpa Yosef

## How he speaks

Short sentences, and always a question at the end.
`,
    },
    {
      path: "Characters/Amit.md",
      content: `---
type: character
role: supporting
age: 35
tags: [character]
---

# Amit

[[Noa]]'s friend from high school; works at Soroka.
`,
    },
    { path: "Bases/Manuscript.base", content: base("il-book-chapter", "en") },
    { path: "Bases/Characters.base", content: base("il-character", "en") },
  ];
}

const BUILDERS: Record<SampleVaultId, (lang: SampleVaultLang) => SampleFile[]> = { student, researcher, writer };

/** The files of one sample vault, in one language. */
export function sampleVault(id: SampleVaultId, lang: SampleVaultLang): SampleVault {
  return { id, lang, root: ROOTS[id][lang], entry: ENTRY[lang], files: BUILDERS[id](lang) };
}

export interface SampleVaultResult {
  root: string;
  /** Workspace path of the note to open first. */
  entry: string;
  created: string[];
  skipped: string[];
}

/**
 * Write a sample vault into the workspace, skipping every path that already
 * exists. Hebrew for a Hebrew UI, English otherwise.
 */
export async function createSampleVault(id: SampleVaultId, locale: string): Promise<SampleVaultResult> {
  const vault = sampleVault(id, locale === "he" ? "he" : "en");
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of vault.files) {
    const full = joinPath(vault.root, file.path);
    if (await workspaceHasFile(full)) {
      skipped.push(full);
      continue;
    }
    await writeWorkspaceFile(full, file.content);
    created.push(full);
  }
  return { root: vault.root, entry: joinPath(vault.root, vault.entry), created, skipped };
}
