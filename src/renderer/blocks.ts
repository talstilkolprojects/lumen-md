/**
 * Top-level blocks of a Markdown document, for incremental outline and
 * preview (plan 8.4).
 *
 * A block boundary is a place where parsing the text before it and the
 * text after it separately gives the same tree as parsing the whole: a
 * blank line followed by an unindented line, outside a code fence, a
 * `$$` math block, a multi-line HTML block (`<!-- … -->`, `<pre>`…) and —
 * for the preview — outside an open HTML element or `:::` container. A
 * loose list stays one block. When unsure, the splitter merges: a bigger
 * block is never wrong, only slower.
 *
 * Every boundary is at "top level", so after an edit the blocks before
 * the edit are kept, the text is re-scanned from the block before the
 * edit, and scanning stops at the first boundary after the edit that was
 * a boundary before it too — the rest of the document is unchanged.
 */

export interface Block {
  /** Offset of the block's first character. */
  start: number;
  /** Offset just past its last character (its trailing blank lines included). */
  end: number;
}

export interface SplitOptions {
  /**
   * Preview mode: HTML elements and `:::` directives may span blank lines
   * there (rehype-raw / remark-directive), so blocks stay together until
   * they are closed.
   */
  preview?: boolean;
}

const BLANK = /^[ \t]*\r?$/;
const INDENTED = /^[ \t]/;
const LIST_MARKER = /^( {0,3}(?:[-+*]|\d{1,9}[.)]))([ \t]*)/;
const LIST_CAN_INTERRUPT = /^ {0,3}(?:[-+*]|1[.)])[ \t]+\S/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|\r?$)/;
const FENCE_OPEN = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;
const MATH_OPEN = /^ {0,3}(\${2,})[^$]*$/;
const CONTAINER = /^ {0,3}(:{3,})[ \t]*([A-Za-z][\w-]*)?/;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** An HTML tag; the name must end at a space, `/` or `>`, so autolinks (`<https://…>`, `<a@b.c>`) are not tags. */
/**
 * Elements whose end tag may be left out (`<p>` closes the paragraph
 * before it): neither their start nor end tag is counted, so they cannot
 * leave the depth open — the element around them (`<ul>`, `<table>`)
 * still is counted.
 */
const OPTIONAL_END = new Set(["p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot", "option", "optgroup", "colgroup", "caption", "rt", "rp", "rb", "rtc"]);
const TAG = /<(\/?)([A-Za-z][\w-]*)(?=[\s/>])[^<>]*?(\/?)>/g;

/** CommonMark HTML block 6: a block-level tag; runs until a blank line, and can interrupt a paragraph. */
const HTML_BLOCK_6 =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|\/>|\r?$)/i;
/** CommonMark HTML block 7: any complete tag alone on its line; runs until a blank line, cannot interrupt a paragraph. */
const HTML_BLOCK_7 =
  /^ {0,3}(?:<(?!(?:script|style|pre|textarea)\b)[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*\r?$/i;
/** Lines that are never paragraph text: ATX headings and thematic breaks (or `---` setext underlines). */
const NOT_PARAGRAPH = /^ {0,3}(?:#{1,6}(?:[ \t]|\r?$)|([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$)/;
/** A `===` setext underline: ends the paragraph above it (with none above, it is text). */
const SETEXT_EQ = /^ {0,3}=+[ \t]*\r?$/;

/** CommonMark HTML blocks 1–5, which run across blank lines until their end marker. */
const RAW_HTML: [RegExp, RegExp][] = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];

/** Leading columns of `line` (a tab counts as 4). */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** `line` without what Markdown does not read as HTML: code spans, comments, escaped `\<`. */
function htmlOnly(line: string): string {
  return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, "").replace(/<!--.*?-->/g, "").replace(/\\</g, "");
}

/** Open-element depth after the complete tags on `line` (preview: rehype-raw nests elements across blocks). */
function countTags(line: string, depth: number): number {
  TAG.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TAG.exec(line)) !== null) {
    const name = t[2].toLowerCase();
    if (t[3] || VOID_TAGS.has(name) || OPTIONAL_END.has(name)) continue;
    depth = t[1] ? Math.max(0, depth - 1) : depth + 1;
  }
  return depth;
}

/** An opening tag still open at the end of the line (`<div` + attributes on the next lines). */
const UNTERMINATED_TAG = /<([A-Za-z][\w-]*)(?=[\s/]|$)[^<>]*$/;

interface Scan {
  blocks: Block[];
  /** Set when `stopAt` accepted a boundary: the blocks end there. */
  stoppedAt?: number;
}

/**
 * Split `text` from offset `from` (which must be 0 or a block boundary).
 * `stopAt(p)` is asked at every new boundary `p`; true ends the scan there.
 */
export function splitBlocks(text: string, opts: SplitOptions = {}, from = 0, stopAt?: (p: number) => boolean): Scan {
  const blocks: Block[] = [];
  const len = text.length;
  let start = from;
  let hasContent = false;
  let isList = false;
  let blankSeen = false;
  let fence: { ch: string; len: number } | null = null;
  let math = 0;
  let rawEnd: RegExp | null = null;
  /** The HTML block 1–5 is a `<pre>` (whose content is elements, not opaque text). */
  let rawPre = false;
  /** In an HTML block 6 / 7: Markdown resumes after the next blank line. */
  let htmlToBlank = false;
  /** The previous line is paragraph text (an HTML block 7 cannot interrupt it). */
  let paragraph = false;
  let htmlDepth = 0;
  /** An opening tag spans lines: its `>` is still to come. */
  let tagOpen = false;
  /** The backticks of a code span still open at the end of the last line. */
  let openTicks: string | null = null;
  /** An HTML comment opened after text on an earlier line, its `-->` still to come. */
  let openComment = false;
  /** Follow the HTML elements a line opens and closes (preview). */
  const trackHtml = (raw: string) => {
    if (!opts.preview || (!tagOpen && !openTicks && !openComment && !raw.includes("<") && !raw.includes("`"))) return;
    let rest = raw;
    // A code span can cross lines (not a blank one): its text is not HTML.
    if (openTicks) {
      const close = rest.search(new RegExp(`(?<!\`)${openTicks}(?!\`)`));
      if (close < 0) return;
      rest = rest.slice(close + openTicks.length);
      openTicks = null;
    }
    // So can a comment that opens after text (`Text <!--`).
    if (openComment) {
      const end = rest.indexOf("-->");
      if (end < 0) return;
      rest = rest.slice(end + 3);
      openComment = false;
    }
    let line = htmlOnly(rest);
    const tick = /`+/.exec(line);
    if (tick) {
      openTicks = tick[0];
      line = line.slice(0, tick.index);
    }
    const comment = line.indexOf("<!--");
    if (comment >= 0) {
      openComment = true;
      line = line.slice(0, comment);
    }
    if (tagOpen) {
      const gt = line.indexOf(">");
      if (gt < 0) return;
      tagOpen = false;
      // `<br\n/>`-style self-closing: it never opened.
      if (line[gt - 1] === "/") htmlDepth = Math.max(0, htmlDepth - 1);
      line = line.slice(gt + 1);
    }
    htmlDepth = countTags(line, htmlDepth);
    const u = UNTERMINATED_TAG.exec(line);
    if (u && !VOID_TAGS.has(u[1].toLowerCase())) {
      htmlDepth++;
      tagOpen = true;
    }
  };
  /** Columns of the current top-level list item's content. */
  let itemIndent = Infinity;
  /** A fence open inside the current list item. */
  let itemFence: { ch: string; len: number } | null = null;
  /** The current list item has nothing on its marker line yet. */
  let itemEmpty = false;
  /** An HTML block runs inside the current list item until a blank line. */
  let itemHtml = false;
  /** The previous line was blank (or this is the first line). */
  let afterBlank = true;
  const containers: number[] = [];
  let pos = from;
  // YAML frontmatter can hold blank lines: it is one block (preview only;
  // the outline strips it before splitting, like extractToc).
  if (opts.preview && from === 0 && /^---\r?\n/.test(text)) {
    const close = /\n---[ \t]*(?:\r?\n|$)/g;
    close.lastIndex = 3;
    const m = close.exec(text);
    if (m) {
      pos = m.index + m[0].length;
      hasContent = true;
    }
  }
  // A lone CR ends a line too (CommonMark); found once, reused until passed.
  let cr = text.indexOf("\r", pos);
  while (pos < len) {
    if (cr >= 0 && cr < pos) cr = text.indexOf("\r", pos);
    const nl = text.indexOf("\n", pos);
    let lineEnd = nl < 0 ? len : nl;
    let next = nl < 0 ? len : nl + 1;
    if (cr >= 0 && cr < lineEnd) {
      lineEnd = cr;
      next = text[cr + 1] === "\n" ? cr + 2 : cr + 1;
    }
    const line = text.slice(pos, lineEnd);
    const prevBlank = afterBlank;
    afterBlank = BLANK.test(line);
    if (fence) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      paragraph = false;
    } else if (math) {
      const m = /^ {0,3}(\${2,})[ \t]*\r?$/.exec(line);
      if (m && m[1].length >= math) math = 0;
      paragraph = false;
    } else if (rawEnd) {
      if (rawEnd.test(line)) rawEnd = null;
      // Comments, <script>, <style>… are opaque; only <pre> holds elements.
      if (rawPre) trackHtml(line);
      paragraph = false;
    } else if (BLANK.test(line)) {
      if (hasContent) blankSeen = true;
      // An item can start with at most one blank line: after an empty
      // item and a blank, indented text is no longer inside it.
      if (itemEmpty) itemIndent = Infinity;
      itemEmpty = false;
      itemHtml = false;
      htmlToBlank = false;
      // Inline code and inline comments end with the paragraph.
      openTicks = null;
      openComment = false;
      paragraph = false;
    } else {
      const canSplit =
        blankSeen &&
        !INDENTED.test(line) &&
        !(isList && LIST_ITEM.test(line)) &&
        htmlDepth === 0 &&
        containers.length === 0;
      if (canSplit) {
        blocks.push({ start, end: pos });
        if (stopAt?.(pos)) return { blocks, stoppedAt: pos };
        start = pos;
        hasContent = false;
      }
      blankSeen = false;
      if (!hasContent) {
        hasContent = true;
        isList = false;
        itemIndent = Infinity;
        itemFence = null;
        itemHtml = false;
      }
      const indent = indentOf(line);
      // Inside an HTML block 6 / 7 every line is HTML, list markers too.
      if (htmlToBlank) {
        trackHtml(line);
        paragraph = false;
        pos = next;
        continue;
      }
      // Indented code (no paragraph to continue): no Markdown inside.
      if (!paragraph && !isList && indent >= 4) {
        pos = next;
        continue;
      }
      // A line indented to the list item's content is item content: a fence
      // or an HTML block there ends with the item, not at top level.
      const nested = isList && indent >= itemIndent;
      // A list starts here (only a non-empty bullet or `1.` interrupts a paragraph).
      // An empty item ("-" alone) starts one only after a blank line (micromark).
      if (!isList && LIST_ITEM.test(line) && (LIST_CAN_INTERRUPT.test(line) || (!paragraph && prevBlank))) isList = true;
      if (isList && !nested) {
        if (LIST_ITEM.test(line)) {
          const [marker, bullet, spaces] = LIST_MARKER.exec(line)!;
          const content = line.slice(marker.length);
          itemEmpty = BLANK.test(content);
          // Content column: after the marker and its spaces; one past the
          // marker for an empty item or indented code (5+ spaces).
          itemIndent = itemEmpty || spaces.length >= 5 ? bullet.length + 1 : marker.length;
          itemFence = null;
          itemHtml = false;
          const f = FENCE_OPEN.exec(content);
          if (f) itemFence = { ch: (f[1] ?? f[2])[0], len: (f[1] ?? f[2]).length };
          paragraph = !f && !NOT_PARAGRAPH.test(content) && !BLANK.test(content);
          trackHtml(line);
          pos = next;
          continue;
        }
        // Less indented than the item: lazy paragraph text keeps the list
        // going; anything else (a heading, a rule, a fence…) ends it. A
        // lone tag there becomes HTML inside the item (as micromark does),
        // continued by the item's indented lines.
        if (!itemFence && !itemHtml && paragraph && HTML_BLOCK_7.test(line) && !HTML_BLOCK_6.test(line)) {
          itemHtml = true;
          paragraph = false;
          trackHtml(line);
          pos = next;
          continue;
        }
        const lazy =
          !itemFence &&
          !itemHtml &&
          paragraph &&
          !NOT_PARAGRAPH.test(line) &&
          !FENCE_OPEN.test(line) &&
          !/^ {0,3}>/.test(line) &&
          !HTML_BLOCK_6.test(line) &&
          !RAW_HTML.some(([open]) => open.test(line));
        if (lazy) {
          trackHtml(line);
          pos = next;
          continue;
        }
        isList = false;
        itemIndent = Infinity;
        itemFence = null;
        itemHtml = false;
      } else if (nested) {
        itemEmpty = false;
        // Inside the item: follow its fences, so text after one ends the list.
        let k = 0;
        while (k < line.length && k < itemIndent && (line[k] === " " || line[k] === "\t")) k++;
        const content = line.slice(k);
        if (itemHtml) {
          paragraph = false;
        } else if (itemFence) {
          const m = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(content);
          if (m && m[1][0] === itemFence.ch && m[1].length >= itemFence.len) itemFence = null;
          paragraph = false;
        } else {
          const f = FENCE_OPEN.exec(content);
          if (f) itemFence = { ch: (f[1] ?? f[2])[0], len: (f[1] ?? f[2]).length };
          paragraph = !f && !NOT_PARAGRAPH.test(content) && !(paragraph && SETEXT_EQ.test(content));
        }
        trackHtml(line);
        pos = next;
        continue;
      }
      // Top level: does a fence, a math block or an HTML block start here?
      const f = FENCE_OPEN.exec(line);
      const mo = opts.preview ? MATH_OPEN.exec(line) : null;
      const raw = RAW_HTML.find(([open]) => open.test(line));
      let opened = true;
      if (f) {
        const marker = f[1] ?? f[2];
        fence = { ch: marker[0], len: marker.length };
      } else if (mo) {
        math = mo[1].length;
      } else if (raw) {
        // HTML block 1–5, unless it ends on this line (`<!-- x -->`).
        if (!raw[1].test(line.replace(raw[0], ""))) rawEnd = raw[1];
        rawPre = /^ {0,3}<pre(?:[\s>]|$)/i.test(line);
      } else if (HTML_BLOCK_6.test(line) || (!paragraph && HTML_BLOCK_7.test(line))) {
        htmlToBlank = true;
      } else {
        opened = false;
        const c = opts.preview ? CONTAINER.exec(line) : null;
        if (c?.[2]) containers.push(c[1].length);
        else if (c && containers.length && c[1].length >= containers[containers.length - 1]) containers.pop();
      }
      if (!raw || rawPre) trackHtml(line);
      paragraph = !opened && !NOT_PARAGRAPH.test(line) && !(paragraph && SETEXT_EQ.test(line));
    }
    pos = next;
  }
  if (start < len) blocks.push({ start, end: len });
  return { blocks };
}

/** Length of the common prefix of `a` and `b` (compared in chunks, then per character). */
export function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  for (let step = 4096; step >= 1; step >>= 4) {
    while (i + step <= max && a.slice(i, i + step) === b.slice(i, i + step)) i += step;
  }
  return i;
}

/** Length of the common suffix of `a` and `b`, at most `max`. */
export function commonSuffix(a: string, b: string, max: number): number {
  let i = 0;
  for (let step = 4096; step >= 1; step >>= 4) {
    while (i + step <= max && a.slice(a.length - i - step, a.length - i) === b.slice(b.length - i - step, b.length - i)) i += step;
  }
  return i;
}

export interface BlockUpdate {
  blocks: Block[];
  /** Blocks [0, head) are the previous blocks [0, head), unchanged. */
  head: number;
  /** New blocks [head, tail) were scanned again. */
  tail: number;
  /** New blocks [tail, …) are the previous blocks [oldTail, …), shifted. */
  oldTail: number;
  /** Characters scanned for this update. */
  scanned: number;
}

/** The blocks of a document that changes a little at a time. */
export class BlockTracker {
  private text = "";
  private blocks: Block[] = [];

  constructor(private readonly opts: SplitOptions = {}) {}

  update(text: string): BlockUpdate {
    const old = this.text;
    const oldBlocks = this.blocks;
    if (old === text && (oldBlocks.length || !text)) {
      return { blocks: oldBlocks, head: oldBlocks.length, tail: oldBlocks.length, oldTail: oldBlocks.length, scanned: 0 };
    }
    const prefix = commonPrefix(old, text);
    const suffix = commonSuffix(old, text, Math.min(old.length, text.length) - prefix);
    const delta = text.length - old.length;
    const changeEnd = text.length - suffix;
    // The block holding the first change, and one before it: its boundary
    // decision looks at the line after it.
    let idx = 0;
    while (idx + 1 < oldBlocks.length && oldBlocks[idx + 1].start <= prefix) idx++;
    const head = Math.max(0, idx - 1);
    // Block 0 starts at 0, so a scan from block 0 also finds the frontmatter.
    const from = oldBlocks[head]?.start ?? 0;
    const oldStarts = new Map<number, number>();
    for (let k = idx + 1; k < oldBlocks.length; k++) oldStarts.set(oldBlocks[k].start, k);
    const scan = splitBlocks(text, this.opts, from, (p) => p >= changeEnd && oldStarts.has(p - delta));
    const blocks = oldBlocks.slice(0, head).concat(scan.blocks);
    const tail = blocks.length;
    let oldTail = oldBlocks.length;
    if (scan.stoppedAt !== undefined) {
      oldTail = oldStarts.get(scan.stoppedAt - delta)!;
      for (let k = oldTail; k < oldBlocks.length; k++) blocks.push({ start: oldBlocks[k].start + delta, end: oldBlocks[k].end + delta });
    }
    this.text = text;
    this.blocks = blocks;
    const scannedTo = scan.stoppedAt ?? text.length;
    return { blocks, head, tail, oldTail, scanned: scannedTo - from };
  }

  reset(): void {
    this.text = "";
    this.blocks = [];
  }
}
