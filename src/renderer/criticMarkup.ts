/**
 * CriticMarkup in the preview: {++ins++} {--del--} {~~old~>new~~}
 * {>>comment<<} {==highlight==}.
 *
 * Markdown parsing would mangle the markup (GFM strikethrough eats the `~~`
 * of a substitution), so rendering is two-phase:
 *
 *  1. `prepareCriticMarkup` (string → string, before remark) swaps each
 *     delimiter of every suggestion found by the editor's own parser — which
 *     already skips code spans and fenced code — for a private-use sentinel
 *     character. Inline markdown inside a suggestion keeps working.
 *  2. `rehypeCriticMarkup` pairs the sentinels inside each hast parent and
 *     wraps what lies between them in `<ins class="critic-ins">`,
 *     `<del class="critic-del">` or `<mark class="critic-comment|critic-highlight">`.
 *     A sentinel whose partner ended up in a different parent (markup
 *     spanning paragraphs or crossing a link boundary) is turned back into
 *     its literal delimiter.
 *
 * Only `ins`, `del`, `mark` and `class` are produced — all on the HTML
 * sanitizer's allowlist (DOMPurify html profile, see lib/markupSanitizer).
 */
import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import { mayContainCriticMarkup, parseSuggestions } from "../editor/suggesting";

/** Private-use sentinels standing in for each CriticMarkup delimiter. */
export const CRITIC_SENTINELS = {
  insOpen: "",
  insClose: "",
  delOpen: "",
  delClose: "",
  subOpen: "",
  subMid: "",
  subClose: "",
  comOpen: "",
  comClose: "",
  hlOpen: "",
  hlClose: "",
} as const;
const S = CRITIC_SENTINELS;

const LITERAL: Record<string, string> = {
  [S.insOpen]: "{++",
  [S.insClose]: "++}",
  [S.delOpen]: "{--",
  [S.delClose]: "--}",
  [S.subOpen]: "{~~",
  [S.subMid]: "~>",
  [S.subClose]: "~~}",
  [S.comOpen]: "{>>",
  [S.comClose]: "<<}",
  [S.hlOpen]: "{==",
  [S.hlClose]: "==}",
};

/** Each sentinel → the literal delimiter it stands for. */
export const CRITIC_LITERAL: Readonly<Record<string, string>> = LITERAL;

const SENTINEL_RE = /[-]/;
const SENTINEL_SPLIT_RE = /([-])/;

/**
 * Characters the document itself contains in the sentinel range (or the
 * escape char) are escaped as ESC + a letter before sentinels are inserted,
 * and restored after the rehype pass — so a user's own private-use glyphs
 * are never mistaken for generated markers.
 */
const ESC = "\uE00B";
const ESCAPABLE_RE = /[\uE000-\uE00B]/g;
const ESCAPED_RE = /\uE00B([a-l])/g;
const escapeUserSentinels = (s: string) =>
  s.replace(ESCAPABLE_RE, (c) => ESC + String.fromCharCode(97 + c.charCodeAt(0) - 0xe000));
export const unescapeUserSentinels = (s: string) =>
  s.indexOf(ESC) === -1 ? s : s.replace(ESCAPED_RE, (_m, l: string) => String.fromCharCode(0xe000 + l.charCodeAt(0) - 97));

/** Replace CriticMarkup delimiters (outside code) with sentinels. */
export function prepareCriticMarkup(source: string): string {
  return prepare(source, null);
}

/**
 * `prepareCriticMarkup`, with each output character's place in `source`
 * (review 8, RR8-473-1): the redaction passes read the text the preview
 * parses, then map their marks back to the note. `at[i]` is where output
 * character `i` comes from: a copied character's own offset, a sentinel's
 * delimiter's start, both characters of an escaped user glyph that glyph's
 * offset. `at[text.length]` is `source.length`. Never decreasing.
 */
export function prepareCriticMarkupMapped(source: string): { text: string; at: Int32Array } {
  const at: number[] = [];
  const text = prepare(source, at);
  return { text, at: Int32Array.from(at) };
}

function prepare(source: string, at: number[] | null): string {
  const markdown = escapeUserSentinels(source);
  // The escaped text's offsets → the source's (an escaped glyph is two characters).
  let toSource: Int32Array | null = null;
  if (at) {
    toSource = new Int32Array(markdown.length + 1);
    for (let i = 0, j = 0; i <= source.length; i++) {
      toSource[j++] = i;
      const c = source.charCodeAt(i);
      if (c >= 0xe000 && c <= 0xe00b) toSource[j++] = i;
    }
  }
  const suggestions = mayContainCriticMarkup(markdown) ? parseSuggestions(markdown) : [];
  if (suggestions.length === 0) {
    if (at && toSource) for (const o of toSource) at.push(o);
    return markdown;
  }
  let out = "";
  let pos = 0;
  /** `markdown[a, b)` as it is. */
  const copy = (a: number, b: number) => {
    out += markdown.slice(a, b);
    if (at && toSource) for (let o = a; o < b; o++) at.push(toSource[o]);
  };
  /** Generated characters, standing for the delimiter at `o`. */
  const put = (s: string, o: number) => {
    out += s;
    if (at && toSource) for (let x = 0; x < s.length; x++) at.push(toSource[o]);
  };
  for (const s of suggestions) {
    copy(pos, s.from);
    switch (s.kind) {
      case "insert":
        put(S.insOpen, s.from);
        copy(s.contentFrom, s.contentTo);
        put(S.insClose, s.contentTo);
        break;
      case "delete":
        put(S.delOpen, s.from);
        copy(s.contentFrom, s.contentTo);
        put(S.delClose, s.contentTo);
        break;
      case "substitute":
        put(S.subOpen, s.from);
        copy(s.contentFrom, s.contentTo);
        put(S.subMid, s.contentTo);
        copy(s.newFrom!, s.newTo!);
        put(S.subClose, s.newTo!);
        break;
      case "comment":
        put(S.comOpen, s.from);
        copy(s.contentFrom, s.contentTo);
        put(S.comClose, s.contentTo);
        break;
      case "highlight":
        put(S.hlOpen, s.from);
        copy(s.contentFrom, s.contentTo);
        put(S.hlClose, s.contentTo);
        break;
    }
    // An author tag (`{>>@name<<}`) folded into the change still shows as
    // the small comment it is in the source.
    if (s.authorFrom !== undefined) put(S.comOpen + "@" + s.author + S.comClose, s.authorFrom);
    pos = s.to;
  }
  copy(pos, markdown.length);
  if (at && toSource) at.push(toSource[markdown.length]);
  return out;
}

/** Drop CriticMarkup delimiters, keeping every part's text (TOC slugs). */
export function stripCriticDelimiters(markdown: string): string {
  const prepared = prepareCriticMarkup(markdown);
  return prepared === markdown ? markdown : unescapeUserSentinels(prepared.replace(/[\uE000-\uE00A]/g, ""));
}

type Node = ElementContent | RootContent;

const el = (tagName: string, className: string, children: Node[]): Element => ({
  type: "element",
  tagName,
  properties: { className: [className] },
  children: children as ElementContent[],
});

const isSentinel = (n: Node, ch: string) => n.type === "text" && (n as Text).value === ch;

/** Split text nodes so each sentinel is its own text node. */
function splitSentinels(children: Node[]): Node[] {
  const out: Node[] = [];
  for (const c of children) {
    if (c.type === "text" && SENTINEL_RE.test(c.value)) {
      for (const part of c.value.split(SENTINEL_SPLIT_RE)) {
        if (part) out.push({ type: "text", value: part });
      }
    } else out.push(c);
  }
  return out;
}

function indexOfSentinel(nodes: Node[], ch: string, from: number): number {
  for (let i = from; i < nodes.length; i++) if (isSentinel(nodes[i], ch)) return i;
  return -1;
}

const PAIRS: Array<[string, string, (inner: Node[]) => Element]> = [
  [S.insOpen, S.insClose, (c) => el("ins", "critic-ins", c)],
  [S.delOpen, S.delClose, (c) => el("del", "critic-del", c)],
  [S.comOpen, S.comClose, (c) => el("mark", "critic-comment", c)],
  [S.hlOpen, S.hlClose, (c) => el("mark", "critic-highlight", c)],
];

/** Wrap matched sentinel pairs in one children list; un-sentinel the rest. */
function wrapLevel(children: Node[]): Node[] {
  const nodes = splitSentinels(children);
  const out: Node[] = [];
  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.type !== "text" || !SENTINEL_RE.test(n.value) || n.value.length !== 1) {
      out.push(n);
      i++;
      continue;
    }
    const ch = n.value;
    if (ch === S.subOpen) {
      const mid = indexOfSentinel(nodes, S.subMid, i + 1);
      const close = mid === -1 ? -1 : indexOfSentinel(nodes, S.subClose, mid + 1);
      if (close !== -1) {
        out.push(el("del", "critic-del critic-sub-old", nodes.slice(i + 1, mid)));
        out.push(el("ins", "critic-ins critic-sub-new", nodes.slice(mid + 1, close)));
        i = close + 1;
        continue;
      }
    }
    const pair = PAIRS.find(([open]) => open === ch);
    if (pair) {
      const close = indexOfSentinel(nodes, pair[1], i + 1);
      if (close !== -1) {
        out.push(pair[2](nodes.slice(i + 1, close)));
        i = close + 1;
        continue;
      }
    }
    // Unmatched: show the original delimiter.
    out.push({ type: "text", value: LITERAL[ch] ?? ch });
    i++;
  }
  // Merge adjacent text nodes back together.
  const merged: Node[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    if (n.type === "text" && prev?.type === "text") (prev as Text).value += n.value;
    else merged.push(n);
  }
  return merged;
}

function hasSentinel(node: Node | Root): boolean {
  if (node.type === "text") return SENTINEL_RE.test(node.value);
  if ("children" in node) return node.children.some((c) => hasSentinel(c as Node));
  return false;
}

function transform(node: Root | Element) {
  for (const c of node.children) {
    if (c.type === "element") transform(c);
  }
  if (node.children.some((c) => c.type === "text" && SENTINEL_RE.test(c.value))) {
    node.children = wrapLevel(node.children as Node[]) as typeof node.children;
  }
}

/** rehype plugin — must run on the tree produced from `prepareCriticMarkup` output. */
/** Restore escaped user characters in every text node and string property. */
function restoreUserSentinels(node: Node | Root) {
  if (node.type === "text") {
    node.value = unescapeUserSentinels(node.value);
    return;
  }
  if (node.type === "element") {
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      if (typeof v === "string" && v.includes(ESC)) node.properties![k] = unescapeUserSentinels(v);
    }
  }
  if ("children" in node) for (const c of node.children) restoreUserSentinels(c as Node);
}

function hasEscape(node: Node | Root): boolean {
  if (node.type === "text") return node.value.includes(ESC);
  if (node.type === "element" && Object.values(node.properties ?? {}).some((v) => typeof v === "string" && v.includes(ESC))) {
    return true;
  }
  if ("children" in node) return node.children.some((c) => hasEscape(c as Node));
  return false;
}

export function rehypeCriticMarkup() {
  return (tree: Root) => {
    if (hasSentinel(tree)) transform(tree);
    if (hasEscape(tree)) restoreUserSentinels(tree);
  };
}
