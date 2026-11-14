/**
 * Hover preview of a wiki link (plan 4.6): pointing at — or focusing —
 * `[[Note]]` in the preview, or in the source editor, shows the first 20
 * lines of the note rendered (`[[Note#Heading]]`: from that heading;
 * `[[Note#^id]]`: that block). Loaded on the first hover, never at startup.
 *
 * The rendered card is cached per note version (path + modified time), so
 * pointing at the same link again shows it at once.
 */

import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import { renderMarkdownFast } from "./pipeline";
import { resolveWikiTarget, splitWikiTarget } from "./wikiLinks";
import { ensureIndex, indexedFiles } from "../storage/workspaceIndex";
import { isOPFSAvailable } from "../storage/workspace";
import { headingSlugger, wikiFragmentId } from "../lib/slug";
import { noteHeadingLines } from "../lint/vaultDoctor";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import { remarkBlockIds } from "./remarkBlockIds";
import { t } from "../i18n";

/** How many lines of the note the card shows. */
export const PREVIEW_LINES = 20;

const stripFrontmatter = (text: string) => text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");

/** The part of a note a link points at, as Markdown: a heading's section, a block, or the start — at most 20 lines. */
export function previewMarkdown(text: string, fragment: string | null): string {
  const body = stripFrontmatter(text);
  const lines = body.split(/\r?\n/);
  let from = 0;
  if (fragment?.startsWith("^")) {
    const range = blockRange(body, fragment.slice(1));
    if (range) return body.slice(range[0], range[1]).split(/\r?\n/).slice(0, PREVIEW_LINES).join("\n");
  } else if (fragment) {
    // The heading whose slug (numbered like the preview's) is the fragment's.
    // Its line comes from the same parse (code, quotes, HTML: as the preview sees them).
    const want = wikiFragmentId(fragment);
    const slugger = headingSlugger();
    const hit = noteHeadingLines(body).find((h) => slugger.slug(h.text) === want);
    if (hit) from = hit.line;
  }
  return lines.slice(from, from + PREVIEW_LINES).join("\n");
}

let blockParser: ReturnType<typeof buildBlockParser> | null = null;
function buildBlockParser() {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDirective).use(remarkBlockIds);
}

interface MdNode {
  type: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Where the block `^id` names is in the text: the node the renderer's own
 * remarkBlockIds gives the id (code is skipped, a list item is just that
 * item, a `^id` line of its own names the block before it).
 */
function blockRange(text: string, id: string): [number, number] | null {
  blockParser ??= buildBlockParser();
  const tree = blockParser.runSync(blockParser.parse(text)) as unknown as MdNode;
  const want = `^${id}`;
  const find = (n: MdNode): MdNode | null => {
    if (n.data?.hProperties?.id === want) return n.type === "lumenBlockRef" ? (n.children?.[0] ?? null) : n;
    for (const c of n.children ?? []) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  const node = find(tree);
  const from = node?.position?.start.offset;
  const to = node?.position?.end.offset;
  return from === undefined || to === undefined ? null : [from, to];
}

const cache = new Map<string, ReactElement>();

/** The note a wiki target names, from the workspace index. */
async function noteFor(target: string): Promise<{ path: string; content: string; modified: number; fragment: string | null } | null> {
  if (!isOPFSAvailable()) return null;
  const { note, heading } = splitWikiTarget(target);
  if (!note) return null;
  // A note saved since the last look is refreshed first (cheap when nothing changed).
  await ensureIndex().catch(() => undefined);
  const files = indexedFiles();
  const path = resolveWikiTarget(note, files.map((f) => f.path));
  const file = path ? files.find((f) => f.path === path) : undefined;
  return file ? { path: file.path, content: file.content, modified: file.modified, fragment: heading } : null;
}

/** The rendered card for a target, or null for a note that isn't in the vault. */
export async function renderPreview(target: string): Promise<ReactElement | null> {
  const n = await noteFor(target);
  if (!n) return null;
  const key = `${n.path}\u0000${n.modified}\u0000${n.fragment ?? ""}\u0000${n.content.length}`;
  let el = cache.get(key);
  if (!el) {
    el = renderMarkdownFast(previewMarkdown(n.content, n.fragment));
    if (cache.size > 50) cache.delete(cache.keys().next().value as string);
    cache.set(key, el);
  }
  return el;
}

let seq = 0;

/**
 * One floating card at a time. `show` places it under `anchor` and renders
 * `target` into it; `hide` takes it away. The anchor is described by the
 * card (aria-describedby) while it shows.
 */
export class HoverCard {
  readonly el: HTMLDivElement;
  private root: Root;
  private anchor: Element | null = null;
  private run = 0;
  /** Milliseconds from `show` to the rendered card (the 150 ms target). */
  lastMs = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "lumen-hover-card";
    this.el.id = `lumen-hover-card-${++seq}`;
    this.el.setAttribute("role", "tooltip");
    this.el.dataset.show = "false";
    this.el.dataset.testid = "hover-preview";
    document.body.appendChild(this.el);
    this.root = createRoot(this.el);
  }

  get visible(): boolean {
    return this.el.dataset.show === "true";
  }

  async show(anchor: Element, target: string): Promise<void> {
    const run = ++this.run;
    const started = performance.now();
    const el = await renderPreview(target).catch(() => null);
    if (run !== this.run) return;
    this.anchor?.removeAttribute("aria-describedby");
    this.anchor = anchor;
    this.root.render(el ?? <div className="lumen-hover-card-empty">{t("hover.notFound", { target: splitWikiTarget(target).note })}</div>);
    this.el.dataset.show = "true";
    anchor.setAttribute("aria-describedby", this.el.id);
    this.place(anchor);
    this.lastMs = performance.now() - started;
    this.el.dataset.ms = this.lastMs.toFixed(1);
  }

  hide(): void {
    this.run++;
    if (!this.visible) return;
    this.el.dataset.show = "false";
    this.anchor?.removeAttribute("aria-describedby");
    this.anchor = null;
  }

  /** Under the link, kept inside the window. */
  place(anchor: Element): void {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(420, window.innerWidth - 16);
    const rtl = getComputedStyle(anchor).direction === "rtl";
    const left = rtl ? r.right - w : r.left;
    this.el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
    const below = r.bottom + 6;
    const height = this.el.offsetHeight || 240;
    this.el.style.top = `${below + height > window.innerHeight && r.top - height - 6 > 0 ? r.top - height - 6 : below}px`;
  }

  contains(node: Node | null): boolean {
    return !!node && this.el.contains(node);
  }

  destroy(): void {
    this.run++;
    this.anchor?.removeAttribute("aria-describedby");
    const root = this.root;
    setTimeout(() => root.unmount(), 0);
    this.el.remove();
  }
}

let shared: HoverCard | null = null;
/** The page's one card; Escape anywhere, or leaving the card, hides it. */
export function hoverCard(): HoverCard {
  if (!shared) {
    const card = (shared = new HoverCard());
    document.addEventListener("keydown", (e) => e.key === "Escape" && card.hide(), true);
    card.el.addEventListener("mouseleave", () => card.hide());
  }
  return shared;
}

/** Render a card's content into `dom` (the source editor's tooltip); returns the cleanup. */
export function mountPreview(dom: HTMLElement, el: ReactElement): () => void {
  const root = createRoot(dom);
  root.render(el);
  return () => setTimeout(() => root.unmount(), 0);
}
