/**
 * True redaction for exports (plan W5.11, journalist mode, part 2).
 *
 * Text the author marks with `<redact>…</redact>` stays in the note, where
 * the author can see it, and is *removed* from every export: the PDF, DOCX,
 * HTML and Markdown files get a fixed placeholder (█████) instead of the
 * text. Nothing is covered by a black box over text that is still there, so
 * copying, `pdftotext` or unzipping the DOCX finds nothing.
 *
 * Rules, all of which fail closed (when in doubt, more is removed):
 *   - The placeholder has the same length whatever was removed, so its size
 *     tells nothing about a name's length.
 *   - A mark is what the preview takes for a `redact` element: the HTML
 *     tokenizer's rules (`redactMarks`), so `<redact class="x">`,
 *     `<redact\tid=1>` and `<redact/>` are marks too (review F-8). A tag cut
 *     off by the end of the note opens a mark.
 *   - Marks nest; the outermost pair wins. A `<redact>` that is never closed
 *     removes everything to the end of the note, and every footnote
 *     definition: the preview appends the footnotes after the last block,
 *     inside that passage (review 8, RR8-473-2).
 *   - Every pass reads the note as the preview parses it, with the
 *     CriticMarkup delimiters swapped (review 8, RR8-473-1).
 *   - "Redact selection" over text that already holds marks merges them into
 *     one mark over the whole selection, and leaves every passage outside it
 *     as covered as it was (review F-9).
 *   - Marks count inside code blocks and code spans too: a secret in a code
 *     block is still a secret.
 *   - A closing mark the preview doesn't read as one ends nothing, so the
 *     export never keeps what the preview shades (review F-8, preview ⊆
 *     export): one written as text (in code, math, a link's target, a
 *     comment, another tag's attribute, a raw-text element such as
 *     <textarea>) ends only a mark also written as text, and none ends a
 *     passage while an element HTML doesn't close through (p, div, table…)
 *     is open inside it (`markInertCloses`). The same holds for the
 *     elements Markdown makes: a close typed in a list item, a quote, a
 *     table cell or a paragraph after a `<redact>` on its own line ends
 *     nothing, decided on micromark's tree, the one the preview renders
 *     (`treeInertCloses`, review 6). A close counts only where both passes
 *     say it closes.
 *   - Hidden text that a reader of the file could find is removed too: HTML
 *     comments (`<!-- … -->`, an unclosed one runs to the end) and Obsidian
 *     comments (`%% … %%`), except inside code, where they are code.
 *   - Photos inlined as `data:` URLs, under any label (the bytes decide, as in
 *     a browser), lose their GPS, time and device
 *     metadata, unless the user keeps it (Settings, the same switch as for
 *     photos added to a note). A photo whose metadata can't be removed (it
 *     can't be parsed, and there is no canvas to re-encode it) is replaced by
 *     an empty image: it never leaves as it was (review 12.11).
 */

import { cleanDataUrls, cleanDataUrlsAsync, cleanImageBytes, keepImageMetadata, WITHHELD_IMAGE } from "./imageMetadata";
import { prepareCriticMarkupMapped } from "../renderer/criticMarkup";
import { footnoteDefinitionRanges, treeInertCloses } from "./redactionTree";

export { WITHHELD_IMAGE };

/** What replaces each redacted passage. Fixed length on purpose. */
export const REDACTED = "█████";

export const REDACT_OPEN = "<redact>";
export const REDACT_CLOSE = "</redact>";

/** A redaction mark in the text: `[index, end)` is the whole tag. */
export interface RedactMark {
  index: number;
  end: number;
  close: boolean;
  /**
   * A closing mark the preview does not read as one (review F-8, preview ⊆
   * export): inside code, math, a link's target, a comment, another tag, a
   * raw-text element, or above an element that HTML does not close through.
   * It ends nothing: the passage goes on.
   */
  inert?: boolean;
}

/** The HTML tokenizer's whitespace (CR included: the input stream turns it into LF). */
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

/**
 * Every redaction mark in `text`, in order — the one parser for the export
 * and for what the preview shades. It follows the HTML tokenizer that builds
 * the preview's `redact` elements (rehype-raw / parse5, the same rules as a
 * browser's): `<` or `</`, the name `redact` in any ASCII case, then
 * whitespace, `/` or `>`; attributes up to the `>` that ends the tag, where a
 * `>` inside a quoted value does not end it. `<redact/>` opens a mark (HTML
 * ignores the slash on an element that is not void). A tag that the end of
 * the text cuts off runs to the end: as an opening mark it removes the rest
 * (fail closed). `</ redact>` is not a closing mark (HTML reads it as a
 * comment), so the mark before it stays open.
 */
export function redactMarks(text: string): RedactMark[] {
  // The preview parses the note with its CriticMarkup delimiters swapped for one character each, so a
  // `>` of `{>>` or `~>` ends no tag there (review 8, RR8-473-1): every pass reads that text, and the
  // marks are mapped back to the note.
  const { text: seen, at } = prepareCriticMarkupMapped(text);
  const marks = candidateMarks(seen);
  if (marks.some((m) => m.close)) {
    // Two passes, and a close counts only where both say it closes (fail closed): the Markdown tree the
    // preview builds (review 6, RR6-473-1), then the text with the HTML tokenizer's rules (review F-8).
    treeInertCloses(seen, marks);
    markInertCloses(seen, marks);
  }
  if (seen === text) return marks;
  // A tag ends just after its `>`, which is always a character of the note; one the text cuts off runs to the end.
  for (const m of marks) {
    m.index = at[m.index];
    m.end = seen[m.end - 1] === ">" ? at[m.end - 1] + 1 : text.length;
  }
  return marks;
}

function candidateMarks(text: string): RedactMark[] {
  const out: RedactMark[] = [];
  for (let i = text.indexOf("<"); i >= 0; i = text.indexOf("<", i + 1)) {
    const close = text[i + 1] === "/";
    const nameAt = i + (close ? 2 : 1);
    if (text.slice(nameAt, nameAt + 6).replace(/[A-Z]/g, (c) => c.toLowerCase()) !== "redact") continue;
    const after = text[nameAt + 6];
    if (after !== undefined && !isSpace(after) && after !== "/" && after !== ">") continue;
    // The tag's attributes, as the tokenizer reads them, up to the `>` that ends it.
    let j = nameAt + 6;
    let quote: string | null = null;
    let valueStart = false;
    let end = text.length;
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === ">") {
        end = j + 1;
        break;
      }
      if (valueStart && (c === '"' || c === "'")) quote = c;
      if (c === "=") valueStart = true;
      else if (!isSpace(c)) valueStart = false;
    }
    out.push({ index: i, end, close });
    i = end - 1;
  }
  return out;
}

/* ─── Which closing marks close, as the preview reads them (review F-8) ─── */

/** HTML's "special" elements: `</redact>` does not close through one (the tree builder ignores it). */
const SPECIAL = new Set(
  "address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dialog dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp".split(" "),
);
const VOID = new Set("area base basefont bgsound br col embed frame hr image img input keygen link meta param source track wbr".split(" "));
/** Elements whose text is not markup: up to their own end tag. */
const RAW_TEXT = new Set(["style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);
/** Inside a passage, these make the rest uncertain (script escapes, foreign content, noscript, plaintext): no close counts after them. */
const UNCERTAIN = new Set(["script", "svg", "math", "noscript", "plaintext"]);

/**
 * Characters the Markdown layer shows as text, not HTML: fenced and
 * indented code, inline code and math, link targets and titles, wiki links,
 * reference definitions. Where unsure, a character counts as text: a closing
 * mark there then ends nothing, so the export removes more, never less.
 */
function markdownTextMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  const fill = (a: number, b: number) => mask.fill(1, a, b);
  let at = 0;
  let fence: { ch: string; len: number } | null = null;
  let inMath = false;
  for (const line of text.split("\n")) {
    const end = at + line.length;
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence || inMath) {
      fill(at, end);
      if (fence && f && f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === "") fence = null;
      if (inMath && /^\s*\$\$\s*$/.test(line)) inMath = false;
    } else if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = { ch: f[1][0], len: f[1].length };
      fill(at, end);
    } else if (/^\s*\$\$\s*$/.test(line)) {
      inMath = true;
      fill(at, end);
    } else if (/^( {4}|\t)/.test(line) || /^ {0,3}\[[^\]]+\]:/.test(line)) {
      fill(at, end);
    }
    at = end + 1;
  }
  // Inline spans, within a paragraph (not across a blank line).
  const spans = [/(`+)[\s\S]*?[^`]\1(?!`)/g, /\$\$[\s\S]*?\$\$/g, /\$[^$\n]+\$/g, /\]\((?:[^()]|\([^()]*\))*\)/g, /\[\[[\s\S]*?\]\]/g];
  for (const para of text.matchAll(/(?:[^\n]|\n(?![ \t]*\n))+/g)) {
    const base = para.index ?? 0;
    for (const re of spans) for (const m of para[0].matchAll(re)) fill(base + (m.index ?? 0), base + (m.index ?? 0) + m[0].length);
  }
  return mask;
}

/** The end of the tag that starts at `i` (after its `>`), or -1 when the text ends inside it. */
function tagEnd(text: string, from: number): number {
  let quote: string | null = null;
  let valueStart = false;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === ">") return j + 1;
    if (valueStart && (c === '"' || c === "'")) quote = c;
    if (c === "=") valueStart = true;
    else if (!isSpace(c)) valueStart = false;
  }
  return -1;
}

/**
 * Mark the closing marks that close nothing in the preview (`inert`). A
 * second pass over the text with the HTML tokenizer's states that matter
 * (comments, bogus comments, tags and their attributes, raw-text elements)
 * and, inside a passage, the elements opened since its `<redact>`: HTML's
 * tree builder ignores `</redact>` when a "special" element (p, div, li,
 * table, select…) is still open above it. Opening marks are never weakened.
 */
function markInertCloses(text: string, marks: RedactMark[]): void {
  const mask = markdownTextMask(text);
  const n = text.length;
  let k = 0; // the next mark
  let depth = 0;
  let uncertain = false;
  const stack: string[] = [];
  // "redact" is a mark the preview reads as an element; "redact~" one written as text (in code, a
  // comment, another tag…), which the export still removes from (fail closed).
  const open = (asText = false) => {
    depth++;
    stack.push(asText ? "redact~" : "redact");
  };
  const innermost = () => Math.max(stack.lastIndexOf("redact"), stack.lastIndexOf("redact~"));
  /**
   * Marks before `to` that are not markup here. An opening mark still opens. A closing one
   * closes only a mark that was also written as text: it can't end a passage the preview shades.
   */
  const asText = (to: number) => {
    for (; k < marks.length && marks[k].index < to; k++) {
      if (!marks[k].close) open(true);
      else if (depth > 0) {
        const r = innermost();
        if (stack[r] === "redact~") close(marks[k]);
        else marks[k].inert = true;
      }
    }
  };
  function close(m: RedactMark): void {
    if (depth === 0) return; // a stray closing mark: dropped, as before
    const r = innermost();
    if (uncertain || r < 0 || stack.slice(r + 1).some((e) => SPECIAL.has(e))) {
      m.inert = true;
      return;
    }
    stack.length = r;
    depth--;
    if (depth === 0) {
      stack.length = 0;
      uncertain = false;
    }
  }
  let i = 0;
  while (k < marks.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    asText(lt);
    i = lt;
    let bs = 0;
    while (bs < i && text[i - 1 - bs] === "\\") bs++;
    // Text in the Markdown layer (code, math, a link's target, `\<`): no tag here, but in an HTML
    // block the same `<` starts one, so what that tag or comment would swallow is text too.
    const literal = mask[i] === 1 || bs % 2 === 1;
    if (text.startsWith("<!--", i)) {
      // A comment: `<!-->` and `<!--->` end at once, otherwise at `-->` or `--!>`, or the end.
      const rest = text.slice(i + 4);
      const e = rest.startsWith(">") ? 1 : rest.startsWith("->") ? 2 : (() => {
        const a = rest.indexOf("-->");
        const b = rest.indexOf("--!>");
        const x = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        return x < 0 ? rest.length : x + (x === b ? 4 : 3);
      })();
      asText(i + 4 + e);
      i += 4 + e;
      continue;
    }
    const c1 = text[i + 1] ?? "";
    const isClose = c1 === "/";
    const c2 = isClose ? (text[i + 2] ?? "") : c1;
    if (c1 === "!" || c1 === "?" || (isClose && !/[A-Za-z]/.test(c2))) {
      // A bogus comment (`<!…>`, `<?…>`, `</ …>`) up to the next `>`; CDATA in a passage is foreign content: unsure.
      if (isClose && c2 === ">") {
        i += 3;
        continue;
      }
      if (depth > 0 && text.startsWith("<![CDATA[", i)) uncertain = true;
      const gt = text.indexOf(">", i);
      const e = gt < 0 ? n : gt + 1;
      asText(e);
      i = e;
      continue;
    }
    if (!/[A-Za-z]/.test(c2)) {
      i++;
      continue;
    }
    const nameAt = i + (isClose ? 2 : 1);
    let ne = nameAt;
    while (ne < n && !isSpace(text[ne]) && text[ne] !== "/" && text[ne] !== ">") ne++;
    const name = text.slice(nameAt, ne).toLowerCase();
    const end = tagEnd(text, ne);
    const m = !literal && marks[k]?.index === i ? marks[k] : null;
    if (m) k++;
    if (end < 0) {
      // The text ends inside this tag: HTML drops it.
      if (depth > 0) uncertain = true;
      if (m && !m.close) open();
      asText(n);
      break;
    }
    asText(end); // marks inside this tag's attributes are text
    if (literal) {
      if (!isClose && (RAW_TEXT.has(name) || name === "script")) {
        const re = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "ig");
        re.lastIndex = end;
        const hit = re.exec(text);
        asText(hit ? hit.index : n);
        i = hit ? hit.index : n;
      } else i = end;
      continue;
    }
    if (name === "redact") {
      if (!isClose) open();
      else if (m) close(m);
    } else if (!isClose) {
      if (depth > 0) {
        if (UNCERTAIN.has(name)) uncertain = true;
        else if (!VOID.has(name)) stack.push(name);
      }
      if (RAW_TEXT.has(name) || name === "script") {
        // Up to this element's own end tag: everything before it is text.
        const re = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "ig");
        re.lastIndex = end;
        const hit = re.exec(text);
        asText(hit ? hit.index : n);
        i = hit ? hit.index : n;
        continue;
      }
      if (name === "plaintext") {
        asText(n);
        break;
      }
    } else if (depth > 0 && stack[stack.length - 1] === name) {
      stack.pop();
    }
    i = end;
  }
  asText(n + 1);
}

/**
 * Wrap `text` in redaction marks (the editor's "Redact selection"). Marks
 * already in the selection merge into the new one, which covers all of it;
 * the closing and opening marks after it keep every passage before and after
 * the selection covered as it was (review F-9).
 */
export function wrapRedaction(text: string): string {
  let inner = "";
  let last = 0;
  // The selection's own marks, reduced: closes of marks opened before it, then opens of marks that run past it.
  let closes = 0;
  let opens = 0;
  for (const m of redactMarks(text)) {
    if (m.inert) continue; // text, not a mark: it stays in the selection as written
    inner += text.slice(last, m.index);
    last = m.end;
    if (!m.close) opens++;
    else if (opens > 0) opens--;
    else closes++;
  }
  inner += text.slice(last);
  return REDACT_OPEN + inner + REDACT_CLOSE.repeat(1 + closes) + REDACT_OPEN.repeat(opens);
}

/** Does the note have any redaction mark? */
export function hasRedactions(markdown: string): boolean {
  return redactMarks(markdown).length > 0;
}

/**
 * The pieces of the note an export keeps, in order (`[from, to)`), with `null` where a passage went. When
 * a passage is still open at the end, every footnote definition goes too: the preview appends the
 * footnotes after the last block, inside that passage (review 8, RR8-473-2).
 */
function keptPieces(markdown: string): { pieces: Array<[number, number] | null>; count: number; footnotes: Array<[number, number]> } {
  const pieces: Array<[number, number] | null> = [];
  let depth = 0;
  let last = 0;
  let count = 0;
  for (const m of redactMarks(markdown)) {
    // Inside the passage: removed with it. (One with no passage open is a stray mark, below.)
    if (m.inert && !(m.close && depth === 0)) continue;
    if (!m.close) {
      if (depth === 0) {
        pieces.push([last, m.index]);
        count++;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) pieces.push(null);
    } else {
      // A stray closing mark: drop the mark, keep the text before it.
      pieces.push([last, m.index]);
    }
    last = m.end;
  }
  if (depth === 0) {
    pieces.push([last, markdown.length]);
    return { pieces, count, footnotes: [] };
  }
  pieces.push(null);
  const footnotes = footnoteRanges(markdown);
  const out: Array<[number, number] | null> = [];
  for (const p of pieces) {
    if (!p) {
      out.push(p);
      continue;
    }
    let [a] = p;
    const b = p[1];
    for (const [fa, fb] of footnotes) {
      if (fb <= a || fa >= b) continue;
      if (fa > a) out.push([a, fa]);
      a = Math.max(a, fb);
    }
    if (a < b) out.push([a, b]);
  }
  return { pieces: out, count, footnotes };
}

/**
 * The note's footnote definitions as the preview reads them (after its CriticMarkup swap), in the note's
 * offsets. When micromark can't read the note, every line from a `[^…]:` up to the next blank line counts
 * as one (fail closed).
 */
function footnoteRanges(markdown: string): Array<[number, number]> {
  const { text: seen, at } = prepareCriticMarkupMapped(markdown);
  const found = footnoteDefinitionRanges(seen);
  if (found) return found.map(([a, b]) => [at[a], b >= seen.length ? markdown.length : at[b]]);
  const out: Array<[number, number]> = [];
  let from = -1;
  let pos = 0;
  for (const line of markdown.split("\n")) {
    if (from < 0 && /\[\^[^\]]*\]:/.test(line)) from = pos;
    else if (from >= 0 && line.trim() === "") {
      out.push([from, pos]);
      from = -1;
    }
    pos += line.length + 1;
  }
  if (from >= 0) out.push([from, markdown.length]);
  return out;
}

/** The marked passages, as written (for the author's own review before an export). */
export function redactedPassages(markdown: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (const m of redactMarks(markdown)) {
    if (m.inert) continue;
    if (!m.close) {
      if (depth === 0) start = m.end;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) out.push(markdown.slice(start, m.index));
    }
  }
  if (depth > 0) {
    out.push(markdown.slice(start));
    // The footnotes the export removes with it (RR8-473-2): those written before that passage.
    for (const [a, b] of footnoteRanges(markdown)) if (a < start) out.push(markdown.slice(a, b));
  }
  return out;
}

/** Remove every marked passage; returns the text and how many passages went. */
export function removeRedacted(markdown: string): { text: string; count: number } {
  const { pieces, count } = keptPieces(markdown);
  let text = "";
  for (const p of pieces) text += p ? markdown.slice(p[0], p[1]) : REDACTED;
  return { text, count };
}

/** Code fence opener/closer (``` or ~~~, up to three spaces in). */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Remove HTML and Obsidian comments outside code. An HTML comment that is
 * never closed runs to the end of the note (fail closed); `%%` needs a pair.
 */
export function removeHiddenComments(markdown: string): string {
  const lines = markdown.split("\n");
  // Mark which characters are code (fenced blocks and inline code spans).
  let open: { ch: string; len: number } | null = null;
  const segments: { text: string; code: boolean }[] = [];
  const push = (text: string, code: boolean) => {
    const prev = segments[segments.length - 1];
    if (prev && prev.code === code) prev.text += text;
    else segments.push({ text, code });
  };
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? "\n" : "";
    const m = FENCE.exec(line);
    if (open) {
      if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === "") open = null;
      push(line + nl, true);
      return;
    }
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { ch: m[1][0], len: m[1].length };
      push(line + nl, true);
      return;
    }
    // Inline code spans: a run of N backticks closed by the same run.
    let at = 0;
    const span = /(`+)([\s\S]*?[^`])\1(?!`)/g;
    for (let s = span.exec(line); s; s = span.exec(line)) {
      push(line.slice(at, s.index), false);
      push(s[0], true);
      at = s.index + s[0].length;
    }
    push(line.slice(at) + nl, false);
  });

  let out = "";
  let inHtml = false;
  let inObsidian = false;
  for (const seg of segments) {
    if (seg.code) {
      if (!inHtml && !inObsidian) out += seg.text;
      continue;
    }
    let s = seg.text;
    while (s.length) {
      if (inHtml) {
        const end = s.indexOf("-->");
        if (end < 0) {
          s = "";
          break;
        }
        s = s.slice(end + 3);
        inHtml = false;
        continue;
      }
      if (inObsidian) {
        const end = s.indexOf("%%");
        if (end < 0) {
          s = "";
          break;
        }
        s = s.slice(end + 2);
        inObsidian = false;
        continue;
      }
      const h = s.indexOf("<!--");
      const o = s.indexOf("%%");
      if (h < 0 && o < 0) {
        out += s;
        break;
      }
      if (h >= 0 && (o < 0 || h < o)) {
        out += s.slice(0, h);
        s = s.slice(h + 4);
        inHtml = true;
      } else {
        out += s.slice(0, o);
        s = s.slice(o + 2);
        inObsidian = true;
      }
    }
  }
  // An Obsidian comment that never closed was not a comment: put it back.
  if (inObsidian) return removeHiddenCommentsKeepingUnclosedPercent(markdown);
  return out;
}

/** Second pass for a note with an odd `%%`: the last one is literal text. */
function removeHiddenCommentsKeepingUnclosedPercent(markdown: string): string {
  const last = markdown.lastIndexOf("%%");
  const sentinel = "\u0000LUMEN-PCT\u0000";
  const swapped = markdown.slice(0, last) + sentinel + markdown.slice(last + 2);
  return removeHiddenComments(swapped).split(sentinel).join("%%");
}

/**
 * Photos inlined in the note as data: URLs, without their metadata, judged by
 * their bytes whatever their label (review 4): see `cleanDataUrls`. One that
 * can't be cleaned is withheld: replaced by WITHHELD_IMAGE.
 */
export function cleanInlineImages(markdown: string): { text: string; cleaned: number; withheld: number } {
  return cleanDataUrls(markdown);
}

/** The async form: a photo that can't be stripped in place is re-encoded through a canvas first, withheld only when that fails. */
export async function cleanInlineImagesAsync(markdown: string): Promise<{ text: string; cleaned: number; withheld: number }> {
  return cleanDataUrlsAsync(markdown);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** `![alt](lumen-asset-…)` and `![[lumen-asset-…]]`: photos stored in the vault. */
const ASSET_IMAGE = /!\[([^\]\n]*)\]\(\s*<?(?:\.\/)?(lumen-asset-[^\s)>]+\.(?:jpe?g|png|webp))>?(?:\s+"[^"\n]*")?\s*\)|!\[\[\s*(?:\.\/)?(lumen-asset-[^\]|#\n]+\.(?:jpe?g|png|webp))\s*(?:\|[^\]\n]*)?\]\]/gi;

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Photos stored in the vault, inlined as clean data: URLs, so an exported
 * PDF or HTML file never carries the original's metadata (Chromium writes a
 * JPEG into a PDF as it is, EXIF and all). A photo that can't be read is left
 * as a link.
 */
export async function inlineVaultImages(markdown: string, read: (name: string) => Promise<Blob>): Promise<{ text: string; inlined: number; withheld: number }> {
  const found = [...markdown.matchAll(ASSET_IMAGE)];
  if (!found.length) return { text: markdown, inlined: 0, withheld: 0 };
  const urls = new Map<string, string | null>();
  let withheld = 0;
  for (const m of found) {
    const name = m[2] ?? m[3];
    if (urls.has(name)) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await (await read(name)).arrayBuffer());
    } catch {
      urls.set(name, null); // why: not in the vault: left as a link, nothing to leak
      continue;
    }
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const r = await cleanImageBytes(bytes, MIME[ext]);
    if (!r) {
      // Fail closed: the renderer would otherwise load the original file into the PDF.
      withheld++;
      urls.set(name, WITHHELD_IMAGE);
    } else urls.set(name, `data:${r.type};base64,${toBase64(r.bytes)}`);
  }
  let inlined = 0;
  const text = markdown.replace(ASSET_IMAGE, (whole, alt: string | undefined, a: string | undefined, b: string | undefined) => {
    const url = urls.get((a ?? b) as string);
    if (!url) return whole;
    inlined++;
    return `![${alt ?? ""}](${url})`;
  });
  return { text, inlined, withheld };
}

export interface ExportPrepOptions {
  /** Read a vault photo, to inline it clean (PDF and HTML exports). */
  readAsset?: (name: string) => Promise<Blob>;
  /** Keep photos' metadata (Settings). Defaults to the user's choice. */
  keepImageMetadata?: boolean;
}

export interface ExportPrepReport {
  /** Marked passages removed. */
  redacted: number;
  /** Inline photos that lost metadata. */
  imagesCleaned: number;
  /** Photos replaced by an empty image: their metadata could not be removed. */
  imagesWithheld: number;
}

/**
 * The same for a synchronous exporter (`lumen convert`, the API server):
 * marked passages and hidden comments removed, inline photos cleaned in
 * place or withheld (no canvas to re-encode with there).
 */
export function prepareForExportSync(markdown: string, opts: Pick<ExportPrepOptions, "keepImageMetadata"> = {}): string {
  const text = removeHiddenComments(removeRedacted(markdown).text);
  return (opts.keepImageMetadata ?? keepImageMetadata()) ? text : cleanInlineImages(text).text;
}

/**
 * The text an exporter gets: marked passages and hidden comments removed,
 * photos without metadata. Every export path calls this; the note itself is
 * never changed.
 */
export async function prepareForExport(markdown: string, opts: ExportPrepOptions = {}): Promise<{ text: string; report: ExportPrepReport }> {
  const { text: removed, count } = removeRedacted(markdown);
  let text = removeHiddenComments(removed);
  let imagesCleaned = 0;
  let imagesWithheld = 0;
  const keep = opts.keepImageMetadata ?? keepImageMetadata();
  if (!keep) {
    if (opts.readAsset) {
      const r = await inlineVaultImages(text, opts.readAsset);
      text = r.text;
      imagesCleaned += r.inlined - r.withheld;
      imagesWithheld += r.withheld;
    }
    const c = await cleanInlineImagesAsync(text);
    text = c.text;
    imagesCleaned += c.cleaned;
    imagesWithheld += c.withheld;
  }
  return { text, report: { redacted: count, imagesCleaned, imagesWithheld } };
}
