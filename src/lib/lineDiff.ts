/**
 * Line diff (Myers, O((N+M)·D)) and unified-diff formatting — what
 * `git_diff` shows a model, in the format every model has seen in
 * training. Bounded: past `maxEdits` differing lines the diff gives up and
 * reports the file as rewritten rather than spending unbounded time.
 */

export type DiffOp = { op: "eq" | "add" | "del"; line: string };

/** The edit script turning `a` into `b`, or null when it would need more than `maxEdits` edits. */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = 2000): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    // Only diagonals -(d+1)..d+1 matter for backtracking step d: O(D²) memory, not O(D·(N+M)).
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;
  // Backtrack through the saved frontiers.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const at = (kk: number) => vd[d + 1 + kk];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: "eq", line: a[--x] });
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "add", line: b[--y] });
      else ops.push({ op: "del", line: a[--x] });
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ op: "eq", line: a[--x] });
    y--;
  }
  return ops.reverse();
}

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Marks a last line that has no newline after it, so a change of only the final newline is a change. */
export const NO_EOL = "\u0000no-eol";

/**
 * The lines of a file for diffing, with their line endings kept: a line
 * ending in CRLF keeps its "\r" (so converting LF ↔ CRLF is a change, as
 * in git), and a last line with no newline after it ends in `NO_EOL`.
 */
export function linesWithEol(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const last = lines.pop()!;
  if (last !== "") lines.push(last + NO_EOL);
  return lines;
}

/** A diff line as printed: a trailing CR shows as `^M`, as `git diff` shows it in a terminal. */
function printable(line: string): string {
  return line.endsWith("\r") ? `${line.slice(0, -1)}^M` : line;
}

export interface FileDiff {
  /** The unified diff; empty when nothing changed. */
  text: string;
  /** Lines added / removed. */
  added: number;
  removed: number;
  /**
   * The change was too large to diff line by line: `text` reports it as a
   * rewrite of the whole file, and the counts are its whole old / new length.
   */
  rewritten: boolean;
}

/**
 * A unified diff of one file (`--- a/path`, `+++ b/path`, `@@` hunks with
 * `context` lines around each change). `before` / `after` null mean the
 * file did not exist on that side. Empty string when nothing changed.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  return fileDiff(path, before, after, context).text;
}

/** `unifiedDiff` with the counts of added and removed lines. */
export function fileDiff(path: string, before: string | null, after: string | null, context = 3): FileDiff {
  const a = linesWithEol(before);
  const b = linesWithEol(after);
  const head = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`];
  const ops = diffLines(a, b);
  if (!ops) {
    const text = [...head, `@@ -1,${a.length} +1,${b.length} @@`, `[too many changes to show line by line: ${a.length} → ${b.length} lines]`].join("\n");
    return { text, added: b.length, removed: a.length, rewritten: true };
  }
  const added = ops.filter((o) => o.op === "add").length;
  const removed = ops.filter((o) => o.op === "del").length;
  if (!added && !removed) return { text: "", added, removed, rewritten: false };
  const out = [...head];
  // Positions (1-based) of each op on both sides.
  let ai = 1;
  let bi = 1;
  const pos = ops.map((o) => {
    const p = { a: ai, b: bi };
    if (o.op !== "add") ai++;
    if (o.op !== "del") bi++;
    return p;
  });
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === "eq") {
      i++;
      continue;
    }
    // A hunk: from `context` lines before this change to `context` lines
    // after the last change that is within 2·context of the previous one.
    const start = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length) {
      if (ops[end].op !== "eq") lastChange = end;
      else if (end - lastChange > 2 * context) break;
      end++;
    }
    const stop = Math.min(ops.length, lastChange + context + 1);
    const slice = ops.slice(start, stop);
    const aLen = slice.filter((o) => o.op !== "add").length;
    const bLen = slice.filter((o) => o.op !== "del").length;
    const aStart = aLen ? pos[start].a : pos[start].a - 1;
    const bStart = bLen ? pos[start].b : pos[start].b - 1;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of slice) {
      const noEol = o.line.endsWith(NO_EOL);
      out.push((o.op === "eq" ? " " : o.op === "add" ? "+" : "-") + printable(noEol ? o.line.slice(0, -NO_EOL.length) : o.line));
      if (noEol) out.push("\\ No newline at end of file");
    }
    i = stop;
  }
  return { text: out.join("\n"), added, removed, rewritten: false };
}
