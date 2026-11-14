/**
 * The note of the RTL matrix (plan 9.5), shared by e2e/rtl-matrix.spec.ts
 * and visual/rtl.visual.ts: a Hebrew heading and paragraph, an English
 * paragraph, a table with Hebrew and English cells, a Hebrew list with a
 * nested item, an English list (a different marker, so it is its own
 * list), a numbered list, a task list, a Hebrew and an English quote, and
 * code with a Hebrew comment.
 */
export const RTL_NOTE = [
  "# טבלאות ורשימות",
  "",
  "פסקה בעברית עם a few English words באמצע.",
  "",
  "An English paragraph.",
  "",
  "| שם | כמות | Note |",
  "| --- | ---: | --- |",
  "| תפוחים | 3 | fresh |",
  "| Pears | 12 | אגסים |",
  "",
  "- פריט ראשון",
  "- פריט שני",
  "  - פריט מקונן",
  "",
  "* First English item",
  "* Second English item",
  "",
  "1. צעד אחד",
  "2. צעד שני",
  "",
  "- [x] משימה שהושלמה",
  "- [ ] משימה פתוחה",
  "",
  "> ציטוט בעברית.",
  "",
  "> A quote in English.",
  "",
  "```js",
  "const total = 1; // הערה בעברית",
  "```",
  "",
].join("\n");
