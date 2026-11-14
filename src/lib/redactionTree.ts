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
 * The text it reads is the one the preview parses: the caller swaps the
 * CriticMarkup delimiters first, as pipeline.ts does (`prepareCriticMarkup`),
 * because a `>` of `{>>` or `~>` ends a tag in the note as written but not in
 * the preview (review 8, RR8-473-1). Footnote definitions are read where the
 * preview puts them (review 8, RR8-473-2): after the last block, in the
 * footnotes section (special elements), in the order of their first
 * reference; there, a close with no passage open in that order ends nothing.
 *
 * Not modelled, and why that is safe: the preview's frontmatter is blanked
 * (it is never rendered); GFM strikethrough, task lists and autolink literals
 * make no special element; CriticMarkup wraps text in ins/del/mark after
 * rehype-raw, which are not special.
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
  /**
   * The opening tag the preview reads, inside another mark's tag, that this
   * mark stands for (W8.8-F1, -F2): the passes open it there, as a tag, not
   * where the mark starts.
   */
  at?: number;
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
  const added: TreeMark[] = [];
  // A tag the preview reads that no mark starts at: it sits inside another mark's tag.
  raws.forEach((r, x) => {
    for (const tk of tokensOf[x].tokens) {
      if (tk.kind !== "tag" || tk.name !== "redact" || tk.close) continue;
      const s = r.at[tk.start];
      if (byIndex.has(s)) continue;
      const host = [...marks].reverse().find((m) => m.index < s && m.at === undefined);
      if (!host || s >= host.end) continue;
      if (host.close && host.at === undefined) {
        // The mark is a close to the export: make it this opening one.
        host.close = false;
        host.at = s;
      } else {
        // The mark already opens (or stands for another tag): the preview opens once more here (W8.8-F1). The
        // export removes from the host on, so the extra open only keeps the passage open longer.
        added.push({ index: s, end: host.end, close: false, at: s });
      }
    }
  });
  if (added.length) {
    marks.push(...added);
    marks.sort((a, b) => a.index - b.index);
    for (const m of added) byIndex.set(m.index, m);
  }

  // The preview's order: the note without its footnote definitions, then the footnotes section after the
  // last block (review 8, RR8-473-2), the definitions in the order they are first referenced, as
  // mdast-util-to-hast builds it. Each part gets its own marks, in their order in the note.
  const parts = previewOrder(text, evs);
  const rawOfToken = new Map<unknown, number>();
  {
    let rx = 0;
    let img = 0;
    for (const [kind, t] of evs) {
      if (t.type === "image") img += kind === "enter" ? 1 : -1;
      else if (kind === "enter" && img === 0 && (t.type === "htmlFlow" || t.type === "htmlText") && !rawOfToken.has(t)) rawOfToken.set(t, rx++);
    }
  }
  const inPart = (m: TreeMark, p: Part) => p.ranges.some(([a, b]) => m.index >= a && m.index < b);

  let seg: TreeMark[] = [];
  let k = 0;
  let depth = 0;
  let uncertain = false;
  let poisoned = false;
  /** In the footnotes section, a close with no passage open here may still be inside one in the note's order: it ends nothing. */
  let moved = false;
  const stack: string[] = [];
  const open = (asText = false) => {
    depth++;
    stack.push(asText ? "redact~" : "redact");
  };
  const innermost = () => Math.max(stack.lastIndexOf("redact"), stack.lastIndexOf("redact~"));
  const close = (m: TreeMark) => {
    if (depth === 0) {
      if (moved) m.inert = true;
      return;
    }
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
    for (; k < seg.length && seg[k].index < to; k++) {
      const m = seg[k];
      if (m.at !== undefined && m.at >= to) {
        // It opens at its tag, further on (W8.8-F2): not here as text, and not twice.
        continue;
      }
      if (m.at !== undefined) open();
      else if (!m.close) open(true);
      else if (depth > 0) {
        if (stack[innermost()] === "redact~") close(m);
        else m.inert = true;
      } else if (moved) m.inert = true;
    }
  };
  const push = (name: string) => {
    if (depth > 0) stack.push(name);
  };
  const pop = (name: string) => {
    if (depth > 0 && stack[stack.length - 1] === name) stack.pop();
  };

  for (const part of parts) {
    seg = marks.filter((m) => inPart(m, part));
    k = 0;
    if (part.footnote && !moved) {
      // `<section class="footnotes"><h2>…</h2><ol>`: special elements, around every definition.
      moved = true;
      push("section");
      push("ol");
    }
    let inImage = 0;
    let inHtml: unknown = null;
    const lists: boolean[] = [];
    for (const i of part.events) {
      const [kind, t] = evs[i];
      if (inHtml) {
        // Inside an HTML node, read above from its tokens.
        if (kind === "exit" && t === inHtml) inHtml = null;
        continue;
      }
      const at = kind === "enter" ? t.start.offset : t.end.offset;
      if (t.type === "image") {
        inImage += kind === "enter" ? 1 : -1;
        continue;
      }
      if (kind === "enter" && inImage === 0 && (t.type === "htmlFlow" || t.type === "htmlText")) {
        const rx = rawOfToken.get(t);
        if (rx === undefined) {
          poisoned = true; // not read above: nothing after is sure
          inHtml = t;
          continue;
        }
        const r = raws[rx];
        const { tokens, clean } = tokensOf[rx];
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
          const m = seg[k]?.index === s ? seg[k] : undefined;
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
        inHtml = t;
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
}

/** One part of the note in the preview's order: its events (indexes into `evs`) and the note's ranges they cover. */
interface Part {
  events: number[];
  ranges: Array<[number, number]>;
  footnote: boolean;
}

/** micromark's identifier normalisation (`normalizeIdentifier`): whitespace collapsed, case folded. */
const labelId = (s: string) => s.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();

/**
 * The note in the preview's order (review 8, RR8-473-2). remark-rehype takes every footnote definition
 * out of its place and appends the referenced ones after the last block, in the order of their first
 * reference (references inside a definition count when that definition is reached); a definition no one
 * references is not rendered. Here the unreferenced ones go last, still inside the footnotes section:
 * a close in one ends nothing it did not open.
 */
function previewOrder(text: string, evs: Event[]): Part[] {
  interface Owner extends Part {
    id: string;
    calls: string[];
    /** Where this part's current range starts. */
    from: number;
  }
  const make = (footnote: boolean, from: number): Owner => ({ events: [], ranges: [], footnote, id: "", calls: [], from });
  const main = make(false, 0);
  const defs: Owner[] = [];
  // Each event belongs to the innermost definition around it, or to the note.
  const owners: Owner[] = [main];
  for (let i = 0; i < evs.length; i++) {
    const [kind, t] = evs[i];
    const cur = owners[owners.length - 1];
    if (t.type === "gfmFootnoteDefinition" && kind === "enter") {
      cur.ranges.push([cur.from, t.start.offset]);
      const d = make(true, t.start.offset);
      d.events.push(i);
      defs.push(d);
      owners.push(d);
      continue;
    }
    cur.events.push(i);
    if (t.type === "gfmFootnoteDefinition" && kind === "exit" && cur !== main) {
      cur.ranges.push([cur.from, t.end.offset]);
      owners.pop();
      owners[owners.length - 1].from = t.end.offset;
    } else if (kind === "enter" && t.type === "gfmFootnoteDefinitionLabelString" && cur !== main && !cur.id) {
      cur.id = labelId(text.slice(t.start.offset, t.end.offset));
    } else if (kind === "enter" && t.type === "gfmFootnoteCallString") {
      cur.calls.push(labelId(text.slice(t.start.offset, t.end.offset)));
    }
  }
  // A definition the events leave open (none should) runs to the end, like the note.
  while (owners.length > 1) {
    const d = owners.pop() as Owner;
    d.ranges.push([d.from, Number.POSITIVE_INFINITY]);
  }
  main.ranges.push([main.from, Number.POSITIVE_INFINITY]);
  if (!defs.length) return [main];
  const byId = new Map<string, Owner>();
  for (const d of defs) if (!byId.has(d.id)) byId.set(d.id, d);
  const order: Owner[] = [];
  const queue = [...main.calls];
  for (let q = 0; q < queue.length; q++) {
    const d = byId.get(queue[q]);
    if (!d || order.includes(d)) continue;
    order.push(d);
    queue.push(...d.calls);
  }
  for (const d of defs) if (!order.includes(d)) order.push(d);
  return [main, ...order];
}

/**
 * Where the note's footnote definitions are (the outermost ones), as micromark reads `text`; null when it
 * can't parse it. The export removes them all when a passage is still open at the end (RR8-473-2): the
 * preview has moved them inside it.
 */
export function footnoteDefinitionRanges(text: string): Array<[number, number]> | null {
  let evs: Event[];
  try {
    evs = events(text);
  } catch {
    return null;
  }
  const out: Array<[number, number]> = [];
  let depth = 0;
  for (const [kind, t] of evs) {
    if (t.type !== "gfmFootnoteDefinition") continue;
    if (kind === "enter" && depth++ === 0) out.push([t.start.offset, t.end.offset]);
    else if (kind === "exit") depth--;
  }
  return out;
}
