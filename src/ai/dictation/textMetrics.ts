/** Word-level comparison for dictation (punctuation and niqqud ignored), shared by polish and tests. */

const MARKS = /[֑-ׇֽֿׁׂׅׄ]/g;

export function normalizeWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(MARKS, "")
    .normalize("NFC")
    .replace(/[־\-‐-―]/g, " ")
    .replace(/[\p{P}\p{S}]/gu, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function wordEditDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
