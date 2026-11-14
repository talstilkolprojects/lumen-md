/**
 * Obsidian-style embeds (plan 4.7) — a remark plugin plus the pure helpers
 * around it:
 *
 *   ![[Note]]               the whole note, rendered in place
 *   ![[Note#Heading]]       only that section: the heading and everything
 *                           up to the next heading of the same or a higher
 *                           level (`#H1#H2` narrows to a subheading)
 *   ![[Note#^block-id]]     one block marked `^block-id`
 *   ![[#Heading]]           a section of the note the embed is written in
 *   ![[image.png|300]]      an image (`|alt`, `|300` or `|300x200`)
 *   ![[file.pdf]]           a card that opens the PDF (the CSP allows no
 *                           frames or objects for workspace files, and a
 *                           PDF.js viewer would be a heavy dependency)
 *
 * The embedded note is parsed into mdast and spliced into the host's tree
 * before remark-rehype, so it goes through exactly the same pipeline as the
 * host: wiki links, Lumen blocks, CriticMarkup, heading slugs, direction,
 * Shiki, KaTeX — and, for raw HTML, the same rehype-raw + rehypeSanitizeRaw
 * pass (the pipeline picks the raw-HTML processor when any embedded source
 * has HTML, see `embeddedTexts`). Nothing is rendered outside it.
 *
 * The pipeline's remark plugin (./remarkEmbeds) is synchronous (the fast
 * first-paint pass is `processSync`), so nothing here reads files: the
 * caller builds an `EmbedContext` from the in-memory workspace index
 * (src/renderer/embedContext.ts) and passes it through
 * `file.data.lumenEmbeds`; the plugin calls its `expand`. This module is
 * loaded only with a context — not in the startup bundle.
 *
 * Guards: embeds nest at most `MAX_EMBED_DEPTH` levels; a note that embeds
 * itself, directly or through other notes, shows a notice in place of the
 * embed; so does a missing note, file or section.
 */

import { BLOCK_MARK } from "./remarkBlockIds";
import type { Root as MdastRoot } from "mdast";
import { headingSlug, headingSlugger, noteKey } from "../lib/slug";
import { firstStrongDirection, markdownBaseDirection } from "../lib/textDirection";
import { EMBED_SOURCE, LITERAL_NODES as LITERAL, type EmbedExpander } from "./remarkEmbeds";

export { hasEmbeds } from "./remarkEmbeds";

export const MAX_EMBED_DEPTH = 3;

export type EmbedKind = "note" | "image" | "pdf";
export type EmbedNoticeKind = "notFound" | "sectionNotFound" | "cycle" | "depth";

export interface EmbedContext extends EmbedExpander {
  /** Workspace path of the note being previewed, or null (scratch / disk file). */
  hostPath: string | null;
  /** The host note's live text — what the editor holds, not the saved file. */
  hostText: string;
  /** Every workspace file path embeds may resolve to. */
  paths: readonly string[];
  /** Text of a workspace note, or undefined when it can't be read. */
  read(path: string): string | undefined;
  /** Localized notice text. */
  notice(kind: EmbedNoticeKind, vars: Record<string, string | number>): string;
  /** Paths the render embedded: the preview re-renders when one of them changes. */
  used: Set<string>;
  /** When a file last changed, if known — part of an embedded image's cache key. */
  version(path: string): number | undefined;
}

/** Build a context from `{path, content, modified?}` entries (the workspace index). */
export function createEmbedContext(opts: {
  hostPath: string | null;
  hostText: string;
  files: Iterable<{ path: string; content: string; modified?: number }>;
  notice: EmbedContext["notice"];
}): EmbedContext {
  const byPath = new Map<string, { content: string; modified?: number }>();
  for (const f of opts.files) byPath.set(f.path, f);
  const ctx: EmbedContext = {
    hostPath: opts.hostPath,
    hostText: opts.hostText,
    paths: [...byPath.keys()],
    read: (p) => (p === opts.hostPath ? opts.hostText : byPath.get(p)?.content),
    version: (p) => byPath.get(p)?.modified,
    notice: opts.notice,
    used: new Set(),
    expand: (tree, parse) => {
      const host = ctx.hostPath ?? HOST;
      walk(tree as unknown as Node, { ctx, parse, depth: 0, chain: [`${host}#`], current: host, state: { count: 0 } });
    },
  };
  return ctx;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|svg|webp|avif|apng)$/i;
const PDF_EXT = /\.pdf$/i;
const MD_EXT = /\.(md|markdown)$/i;
const embedRe = () => new RegExp(EMBED_SOURCE, "g");
/** The key the host note has in the cycle chain when it is not a workspace file. */
const HOST = "\u0000host";

export interface ParsedEmbed {
  /** Everything before `|`: `Note#Heading`. */
  target: string;
  /** The note or file part (empty for `#Heading` in the same note). */
  note: string;
  /** After the first `#`: a heading path or `^block-id`. */
  fragment: string | null;
  /** After the first `|`: alt text and / or size for images. */
  alias: string | null;
}

/** Split the inside of `![[…]]`. */
export function parseEmbed(inner: string): ParsedEmbed {
  const bar = inner.indexOf("|");
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const alias = bar < 0 ? null : inner.slice(bar + 1).trim() || null;
  const hash = target.indexOf("#");
  const note = (hash < 0 ? target : target.slice(0, hash)).trim();
  const fragment = hash < 0 ? null : target.slice(hash + 1).trim() || null;
  return { target, note, fragment, alias };
}

export function embedKind(note: string): EmbedKind {
  if (IMAGE_EXT.test(note)) return "image";
  if (PDF_EXT.test(note)) return "pdf";
  return "note";
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function joinRelative(fromDir: string, rel: string): string {
  const out: string[] = fromDir ? fromDir.split("/") : [];
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

// Every render with embeds compares each target against every vault path:
// remember the paths' keys instead of normalizing them each time.
const pathKeys = new Map<string, string>();
function pathKey(p: string): string {
  let k = pathKeys.get(p);
  if (k === undefined) {
    if (pathKeys.size > 50_000) pathKeys.clear();
    k = noteKey(p);
    pathKeys.set(p, k);
  }
  return k;
}

/**
 * Workspace path an embed target names, or null. Names compare by `noteKey`
 * (case, niqqud, final letters, `.md`). A full path wins; `./` and `../`
 * are relative to the embedding note; otherwise any path ending in the name
 * (`folder/Note` finds `a/folder/Note.md`). When several match: the one next
 * to the embedding note, else the shortest path, as Obsidian does.
 */
export function resolveEmbedTarget(
  name: string,
  paths: readonly string[],
  fromPath: string | null,
  kind: EmbedKind,
): string | null {
  const raw = name.trim();
  const fromDir = fromPath ? dirOf(fromPath) : "";
  const want = /^\.\.?\//.test(raw) ? joinRelative(fromDir, raw) : raw.replace(/^\/+/, "");
  if (!want) return null;
  const pool = kind === "note" ? paths.filter((p) => MD_EXT.test(p)) : paths;
  const key = noteKey(want);
  const exact = pool.find((p) => pathKey(p) === key);
  if (exact) return exact;
  const tail = pool.filter((p) => pathKey(p).endsWith("/" + key));
  if (!tail.length) return null;
  return (
    tail.find((p) => dirOf(p) === fromDir) ??
    [...tail].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0]
  );
}

/**
 * The texts of the notes `markdown` embeds, transitively (up to the depth
 * limit). The pipeline needs them before it runs: raw HTML or math inside an
 * embedded note selects the same rehype-raw + sanitizer / KaTeX passes the
 * host would get for it. Over-inclusive (code is not skipped) — harmless.
 */
export function embeddedTexts(markdown: string, ctx: EmbedContext): string[] {
  const out: string[] = [];
  // The shallowest depth each note was reached at: a note met first deep in
  // one branch (its own embeds cut off by the depth limit) is walked again
  // when another branch embeds it higher up, where its embeds do render.
  const shallowest = new Map<string, number>();
  const visit = (text: string, from: string | null, depth: number) => {
    if (depth >= MAX_EMBED_DEPTH) return;
    for (const m of text.matchAll(embedRe())) {
      const e = parseEmbed(m[1]);
      if (!e.note || embedKind(e.note) !== "note") continue;
      const path = resolveEmbedTarget(e.note, ctx.paths, from, "note");
      if (!path || path === ctx.hostPath) continue;
      const before = shallowest.get(path);
      if (before !== undefined && before <= depth) continue;
      const t = ctx.read(path);
      if (t === undefined) continue;
      if (before === undefined) out.push(t);
      shallowest.set(path, depth);
      visit(t, path, depth + 1);
    }
  };
  visit(markdown, ctx.hostPath, 0);
  return out;
}

// ── mdast helpers ────────────────────────────────────────────────────────
// Loose node shape: the plugin creates custom node types (lumenEmbed…) that
// mdast-util-to-hast turns into elements through `data.hName`.

interface Node {
  type: string;
  value?: string;
  depth?: number;
  url?: string;
  alt?: string | null;
  title?: string | null;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}
interface Item {
  node: Node;
  /** Must stand on its own between blocks (a note embed or its notice). */
  block: boolean;
}

/** Text that does not decide a block's direction. */
const NO_DIRECTION = new Set(["code", "inlineCode", "math", "inlineMath", "html", "yaml"]);
/** Nodes whose children are blocks — where a note embed may replace a paragraph. */
const FLOW = new Set(["root", "blockquote", "list", "listItem", "footnoteDefinition", "containerDirective"]);

function plainText(node: Node | Node[], skip?: Set<string>): string {
  if (Array.isArray(node)) return node.map((n) => plainText(n, skip)).join(" ");
  if (skip?.has(node.type)) return "";
  if (typeof node.value === "string") return node.value;
  return node.children ? node.children.map((n) => plainText(n, skip)).join("") : "";
}

const text = (value: string): Node => ({ type: "text", value });

/** Same shape remarkWikiLinks gives a `[[target|label]]`. */
function wikiLink(target: string, label: string): Node {
  return {
    type: "link",
    url: `#${headingSlug(target)}`,
    title: null,
    data: { hProperties: { className: ["wiki-link"], "data-wiki-target": target } },
    children: [text(label)],
  };
}

/** Heading text compared the way the preview's ids are, and case / niqqud-insensitive. */
const headingKey = (s: string) => headingSlug(noteKey(s));

/**
 * The section a heading path names: the heading and its following
 * siblings up to the next heading of the same or a higher level. Each part
 * of `H1#H2` is looked for inside the previous part's section.
 */
function sectionOf(children: Node[], fragment: string): Node[] | null {
  const parts = fragment.split("#").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let lo = 0;
  let hi = children.length;
  let level = 0;
  let sel: [number, number] | null = null;
  for (const part of parts) {
    const want = headingKey(part);
    let i = lo;
    while (i < hi && !(children[i].type === "heading" && (children[i].depth ?? 0) > level && headingKey(plainText(children[i])) === want)) i++;
    if (i >= hi) return null;
    const d = children[i].depth ?? 1;
    let j = i + 1;
    while (j < hi && !(children[j].type === "heading" && (children[j].depth ?? 0) <= d)) j++;
    sel = [i, j];
    lo = i + 1;
    hi = j;
    level = d;
  }
  return sel ? children.slice(sel[0], sel[1]) : null;
}


/**
 * The block an Obsidian block id names: a paragraph (in a list item, the
 * item's paragraph) ending in ` ^id`, or — for a `^id` line of its own —
 * the block right before it. The marker itself is not shown.
 */
function blockOf(children: Node[], id: string): Node[] | null {
  const found: { node: Node | null; done: boolean } = { node: null, done: false };
  const search = (list: Node[]) => {
    for (let i = 0; i < list.length && !found.done; i++) {
      const n = list[i];
      const last = n.type === "paragraph" ? n.children?.[n.children.length - 1] : undefined;
      const m = last?.type === "text" ? BLOCK_MARK.exec(last.value ?? "") : null;
      if (m && m[2] === id && last) {
        found.done = true;
        const before = (last.value ?? "").slice(0, m.index);
        if (n.children?.length === 1 && !before.trim()) {
          found.node = i > 0 ? list[i - 1] : null;
          return;
        }
        last.value = before + m[1];
        found.node = n;
        return;
      }
      if (n.children && n.type !== "paragraph") search(n.children);
    }
  };
  search(children);
  return found.node ? [found.node] : null;
}

interface Env {
  ctx: EmbedContext;
  parse: (markdown: string) => MdastRoot;
  depth: number;
  /** `path#fragment` of every embed between the host and here (host first). */
  chain: string[];
  /** The note whose text is being walked (HOST for a non-workspace host). */
  current: string;
  state: { count: number };
}

function notice(env: Env, kind: EmbedNoticeKind, target: string, vars: Record<string, string | number>, block: boolean): Item {
  return {
    block,
    node: {
      type: "lumenEmbedNotice",
      data: {
        hName: block ? "div" : "span",
        hProperties: { className: ["lumen-embed-notice"], role: "note", "data-embed-status": kind, "data-embed-target": target },
      },
      children: [text(env.ctx.notice(kind, vars))],
    },
  };
}

/** `|alt`, `|300`, `|300x200`, `|alt|300` → alt / width / height. */
function imageAlias(alias: string | null): { alt: string | null; width?: number; height?: number } {
  if (!alias) return { alt: null };
  let alt: string | null = null;
  let width: number | undefined;
  let height: number | undefined;
  for (const part of alias.split("|").map((s) => s.trim())) {
    const size = /^(\d{1,5})(?:x(\d{1,5}))?$/.exec(part);
    if (size) {
      width = Number(size[1]);
      if (size[2]) height = Number(size[2]);
    } else if (part) alt = part;
  }
  return { alt, width, height };
}

function buildEmbed(inner: string, env: Env, blockAllowed: boolean): Item {
  const e = parseEmbed(inner);
  const { ctx } = env;
  if (!e.target) return { node: text(`![[${inner}]]`), block: false };
  const kind = embedKind(e.note);
  const from = env.current === HOST ? ctx.hostPath : env.current;

  if (kind === "image") {
    // Pasted `lumen-asset-*` files are not in the workspace index; the
    // context lists the ones that exist (./embedContext), so a deleted asset
    // is reported missing like any other file.
    const path = resolveEmbedTarget(e.note, ctx.paths, from, "image");
    if (!path) return notice(env, "notFound", e.target, { target: e.target }, false);
    ctx.used.add(path);
    const { alt, width, height } = imageAlias(e.alias);
    const props: Record<string, unknown> = { className: ["lumen-embed-image"], "data-lumen-path": path };
    // A new version is a new cache key: an image saved over keeps no stale bytes.
    const version = ctx.version(path);
    if (version !== undefined) props["data-lumen-version"] = String(version);
    if (width) props.width = width;
    if (height) props.height = height;
    return {
      block: false,
      node: { type: "image", url: path, title: null, alt: alt ?? baseOf(path).replace(/\.[^.]+$/, ""), data: { hProperties: props } },
    };
  }

  if (kind === "pdf") {
    const path = resolveEmbedTarget(e.note, ctx.paths, from, "pdf");
    if (!path) return notice(env, "notFound", e.target, { target: e.target }, false);
    ctx.used.add(path);
    const name = e.alias ?? baseOf(path);
    return {
      block: false,
      node: { type: "lumenEmbedFile", data: { hName: "lumen-embed-file", hProperties: { path, name, kind } }, children: [text(name)] },
    };
  }

  // A note embed is a block; inside a heading or emphasis it can't be one,
  // so it renders as the link it names.
  if (!blockAllowed) return { node: text(`[[${inner}]]`), block: false };
  if (env.depth >= MAX_EMBED_DEPTH) return notice(env, "depth", e.target, { target: e.target, max: MAX_EMBED_DEPTH }, true);

  const hostKey = ctx.hostPath ?? HOST;
  const path = e.note ? resolveEmbedTarget(e.note, ctx.paths, from, "note") : env.current;
  if (!path) return notice(env, "notFound", e.target, { target: e.target }, true);
  // A whole note may not appear inside itself; a section may appear once per
  // chain (the host embedding one of its own sections is fine).
  const key = `${path}#${e.fragment ? headingKey(e.fragment) : ""}`;
  if (env.chain.includes(key) || (!e.fragment && env.chain.some((k) => k.startsWith(path + "#")))) {
    return notice(env, "cycle", e.target, { target: e.target }, true);
  }
  const source = path === hostKey ? ctx.hostText : ctx.read(path);
  if (source === undefined) return notice(env, "notFound", e.target, { target: e.target }, true);
  if (path !== hostKey) ctx.used.add(path);

  const name = path === HOST ? "" : baseOf(path).replace(MD_EXT, "");
  let children = env.parse(source).children as unknown as Node[];
  if (e.fragment) {
    const section = e.fragment.startsWith("^") ? blockOf(children, e.fragment.slice(1)) : sectionOf(children, e.fragment);
    if (!section) {
      return notice(env, "sectionNotFound", e.target, { section: e.fragment, note: name || e.target }, true);
    }
    children = section;
  }
  const dir = e.fragment
    ? firstStrongDirection(plainText(children, NO_DIRECTION)) ?? markdownBaseDirection(source)
    : markdownBaseDirection(source);

  // Embedded headings get ids of their own, so rehype-slug's numbering of
  // the host's headings (outline, scroll sync, `#heading` links) is the same
  // with or without the embed.
  const n = ++env.state.count;
  const slugger = headingSlugger();
  const idHeadings = (list: Node[]) => {
    for (const c of list) {
      if (c.type === "heading") {
        c.data = { ...c.data, hProperties: { ...c.data?.hProperties, id: `embed-${n}-${slugger.slug(plainText(c))}` } };
      } else if (c.children) idHeadings(c.children);
    }
  };
  idHeadings(children);

  const body: Node = { type: "root", children };
  walk(body, { ...env, depth: env.depth + 1, chain: [...env.chain, key], current: path });

  // A section of the host itself links within the page; anything else opens its note.
  const linkTarget = path === hostKey ? `#${e.fragment ?? ""}` : `${path.replace(MD_EXT, "")}${e.fragment ? `#${e.fragment}` : ""}`;
  const label = [name, e.fragment?.replace(/^\^/, "")].filter(Boolean).join(" › ");
  return {
    block: true,
    node: {
      type: "lumenEmbed",
      data: {
        hName: "div",
        hProperties: {
          className: ["lumen-embed"],
          dir,
          "data-embed-target": e.target,
          "data-embed-path": path === HOST ? "" : path,
          "data-embed-depth": env.depth + 1,
        },
      },
      children: [
        { type: "lumenEmbedTitle", data: { hName: "div", hProperties: { className: ["lumen-embed-title"] } }, children: [wikiLink(linkTarget, label || e.target)] },
        { type: "lumenEmbedBody", data: { hName: "div", hProperties: { className: ["lumen-embed-body"] } }, children: body.children },
      ],
    },
  };
}

/** Text with embeds → text and embed items. */
function segments(value: string, env: Env, blockAllowed: boolean): Item[] {
  const out: Item[] = [];
  let last = 0;
  for (const m of value.matchAll(embedRe())) {
    if (m.index! > last) out.push({ node: text(value.slice(last, m.index)), block: false });
    out.push(buildEmbed(m[1], env, blockAllowed));
    last = m.index! + m[0].length;
  }
  if (last < value.length) out.push({ node: text(value.slice(last)), block: false });
  return out;
}

const blank = (n: Node) => n.type === "break" || (n.type === "text" && !n.value?.trim());

/**
 * A paragraph holding a note embed is split around it — a block can't sit
 * inside a `<p>`: `Intro ![[Note]] outro` becomes a paragraph, the embed and
 * another paragraph. Images and PDF cards stay inline.
 */
function expandParagraph(p: Node, env: Env): Node[] {
  const items: Item[] = [];
  for (const c of p.children ?? []) {
    if (c.type === "text" && c.value?.includes("![[")) items.push(...segments(c.value, env, true));
    else {
      if (c.children && !LITERAL.has(c.type)) walk(c, env, false);
      items.push({ node: c, block: false });
    }
  }
  if (!items.some((i) => i.block)) {
    p.children = items.map((i) => i.node);
    return [p];
  }
  const out: Node[] = [];
  let run: Node[] = [];
  const flush = () => {
    while (run.length && blank(run[0])) run.shift();
    while (run.length && blank(run[run.length - 1])) run.pop();
    if (run.length) out.push({ ...p, children: run });
    run = [];
  };
  for (const i of items) {
    if (i.block) {
      flush();
      out.push(i.node);
    } else run.push(i.node);
  }
  flush();
  return out;
}

/** `blockAllowed`: may a note embed replace a paragraph here (false inside phrasing). */
function walk(parent: Node, env: Env, blockAllowed = true): void {
  const list = parent.children;
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const child = list[i];
    if (LITERAL.has(child.type)) continue;
    // A real paragraph — not a directive's title or a column wrapper, which
    // are paragraphs renamed through `hName`.
    if (blockAllowed && child.type === "paragraph" && !child.data?.hName && child.children?.some((c) => c.type === "text" && c.value?.includes("![["))) {
      const out = expandParagraph(child, env);
      list.splice(i, 1, ...out);
      i += out.length - 1;
      continue;
    }
    if (child.type === "text" && child.value?.includes("![[")) {
      const out = segments(child.value, env, false).map((s) => s.node);
      list.splice(i, 1, ...out);
      i += out.length - 1;
      continue;
    }
    // Children are blocks only in flow containers (and in the paragraphs the
    // columns directive turns into wrapper divs); elsewhere they are phrasing.
    if (child.children) walk(child, env, blockAllowed && (FLOW.has(child.type) || (child.type === "paragraph" && child.data?.hName === "div")));
  }
}
