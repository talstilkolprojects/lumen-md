/**
 * CriticMarkup in the WYSIWYG editor (split out of wysiwygSuggest.ts, plan
 * W4.11): the remark plugin that turns {++ ++} / {-- --} into marks and back,
 * and the ProseMirror mark schemas. wysiwygSuggest.ts re-exports all of it.
 */
import { $markSchema, $remark } from "@milkdown/utils";
import type { Mark } from "@milkdown/prose/model";
import type { Parents, PhrasingContent, Root } from "mdast";
import { defaultHandlers } from "mdast-util-to-markdown";
import { CRITIC_LITERAL, CRITIC_SENTINELS as S, prepareCriticMarkup, unescapeUserSentinels } from "../renderer/criticMarkup";
import { sanitizeAuthor } from "./suggesting";

/* ─── Parse: markdown → sentinels → mdast nodes ─────────────────────── */

/** A folded author tag in prepared markdown: a change's closer + `{>>@name<<}`. */
const AUTHOR_TAG = new RegExp(`([${S.insClose}${S.delClose}${S.subClose}]${S.comOpen}@)([^@<>{}\n]+)(?=${S.comClose})`, "g");

/** Prepare markdown for Milkdown: CriticMarkup delimiters → sentinels. */
export function encodeCriticForWysiwyg(markdown: string): string {
  // An author name is plain text, but remark would parse markdown in it
  // (`Jane *Doe*` → text + emphasis) and the tag would no longer be read
  // as one: escape its punctuation so it arrives as a single text node.
  return prepareCriticMarkup(markdown).replace(AUTHOR_TAG, (_m, head: string, name: string) =>
    head + name.replace(/[!-/:-@[-`{-~]/g, "\\$&"),
  );
}

interface CriticNode {
  type: "criticInsert" | "criticDelete";
  author?: string;
  /** Spaces Milkdown's serializer moved out of the mark (restored on stringify). */
  spaceBefore?: string;
  spaceAfter?: string;
  children: PhrasingContent[];
}

const SENTINEL_SPLIT = /([-])/;
const isSentinelChar = (v: string) => v.length === 1 && v >= "" && v <= "";
const sentinelAt = (nodes: PhrasingContent[], i: number): string | null => {
  const n = nodes[i];
  return n?.type === "text" && isSentinelChar(n.value) ? n.value : null;
};

function splitSentinels(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const c of children) {
    if (c.type === "text" && /[-]/.test(c.value)) {
      for (const part of c.value.split(SENTINEL_SPLIT)) if (part) out.push({ type: "text", value: part });
    } else out.push(c);
  }
  return out;
}

function indexOf(nodes: PhrasingContent[], ch: string, from: number): number {
  for (let i = from; i < nodes.length; i++) if (sentinelAt(nodes, i) === ch) return i;
  return -1;
}

/** `{>>@name<<}` right after a change: its author tag. */
function authorTagAt(nodes: PhrasingContent[], i: number): { author: string; end: number } | null {
  if (sentinelAt(nodes, i) !== S.comOpen) return null;
  const body = nodes[i + 1];
  if (body?.type !== "text" || !body.value.startsWith("@") || sentinelAt(nodes, i + 2) !== S.comClose) return null;
  const author = sanitizeAuthor(body.value.slice(1));
  return author ? { author, end: i + 3 } : null;
}

function mergeText(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last?.type === "text") last.value += n.value;
    else out.push(n);
  }
  return out;
}

/** Pair the sentinels of one phrasing parent into critic nodes. */
function wrapChildren(children: PhrasingContent[]): PhrasingContent[] {
  const nodes = splitSentinels(children);
  const out: PhrasingContent[] = [];
  const pushChange = (node: CriticNode) => out.push(node as unknown as PhrasingContent);
  let i = 0;
  while (i < nodes.length) {
    const s = sentinelAt(nodes, i);
    if (s === S.insOpen || s === S.delOpen) {
      const close = indexOf(nodes, s === S.insOpen ? S.insClose : S.delClose, i + 1);
      if (close !== -1) {
        const tag = authorTagAt(nodes, close + 1);
        pushChange({
          type: s === S.insOpen ? "criticInsert" : "criticDelete",
          ...(tag ? { author: tag.author } : {}),
          children: wrapChildren(nodes.slice(i + 1, close)),
        });
        i = tag ? tag.end : close + 1;
        continue;
      }
    } else if (s === S.subOpen) {
      const mid = indexOf(nodes, S.subMid, i + 1);
      const close = mid === -1 ? -1 : indexOf(nodes, S.subClose, mid + 1);
      if (close !== -1) {
        const tag = authorTagAt(nodes, close + 1);
        const author = tag ? { author: tag.author } : {};
        pushChange({ type: "criticDelete", ...author, children: wrapChildren(nodes.slice(i + 1, mid)) });
        pushChange({ type: "criticInsert", ...author, children: wrapChildren(nodes.slice(mid + 1, close)) });
        i = tag ? tag.end : close + 1;
        continue;
      }
    }
    // Comments, highlights and unpaired sentinels: their literal text.
    const n = nodes[i];
    out.push(s ? { type: "text", value: CRITIC_LITERAL[s] ?? s } : n);
    i++;
  }
  return mergeText(out);
}

const GENERATED_SENTINEL = /[\uE000-\uE00A]/g;

/**
 * Restore the original characters in every string property: escaped user
 * sentinels everywhere, and generated sentinels that pairing didn't consume
 * — CriticMarkup inside a link destination or title, an image's alt, raw
 * HTML or math lives in a property (`url`, `title`, `alt`, `value`), not in
 * child text, so it stays literal markup there instead of leaking
 * private-use characters into the document.
 */
function unescapeTree(node: { type: string; children?: unknown[] } & Record<string, unknown>): void {
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (key === "type" || typeof v !== "string") continue;
    node[key] = unescapeUserSentinels(v.replace(GENERATED_SENTINEL, (c) => CRITIC_LITERAL[c] ?? c));
  }
  for (const c of (node.children ?? []) as Array<{ type: string; children?: unknown[] } & Record<string, unknown>>) unescapeTree(c);
}

const PHRASING_PARENTS = new Set(["paragraph", "heading", "tableCell", "emphasis", "strong", "delete", "link", "linkReference"]);

/* Suggestions spanning blocks (`{--first\n\nsecond--}`): their delimiters
 * land in different paragraphs, so neither would pair. The suggestion is
 * split into one piece per block — closed at the end of a block, reopened
 * at the start of the next, every piece carrying the author — and is
 * written back that way (`{--first--}\n\n{--second--}`).
 *
 * The pieces can't hold the paragraph breaks between them, which stay
 * when they are resolved. So a suggestion is only split where that makes
 * no difference: when nothing precedes it in its first block or nothing
 * follows it in its last (a substitution: both), the breaks it would
 * drop only leave empty paragraphs. And only for runs of sibling
 * paragraphs (a heading may start the run, where its `#` is outside the
 * change in source mode too) whose sentinels are all direct children. Anything
 * else stays literal text, written back unchanged. */

const TEXT_BLOCKS = new Set(["paragraph", "heading"]);
type TextBlock = { type: string; children: PhrasingContent[] };
type Open = "ins" | "del" | "sub" | "subNew"; // subNew: past the `~>`
const OPENER: Record<Open, string> = { ins: S.insOpen, del: S.delOpen, sub: S.subOpen, subNew: S.subOpen };
const CLOSER: Record<Open, string> = { ins: S.insClose, del: S.delClose, sub: S.subClose, subNew: S.subClose };

const sentinelText = (ch: string): PhrasingContent => ({ type: "text", value: ch });

function deepSentinels(nodes: PhrasingContent[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "text") for (const ch of n.value) isSentinelChar(ch) && out.push(ch);
    else if ("children" in n) deepSentinels(n.children as PhrasingContent[], out);
  }
  return out;
}

/** Top-level sentinels of a text block, or null when one is nested in other markup. */
function blockSentinels(block: TextBlock): string[] | null {
  block.children = splitSentinels(block.children);
  const top = block.children.flatMap((_, i) => sentinelAt(block.children, i) ?? []);
  return deepSentinels(block.children).length === top.length ? top : null;
}

/** The change left open at the end of a block's sentinels, if any. */
function openAtEnd(sentinels: string[]): Open | null {
  let open: Open | null = null;
  for (const ch of sentinels) {
    if (ch === S.insOpen) open = "ins";
    else if (ch === S.delOpen) open = "del";
    else if (ch === S.subOpen) open = "sub";
    else if (ch === S.subMid && open === "sub") open = "subNew";
    else if (ch === S.insClose || ch === S.delClose || ch === S.subClose) open = null;
  }
  return open;
}

function pairAcrossBlocks(blocks: TextBlock[]): void {
  for (let i = 0; i < blocks.length; i++) {
    if (!TEXT_BLOCKS.has(blocks[i].type)) continue;
    const first = blockSentinels(blocks[i]);
    const start = first && openAtEnd(first);
    if (!start) continue;
    // Follow the open change to the block that closes it.
    const roles: Array<{ block: TextBlock; open: Open; role: "middle" | "mid" | "close" }> = [];
    let open: Open = start;
    let end = -1;
    for (let j = i + 1; j < blocks.length && end === -1; j++) {
      const b = blocks[j];
      // Only paragraphs continue a run: a later heading's `#` would stay
      // outside the mark (accepting `{--a\n\n# b--}` must not leave `#`).
      const sen = b.type === "paragraph" ? blockSentinels(b) : null;
      if (!sen) break;
      const next = open === "sub" ? S.subMid : CLOSER[open];
      if (sen.length === 0) roles.push({ block: b, open, role: "middle" });
      else if (sen[0] !== next) break;
      else if (open === "sub" && sen.length === 1) {
        roles.push({ block: b, open, role: "mid" });
        open = "subNew";
      } else if (open !== "sub" || sen[1] === S.subClose) {
        roles.push({ block: b, open, role: "close" });
        end = j;
      } else break;
    }
    if (end === -1) continue;
    // The author tag after the final closer applies to every piece.
    const last = roles[roles.length - 1];
    const closer = last.block.children.findIndex((_, k) => sentinelAt(last.block.children, k) === CLOSER[last.open]);
    const authorTag = authorTagAt(last.block.children, closer + 1);
    const author = authorTag?.author;
    const blank = (nodes: PhrasingContent[]) => nodes.every((n) => n.type === "text" && !n.value.trim());
    const a = blocks[i];
    const opener = a.children.map((_, n) => sentinelAt(a.children, n)).lastIndexOf(OPENER[start]);
    const before = blank(a.children.slice(0, opener));
    const after = blank(last.block.children.slice(authorTag ? authorTag.end : closer + 1));
    if (start === "ins" || start === "del" ? !before && !after : !before || !after) continue;
    const tag = (): PhrasingContent[] =>
      author ? [sentinelText(S.comOpen), { type: "text", value: "@" + author }, sentinelText(S.comClose)] : [];
    const asIns = (o: Open) => o === "ins" || o === "subNew";
    if (start === "sub") {
      // Only old text here: a deletion piece.
      a.children[opener] = sentinelText(S.delOpen);
      a.children.push(sentinelText(S.delClose), ...tag());
    } else {
      a.children.push(sentinelText(CLOSER[start]), ...tag());
    }
    for (const { block, open: o, role } of roles) {
      if (role === "middle") {
        block.children.unshift(sentinelText(asIns(o) ? S.insOpen : S.delOpen));
        block.children.push(sentinelText(asIns(o) ? S.insClose : S.delClose), ...tag());
      } else if (role === "mid") {
        block.children.unshift(sentinelText(S.subOpen));
        block.children.push(sentinelText(S.subClose), ...tag());
      } else if (o === "subNew") {
        // Only new text here: an insertion piece.
        block.children[closer] = sentinelText(S.insClose);
        block.children.unshift(sentinelText(S.insOpen));
      } else {
        block.children.unshift(sentinelText(OPENER[o]));
      }
    }
    i = end;
  }
}

function transformTree(node: Parents | Root): void {
  const kids = (node as { children?: unknown[] }).children as Array<Parents> | undefined;
  if (!kids) return;
  if (PHRASING_PARENTS.has(node.type)) {
    (node as { children: PhrasingContent[] }).children = wrapChildren(node.children as PhrasingContent[]);
  } else {
    pairAcrossBlocks(kids as unknown as TextBlock[]);
  }
  for (const c of (node as { children: Array<Parents> }).children) {
    if ((c as { children?: unknown }).children) transformTree(c);
  }
}

/* ─── Serialize: critic nodes → CriticMarkup ────────────────────────── */

interface StringifyState {
  containerPhrasing(node: unknown, info: unknown): string;
}
type Handler = (node: CriticNode, parent: { children: unknown[] } | undefined, state: StringifyState, info: unknown) => string;

const tag = (author?: string | null) => {
  const a = sanitizeAuthor(author);
  return a ? `{>>@${a}<<}` : "";
};
const siblings = (node: unknown, parent?: { children: unknown[] }) => {
  const i = parent ? parent.children.indexOf(node) : -1;
  return {
    prev: i > 0 ? (parent!.children[i - 1] as CriticNode) : undefined,
    next: i >= 0 ? (parent!.children[i + 1] as CriticNode) : undefined,
  };
};

const sameAuthor = (a?: { author?: string | null }, b?: { author?: string | null }) => (a?.author ?? null) === (b?.author ?? null);
const isCritic = (n: unknown): n is CriticNode => {
  const t = (n as { type?: string } | undefined)?.type;
  return t === "criticInsert" || t === "criticDelete";
};

/**
 * Milkdown's serializer moves spaces at a mark's edges out of the mark
 * (`{++big ++}` → `{++big++} `), which would leave an inserted / deleted
 * space unmarked and split `{++new **bold**++}` around its space. The mark
 * runner records what moves (spaceBefore / spaceAfter); here those spaces
 * go back inside, and directly adjacent runs of the same kind and author
 * are joined. Plain whitespace BETWEEN two suggestions stays outside, so
 * `{++one++} {++two++}` stays two suggestions.
 */
function restoreCriticSpaces(node: { children?: unknown[] }): void {
  const kids = node.children as Array<{ type: string; value?: string; children?: unknown[] }> | undefined;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (!isCritic(c)) continue;
    const prev = kids[i - 1];
    if (c.spaceBefore && prev?.type === "text" && prev.value?.endsWith(c.spaceBefore)) {
      prev.value = prev.value.slice(0, -c.spaceBefore.length);
      c.children.unshift({ type: "text", value: c.spaceBefore });
      if (!prev.value) {
        kids.splice(i - 1, 1);
        i--;
      }
    }
    const next = kids[i + 1];
    if (c.spaceAfter && next?.type === "text" && next.value?.startsWith(c.spaceAfter)) {
      next.value = next.value.slice(c.spaceAfter.length);
      c.children.push({ type: "text", value: c.spaceAfter });
      if (!next.value) kids.splice(i + 1, 1);
    }
    delete c.spaceBefore;
    delete c.spaceAfter;
  }
  // Join runs the serializer split (now directly adjacent).
  for (let i = kids.length - 1; i > 0; i--) {
    const a = kids[i - 1];
    const b = kids[i];
    if (isCritic(a) && isCritic(b) && a.type === b.type && sameAuthor(a, b)) {
      a.children.push(...b.children);
      kids.splice(i, 1);
    }
  }
  for (const c of kids) restoreCriticSpaces(c);
}

const criticDeleteHandler: Handler = (node, parent, state, info) => {
  const inner = state.containerPhrasing(node, info);
  const { next } = siblings(node, parent);
  // A deletion followed directly by an insertion BY THE SAME AUTHOR is one
  // substitution; different authors stay two independent changes.
  if (next?.type === "criticInsert" && sameAuthor(node, next)) return `{~~${inner}~>`;
  return `{--${inner}--}${tag(node.author)}`;
};
const criticInsertHandler: Handler = (node, parent, state, info) => {
  const inner = state.containerPhrasing(node, info);
  const { prev } = siblings(node, parent);
  if (prev?.type === "criticDelete" && sameAuthor(node, prev)) return `${inner}~~}${tag(node.author)}`;
  return `{++${inner}++}${tag(node.author)}`;
};

type RootHandler = (node: unknown, parent: unknown, state: unknown, info: unknown) => string;

/** The remark plugin: parse sentinels on the way in, write CriticMarkup out. */
export function remarkCriticMarkup(this: { data: (key?: string) => Record<string, unknown> }) {
  const data = this.data() as { toMarkdownExtensions?: unknown[] };
  (data.toMarkdownExtensions ??= []).push({
    handlers: {
      criticInsert: criticInsertHandler,
      criticDelete: criticDeleteHandler,
      root: ((node, parent, state, info) => {
        restoreCriticSpaces(node as { children?: unknown[] });
        return (defaultHandlers.root as unknown as RootHandler)(node, parent, state, info);
      }) as RootHandler,
    },
  });
  return (tree: Root) => {
    transformTree(tree);
    unescapeTree(tree as unknown as Parameters<typeof unescapeTree>[0]);
  };
}

/* ─── Milkdown plugins: remark, marks, tracking ─────────────────────── */

export const criticRemark = $remark("criticMarkup", () => remarkCriticMarkup as never);

const markSchema = (name: "critic_insert" | "critic_delete", mdType: CriticNode["type"], tagName: "ins" | "del") =>
  $markSchema(name, () => ({
    attrs: { author: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: `${tagName}[data-critic]`,
        getAttrs: (dom: HTMLElement) => ({ author: dom.getAttribute("data-author") }),
      },
    ],
    toDOM: (mark: Mark) => [
      tagName,
      {
        "data-critic": "",
        class: tagName === "ins" ? "critic-ins" : "critic-del",
        ...(mark.attrs.author ? { "data-author": mark.attrs.author, title: `@${mark.attrs.author}` } : {}),
      },
    ],
    parseMarkdown: {
      match: (node: { type: string }) => node.type === mdType,
      runner: (state, node, markType) => {
        state.openMark(markType, { author: (node as { author?: string }).author ?? null });
        state.next(node.children ?? []);
        state.closeMark(markType);
      },
    },
    toMarkdown: {
      match: (mark: Mark) => mark.type.name === name,
      runner: (state, mark, node) => {
        const props: Record<string, string> = mark.attrs.author ? { author: mark.attrs.author } : {};
        // Record the edge spaces the serializer will move out of the mark
        // (it does so when the mark closes after this text, which is only
        // reliable when no other mark wraps the text).
        const text = node.isText ? (node.text ?? "") : "";
        if (text && node.marks.every((m) => m.type.name === "critic_insert" || m.type.name === "critic_delete")) {
          if (text.startsWith(" ")) props.spaceBefore = text.slice(0, text.length - text.trimStart().length);
          if (text.endsWith(" ")) props.spaceAfter = text.slice(text.trimEnd().length);
          if (!text.trim()) delete props.spaceBefore; // all-space text: moved once, after
        }
        state.withMark(mark, mdType, undefined, props);
      },
    },
  }));

export const criticInsertSchema = markSchema("critic_insert", "criticInsert", "ins");
export const criticDeleteSchema = markSchema("critic_delete", "criticDelete", "del");
