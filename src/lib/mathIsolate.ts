/**
 * Math inside Hebrew text (plan W5.14).
 *
 * A formula in a right-to-left sentence breaks in almost every editor:
 *   - KaTeX lays a formula out as a row of inline-blocks, one per group
 *     (`a =`, `b +`, `c`). In a right-to-left paragraph each one is a
 *     neutral object, so the row comes out reversed ("c b+ a=").
 *   - The TeX source fares no better: in "$1+2=3$" the digits, the "+",
 *     the "=" and the "$" signs (European terminators) are all weak or
 *     neutral, and an RTL line reorders them.
 *   - `dir="auto"` picks the paragraph direction from the first strong
 *     character, which is often the formula's "x".
 *
 * The cure is the same everywhere: the formula is a Unicode bidi isolate
 * with direction LTR — `dir="ltr"` on its element (HTML gives every
 * element with a `dir` `unicode-bidi: isolate`, and `dir="auto"` skips it),
 * a CodeMirror mark with `bidiIsolate`, an OMML math zone in Word. This
 * module finds the formulas in Markdown source and marks rendered ones.
 */

export type Span = [from: number, to: number];

/**
 * Inline formulas in one line of Markdown source: `$…$` and `$$…$$` on one
 * line, the way Pandoc and remark-math read them — the opening `$` is not
 * followed by a space, the closing one not preceded by one nor followed by
 * a digit, and `\$` is a literal dollar. So "$5 and $10" is money, not math.
 * Code spans are skipped.
 */
export function inlineMathSpans(line: string): Span[] {
  const out: Span[] = [];
  const code = codeSpanRanges(line);
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "$" || inCode(i) || isEscaped(line, i)) {
      i++;
      continue;
    }
    const fence = line[i + 1] === "$" ? "$$" : "$";
    const start = i + fence.length;
    if (fence === "$" && (line[start] === " " || line[start] === "\t" || start >= line.length)) {
      i++;
      continue;
    }
    let j = start;
    let close = -1;
    while (j < line.length) {
      if (line[j] === "\\") {
        j += 2;
        continue;
      }
      if (line.startsWith(fence, j) && !inCode(j)) {
        const before = line[j - 1];
        const after = line[j + fence.length];
        const ok = fence === "$$" || (before !== " " && before !== "\t" && !(after !== undefined && /[0-9]/.test(after)));
        if (ok && j > start) {
          close = j;
          break;
        }
      }
      j++;
    }
    if (close < 0) {
      i += fence.length;
      continue;
    }
    out.push([i, close + fence.length]);
    i = close + fence.length;
  }
  return out;
}

function isEscaped(s: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) n++;
  return n % 2 === 1;
}

/** Code spans of one line (CommonMark backtick runs), as [from, to) offsets including the backticks. */
export function codeSpanRanges(line: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  const runAt = (k: number) => {
    let e = k;
    while (line[e] === "`") e++;
    return e - k;
  };
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    const n = runAt(i);
    let k = i + n;
    let close = -1;
    while (k < line.length) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      const m = runAt(k);
      if (m === n) {
        close = k;
        break;
      }
      k += m;
    }
    if (close < 0) i += n;
    else {
      out.push([i, close + n]);
      i = close + n;
    }
  }
  return out;
}

/** The line with its inline formulas taken out (for the line-direction rule). */
export function withoutInlineMath(line: string): string {
  const spans = inlineMathSpans(line);
  if (!spans.length) return line;
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    out += line.slice(at, a);
    at = b;
  }
  return out + line.slice(at);
}

/** Line numbers (0-based) inside `$$` display blocks whose fences stand on their own lines. */
export function displayMathLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  let open = -1;
  let fence: string | null = null;
  lines.forEach((line, n) => {
    const code = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (code && code[1][0] === fence[0] && code[1].length >= fence.length) fence = null;
      return;
    }
    if (code && open < 0) {
      fence = code[1];
      return;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      if (open < 0) open = n;
      else {
        for (let k = open; k <= n; k++) out.add(k);
        open = -1;
      }
    }
  });
  return out;
}

// ── Rendered math (hast, after rehype-katex) ────────────────────────────

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const MATH_CLASSES = ["katex", "katex-display", "katex-error", "math-inline", "math-display"];

function classesOf(node: HastNode): string[] {
  const c = node.properties?.className;
  if (Array.isArray(c)) return c.map(String);
  if (typeof c === "string") return c.split(/\s+/);
  return [];
}

/**
 * rehype plugin: every rendered formula (KaTeX's `.katex`, `.katex-display`,
 * `.katex-error`, and remark-math's `.math-inline` / `.math-display` when
 * KaTeX did not run) gets `dir="ltr"`, which makes it an LTR isolate. Runs
 * after rehype-katex. Formulas inside a formula are not visited twice.
 */
export function rehypeMathIsolate() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.type === "element" && classesOf(node).some((c) => MATH_CLASSES.includes(c))) {
        (node.properties ??= {}).dir = "ltr";
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
