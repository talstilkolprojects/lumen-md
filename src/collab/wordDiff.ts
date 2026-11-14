/**
 * Word-level comparison of two versions (W3.11), right for Hebrew.
 *
 * Text splits into words, spaces and punctuation. A Hebrew word keeps its
 * one-letter prefixes (ו, ה, ב, ל, מ, ש, כ) and its niqqud and cantillation
 * marks, and a geresh or gershayim inside a word (צה״ל, ג'ירפה) does not
 * split it. So "הבית" to "ובית" is one changed word, not a changed letter.
 * The diff is a longest common subsequence over those tokens, with
 * neighbouring changes merged so a replaced phrase reads as one deletion and
 * one insertion.
 */

export type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['"\u05F3\u05F4][\p{L}\p{M}]+)*|\s+|[^\s\p{L}\p{M}\p{N}]/gu;

export function wordTokens(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** Above this many token pairs, compare line by line first. */
const LIMIT = 4_000_000;

function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // Trim the common head and tail: most edits are small.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  if (start > 0) ops.push({ type: "equal", text: a.slice(0, start).join("") });
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  if (A.length * B.length > LIMIT) {
    if (A.length) ops.push({ type: "delete", text: A.join("") });
    if (B.length) ops.push({ type: "insert", text: B.join("") });
  } else {
    const w = B.length + 1;
    const dp = new Uint32Array((A.length + 1) * w);
    for (let i = A.length - 1; i >= 0; i--)
      for (let j = B.length - 1; j >= 0; j--)
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) {
        ops.push({ type: "equal", text: A[i++] });
        j++;
      } else if (i < A.length && (j >= B.length || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        // On a tie, the deletion first: "-old +new" reads in order.
        ops.push({ type: "delete", text: A[i++] });
      } else {
        ops.push({ type: "insert", text: B[j++] });
      }
    }
  }
  if (endA < n) ops.push({ type: "equal", text: a.slice(endA).join("") });
  return ops;
}

/** Merge runs: same-type neighbours join, and a lone space between two changes joins the change. */
function tidy(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    if (!op.text) continue;
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else out.push({ ...op });
  }
  // "del ins = del ins" → "del del ins ins" when the equal part is only whitespace.
  for (let k = 1; k + 1 < out.length; k++) {
    const mid = out[k];
    if (mid.type !== "equal" || /\S/.test(mid.text)) continue;
    const before = out.slice(Math.max(0, k - 2), k);
    const after = out.slice(k + 1, k + 3);
    const changed = (xs: DiffOp[]) => xs.length > 0 && xs.every((x) => x.type !== "equal");
    if (!changed(before) || !changed(after)) continue;
    const del = [...before, mid, ...after].filter((x) => x.type !== "insert").map((x) => x.text).join("");
    const ins = [...before, mid, ...after].filter((x) => x.type !== "delete").map((x) => x.text).join("");
    out.splice(k - before.length, before.length + 1 + after.length, { type: "delete", text: del }, { type: "insert", text: ins });
    k = Math.max(0, k - before.length);
  }
  return out;
}

export function wordDiff(older: string, newer: string): DiffOp[] {
  return tidy(lcsOps(wordTokens(older), wordTokens(newer)));
}

/** How many words were added and removed (for a version list). */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  const words = (s: string) => wordTokens(s).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "insert") added += words(op.text);
    if (op.type === "delete") removed += words(op.text);
  }
  return { added, removed };
}
