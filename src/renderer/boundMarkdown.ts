/**
 * Bounds on pathological Markdown before it is parsed (plan W4.16).
 *
 * W1.27's fuzzer found inputs of 8–14 KB that take 0.5–2.8 s in the
 * preview's remark/rehype chain. All seven have runs of thousands of `[` or
 * `]`, and one also nests lists 231 levels deep. In micromark every `]`
 * looks back through the open link starts (and through all events when
 * there are none), and every nesting level stays open: the cost grows with
 * the square of the text. A note with such a block would freeze the editor
 * on every keystroke — a denial of service from a shared note.
 *
 * A block (text between blank lines) with a part over either bound is shown as raw
 * text instead: it goes into a fenced `text` code block, which the parser
 * reads line by line. Escaping the extra brackets one by one is not enough:
 * thousands of escapes are thousands of tokens, still hundreds of ms.
 *
 *   - MAX_BRACKETS `[` / `]` in one inline run (a paragraph, a list item, a
 *     quote line, a heading, a table row): there the cost is superlinear;
 *     2,000 links in 2,000 list items are not, and stay as they are;
 *   - MAX_CONTAINER_DEPTH nested list items and block quotes on one line.
 *
 * Fenced code and `$$` math blocks are never changed. A note within both
 * bounds (every real note we know of) is returned unchanged after one cheap
 * scan. The incremental preview also falls back to raw text for a block
 * whose render took longer than its deadline (src/renderer/incrementalPreview.ts).
 */

export const MAX_BRACKETS = 1024;
export const MAX_CONTAINER_DEPTH = 32;

const DEEP = new RegExp(`^(?:[ \\t]*(?:>|[*+-]|\\d{1,9}[.)])(?:[ \\t]+|$)){${MAX_CONTAINER_DEPTH + 1}}`, "m");
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that starts its own inline run: a list item, a quote, a heading or a table row. */
const STARTS_RUN = /^[ \t]*(?:>|[*+-][ \t]|\d{1,9}[.)][ \t]|#{1,6}[ \t]|\|)/;

function brackets(text: string, stopAt = Infinity): number {
  let n = 0;
  for (let i = 0; i < text.length && n < stopAt; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5b || c === 0x5d) n++;
  }
  return n;
}

/**
 * Is this text over a bound? The bracket bound is per inline run (a
 * paragraph, a list item, a quote line, a heading or a table row): that is
 * where the parser's cost is superlinear; many links in many list items are
 * not. One cheap scan first, so normal notes pay nothing.
 */
export function needsBounding(md: string): boolean {
  if (DEEP.test(md)) return true;
  if (brackets(md, MAX_BRACKETS + 1) <= MAX_BRACKETS) return false;
  let run = 0;
  for (const line of md.split("\n")) {
    if (!line.trim() || STARTS_RUN.test(line)) run = 0;
    run += brackets(line);
    if (run > MAX_BRACKETS) return true;
  }
  return false;
}

/** `text` as a fenced code block that shows it exactly (the fence outlasts any backtick run inside). */
export function asRawText(text: string): string {
  let longest = 2;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text.replace(/\n+$/, "")}\n${fence}`;
}

/** `md` with every block over a bound shown as raw text (unchanged when none is). */
export function boundMarkdown(md: string): string {
  if (!needsBounding(md)) return md;
  const out: string[] = [];
  let block: string[] = [];
  const flush = () => {
    if (!block.length) return;
    const text = block.join("\n");
    out.push(needsBounding(text) ? asRawText(text) : text);
    block = [];
  };
  let fence: string | null = null;
  let math = false;
  for (const line of md.split("\n")) {
    if (fence) {
      out.push(line);
      const f = FENCE.exec(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (math) {
      out.push(line);
      if (line.trim() === "$$") math = false;
      continue;
    }
    const f = FENCE.exec(line);
    if (f || line.trim() === "$$") {
      flush();
      out.push(line);
      if (f) fence = f[1];
      else math = true;
      continue;
    }
    if (!line.trim()) {
      flush();
      out.push(line);
      continue;
    }
    block.push(line);
  }
  flush();
  return out.join("\n");
}
