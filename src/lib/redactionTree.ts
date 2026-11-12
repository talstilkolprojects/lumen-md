/**
 * Which closing redaction marks close a passage, decided on the Markdown
 * tree the preview builds (review 6, RR6-473-1).
 *
 * The preview runs Markdown first and HTML second: remark-parse (micromark,
 * with the GFM, math and directive extensions) builds the blocks, then
 * remark-rehype and rehype-raw hand parse5 the Markdown-made elements (p, li,
 * blockquote, td, h1…) as tags, in order, around the note's raw HTML. HTML's
 * tree builder ignores a `</redact>` while a "special" element is open above
 * the `redact` element, so a close typed inside a list item, a block quote or
 * a table cell after a `<redact>` on its own line ends nothing in the
 * preview: the shading goes on. This pass walks micromark's own events (the
 * tokens remark-parse turns into the tree), feeds the HTML rules the same
 * stream of elements, and marks such a close `inert`.
 *
 * Everything here fails closed. A close is inert unless this pass is sure the
 * preview reads it as closing: when the note's raw HTML leaves the tokenizer
 * inside a comment, a tag or a raw-text element at the end of an HTML node,
 * every later close is inert; when the parser throws, every close is. The
 * caller keeps every close the text pass (`markInertCloses`) marked inert as
 * well, so the union removes more than either pass alone, never less.
 *
 * Not modelled, and why that is safe: the preview's frontmatter is blanked
 * (it is never rendered); GFM strikethrough, task lists and autolink literals
 * make no special element; CriticMarkup only swaps its delimiters for
 * single characters before parsing and wraps text in ins/del/mark after
 * rehype-raw. Footnote definitions are moved to the end of the preview; they
 * count as an open list item where they are written, so a close inside one is
 * inert.
 */

import { parse, postprocess, preprocess } from "micromark";
import { directive } from "micromark-extension-directive";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmTable } from "micromark-extension-gfm-table";
import { math } from "micromark-extension-math";
import type { Event } from "micromark-util-types";

/** The parts of a mark this pass reads and writes (`RedactMark` in redaction.ts). */
export interface TreeMark {
  index: number;
  end: number;
  close: boolean;
  inert?: boolean;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

/** HTML's "special" elements: `</redact>` does not close through one. */
const SPECIAL = new Set(
  "address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dialog dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp".split(" "),
);
const VOID = new Set("area base basefont bgsound br col embed frame hr image img input keygen link meta param source track wbr".split(" "));
const RAW_TEXT = new Set(["style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "script"]);
const UNCERTAIN = new Set(["svg", "math", "noscript", "plaintext"]);

/** Markdown blocks and the element remark-rehype makes of each (all of them special). */
const BLOCK: Record<string, string> = {
  paragraph: "p",
  atxHeading: "h1",
  setextHeading: "h1",
  blockQuote: "blockquote",
  table: "table",
  tableHead: "thead",
  tableBody: "tbody",
  tableRow: "tr",
  tableHeader: "th",
  tableData: "td",
  gfmFootnoteDefinition: "li",
  directiveContainer: "div",
  directiveLeaf: "div",
  directiveText: "div",
};

/** remark-frontmatter's YAML block: never rendered, so it is text here. */
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?=\r?\n|$)/;

/** One HTML node's text as parse5 gets it, with each character's place in the note. */
interface Raw {
  v: string;
  at: number[];
  start: number;
  end: number;
}

type RawToken =
  | { kind: "tag"; start: number; end: number; name: string; close: boolean }
  | { kind: "text"; end: number }
  | { kind: "cdata"; end: number };

/** The end of a tag's attributes (after its `>`), or -1 when the text ends inside it. */
function tagEnd(v: string, from: number): number {
  let quote: string | null = null;
  let valueStart = false;
  for (let j = from; j < v.length; j++) {
    const c = v[j];
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
 * The HTML tokenizer over one HTML node: tags, and the stretches it reads as
 * text (comments, bogus comments, raw-text elements). `clean` is false when
 * the node ends inside one of them, or inside a tag.
 */
function rawTokens(v: string): { tokens: RawToken[]; clean: boolean } {
  const tokens: RawToken[] = [];
  let i = 0;
  const n = v.length;
  while (i < n) {
    const lt = v.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    if (v.startsWith("<!--", i)) {
      const rest = v.slice(i + 4);
      if (rest.startsWith(">")) i += 5;
      else if (rest.startsWith("->")) i += 6;
      else {
        const a = rest.indexOf("-->");
        const b = rest.indexOf("--!>");
        const x = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        if (x < 0) {
          tokens.push({ kind: "text", end: n });
          return { tokens, clean: false };
        }
        i += 4 + x + (x === b ? 4 : 3);
      }
      tokens.push({ kind: "text", end: i });
      continue;
    }
    const c1 = v[i + 1] ?? "";
    const isClose = c1 === "/";
    const c2 = isClose ? (v[i + 2] ?? "") : c1;
    if (c1 === "!" || c1 === "?" || (isClose && !/[A-Za-z]/.test(c2))) {
      if (isClose && c2 === ">") {
        i += 3;
        continue;
      }
      const gt = v.indexOf(">", i);
      if (v.startsWith("<![CDATA[", i)) tokens.push({ kind: "cdata", end: gt < 0 ? n : gt + 1 });
      else tokens.push({ kind: "text", end: gt < 0 ? n : gt + 1 });
      if (gt < 0) return { tokens, clean: false };
      i = gt + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(c2)) {
      i++;
      continue;
    }
    const nameAt = i + (isClose ? 2 : 1);
    let ne = nameAt;
    while (ne < n && !isSpace(v[ne]) && v[ne] !== "/" && v[ne] !== ">") ne++;
    const name = v.slice(nameAt, ne).toLowerCase();
    const end = tagEnd(v, ne);
    if (end < 0) {
      tokens.push({ kind: "tag", start: i, end: n, name, close: isClose });
      return { tokens, clean: false };
    }
    tokens.push({ kind: "tag", start: i, end, name, close: isClose });
    i = end;
    if (!isClose && (RAW_TEXT.has(name) || name === "plaintext")) {
      const re = name === "plaintext" ? null : new RegExp(`</${name}[\\t\\n\\f\\r />]`, "ig");
      if (re) re.lastIndex = end;
      const hit = re ? re.exec(v) : null;
      tokens.push({ kind: "text", end: hit ? hit.index : n });
      if (!hit) return { tokens, clean: false };
      i = hit.index;
    }
  }
  return { tokens, clean: true };
}

/** The note's micromark events, as remark-parse reads them (GFM tables and footnotes, math, directives). */
function events(text: string): Event[] {
  const fm = FRONTMATTER.exec(text);
  const src = fm ? text.slice(0, fm[0].length).replace(/[^\r\n]/g, " ") + text.slice(fm[0].length) : text;
  const ext = [gfmTable(), gfmFootnote(), math(), directive()];
  return postprocess(parse({ extensions: ext }).document().write(preprocess()(src, undefined, true)));
}

/** The HTML nodes' text, from their data and line-ending tokens (the container prefixes between them are not HTML). */
function rawOf(text: string, evs: Event[], from: number, type: string): { raw: Raw; next: number } {
  const open = evs[from][1];
  let v = "";
  const at: number[] = [];
  let j = from + 1;
  for (; j < evs.length; j++) {
    const [kind, t] = evs[j];
    if (kind === "exit" && t === open) break;
    if (kind !== "enter") continue;
    if (t.type === type + "Data") {
      for (let o = t.start.offset; o < t.end.offset; o++) at.push(o);
      v += text.slice(t.start.offset, t.end.offset);
    } else if (t.type === "lineEnding") {
      at.push(t.start.offset);
      v += "\n";
    }
  }
  at.push(open.end.offset);
  return { raw: { v, at, start: open.start.offset, end: open.end.offset }, next: j };
}

/** Every HTML node of the note, in order, except text inside an image's label (an `alt`, not markup). */
function rawNodes(text: string, evs: Event[]): Raw[] {
  const out: Raw[] = [];
  let inImage = 0;
  for (let i = 0; i < evs.length; i++) {
    const [kind, t] = evs[i];
    if (t.type === "image") inImage += kind === "enter" ? 1 : -1;
    else if (kind === "enter" && inImage === 0 && (t.type === "htmlFlow" || t.type === "htmlText")) {
      const { raw, next } = rawOf(text, evs, i, t.type);
      out.push(raw);
      i = next;
    }
  }
  return out;
}

/**
 * Mark the closes the preview's tree does not close with (`inert`). Opening
 * marks are never weakened. A `<redact>` that the preview reads as a tag but
 * the mark parser saw inside another mark's tag (a quoted attribute running
 * over a blank line) makes that mark an opening one, so the export removes
 * from there.
 */
export function treeInertCloses(text: string, marks: TreeMark[]): void {
  let evs: Event[];
  let raws: Raw[];
  try {
    evs = events(text);
    raws = rawNodes(text, evs);
  } catch {
    for (const m of marks) if (m.close) m.inert = true;
    return;
  }
  const byIndex = new Map<number, TreeMark>();
  for (const m of marks) byIndex.set(m.index, m);
  const tokensOf = raws.map((r) => rawTokens(r.v));
  // A tag the preview reads that no mark starts at: it sits inside another mark's tag.
  raws.forEach((r, x) => {
    for (const tk of tokensOf[x].tokens) {
      if (tk.kind !== "tag" || tk.name !== "redact" || tk.close) continue;
      const s = r.at[tk.start];
      if (byIndex.has(s)) continue;
      const host = [...marks].reverse().find((m) => m.index < s);
      if (host && s < host.end && host.close) host.close = false;
    }
  });

  let k = 0;
  let depth = 0;
  let uncertain = false;
  let poisoned = false;
  const stack: string[] = [];
  const open = (asText = false) => {
    depth++;
    stack.push(asText ? "redact~" : "redact");
  };
  const innermost = () => Math.max(stack.lastIndexOf("redact"), stack.lastIndexOf("redact~"));
  const close = (m: TreeMark) => {
    if (depth === 0) return;
    const r = innermost();
    if (poisoned || uncertain || r < 0 || stack.slice(r + 1).some((e) => SPECIAL.has(e))) {
      m.inert = true;
      return;
    }
    stack.length = r;
    depth--;
    if (depth === 0) {
      stack.length = 0;
      uncertain = false;
    }
  };
  /** Marks before `to` that are text here: an opening one opens, a closing one closes only a mark that is text too. */
  const asText = (to: number) => {
    for (; k < marks.length && marks[k].index < to; k++) {
      const m = marks[k];
      if (!m.close) open(true);
      else if (depth > 0) {
        if (stack[innermost()] === "redact~") close(m);
        else m.inert = true;
      }
    }
  };
  const push = (name: string) => {
    if (depth > 0) stack.push(name);
  };
  const pop = (name: string) => {
    if (depth > 0 && stack[stack.length - 1] === name) stack.pop();
  };

  let rx = 0;
  let inImage = 0;
  const lists: boolean[] = [];
  for (let i = 0; i < evs.length; i++) {
    const [kind, t] = evs[i];
    const at = kind === "enter" ? t.start.offset : t.end.offset;
    if (t.type === "image") {
      inImage += kind === "enter" ? 1 : -1;
      continue;
    }
    if (kind === "enter" && inImage === 0 && (t.type === "htmlFlow" || t.type === "htmlText")) {
      const r = raws[rx];
      const { tokens, clean } = tokensOf[rx];
      rx++;
      asText(r.start);
      for (const tk of tokens) {
        if (tk.kind === "text") {
          asText(r.at[tk.end]);
          continue;
        }
        if (tk.kind === "cdata") {
          if (depth > 0) uncertain = true;
          asText(r.at[tk.end]);
          continue;
        }
        const s = r.at[tk.start];
        asText(s);
        const m = marks[k]?.index === s ? marks[k] : undefined;
        if (m) k++;
        if (tk.name === "redact") {
          if (!tk.close) open();
          else if (m) {
            if (m.close) close(m);
            else open(); // a mark made an opening one above
          }
        } else if (!tk.close) {
          if (depth > 0) {
            if (UNCERTAIN.has(tk.name)) uncertain = true;
            else if (!VOID.has(tk.name)) stack.push(tk.name);
          }
        } else pop(tk.name);
        asText(r.at[Math.min(tk.end, r.v.length)]); // marks inside this tag's attributes are text
      }
      // parse5 may carry a comment, a tag or a raw-text element over into what follows: nothing after is sure.
      if (!clean) poisoned = true;
      asText(r.end);
      // Skip to this node's exit.
      while (i + 1 < evs.length && !(evs[i + 1][0] === "exit" && evs[i + 1][1] === t)) i++;
      i++;
      continue;
    }
    if (t.type === "listOrdered" || t.type === "listUnordered") {
      asText(at);
      const name = t.type === "listOrdered" ? "ol" : "ul";
      if (kind === "enter") {
        push(name);
        lists.push(false);
      } else {
        if (lists.pop()) pop("li");
        pop(name);
      }
      continue;
    }
    if (t.type === "listItemPrefix" && kind === "enter") {
      asText(at);
      if (lists.length && lists[lists.length - 1]) pop("li");
      push("li");
      if (lists.length) lists[lists.length - 1] = true;
      continue;
    }
    const block = BLOCK[t.type];
    if (block) {
      asText(at);
      if (kind === "enter") push(block);
      else pop(block);
    }
  }
  asText(Number.POSITIVE_INFINITY);
}
