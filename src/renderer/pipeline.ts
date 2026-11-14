/**
 * The preview pipeline's entry points (plan 8.1).
 *
 * The Markdown → HAST part (./renderCore.ts: unified, remark, rehype, Shiki,
 * KaTeX) runs in the render worker (./render.worker.ts) when there is one,
 * and here, on the main thread, only when there is not (Node, a browser
 * without module workers, a worker that failed). The HAST → React step
 * (./hastToReact.ts) is the part that always runs here.
 *
 * Two synchronous helpers stay on the main thread by design:
 * `renderMarkdownFast` (the first paint before the worker has answered, and
 * the help panel) and `extractToc` (the outline of a short note: a parse,
 * no rendering).
 */
import { pluginForLang, pluginLangsVersion } from "../plugins/runtime/rendererRegistry";
import { headingSlugger } from "../lib/slug";
import { unified } from "unified";
import type { ReactElement } from "react";
import remarkParse from "remark-parse";
import { CALLOUT_KINDS, defaultCalloutTitle, isKnownCallout } from "./remarkObsidian";
import { t } from "../i18n";
import { visit } from "unist-util-visit";
import YAML from "yaml";
import type { Root as MdastRoot } from "mdast";
import type { Root as HastRoot } from "hast";
import { stripCriticDelimiters } from "./criticMarkup";
import type { EmbedContext, EmbedNoticeKind } from "./embeds";
import { buildBlockProcessor, documentVariant, pipelineOptions, renderHast, renderHastFast, setRenderHost } from "./renderCore";
import { hastToReact } from "./hastToReact";
import { renderDocInWorker, renderHoverInWorker, STALE } from "./renderClient";
import type { EmbedData, HostData } from "./renderProtocol";

export { buildBlockProcessor, pipelineOptions };
export type { BlockSlugPlugin } from "./renderCore";

/** A callout's default title: translated for Obsidian's own types, the type itself otherwise. */
function calloutTitle(kind: string, type: string): string {
  return isKnownCallout(type) ? t(`callout.${kind}`) : defaultCalloutTitle(kind, type);
}

// The main thread's host: i18n and the plugin registry, asked at render time.
setRenderHost({ calloutTitle, pluginLang: (lang) => !!pluginForLang(lang) });

const EMBED_NOTICES: EmbedNoticeKind[] = ["notFound", "sectionNotFound", "cycle", "depth"];

/**
 * What a worker request carries in place of i18n and the plugin registry:
 * the callout titles in the active language, the embed notice templates
 * (filled in the worker exactly as `t` fills them, src/i18n/fill.ts) and
 * the plugin languages.
 */
export function hostData(embeds?: EmbedContext): HostData {
  const strings: Record<string, string> = {};
  for (const kind of CALLOUT_KINDS) strings[`callout.${kind}`] = t(`callout.${kind}`);
  // A template is the notice with no variables given: `t` leaves `{name}` as written.
  if (embeds) for (const kind of EMBED_NOTICES) strings[`embed.${kind}`] = embeds.notice(kind, {});
  return { strings, pluginLangs: pluginLangsVersion().split(",").filter(Boolean) };
}

/** An embed context as data for the worker: every path, with the text of the notes it can read. */
function embedData(ctx: EmbedContext): EmbedData {
  return {
    hostPath: ctx.hostPath,
    hostText: ctx.hostText,
    files: ctx.paths.map((path) => ({ path, content: ctx.read(path), modified: ctx.version(path) })),
  };
}

export interface RenderOptions {
  /**
   * Workspace notes and files for `![[embeds]]` (./embeds, built by
   * ./embedContext). Without it an embed renders as a plain wiki link to its
   * target.
   */
  embeds?: EmbedContext;
  /**
   * The preview this render is for, with the version of this render
   * (./renderClient.ts nextVersion): a newer render on the channel makes
   * this one stale, and it rejects with `RenderSuperseded`.
   */
  channel?: { id: string; version: number };
}

/** A render a newer one on its channel replaced: the caller shows the newer one. */
export class RenderSuperseded extends Error {
  constructor() {
    super("render superseded");
    this.name = "RenderSuperseded";
  }
}

/** Where full renders and hover cards ran since load (a test counter, plan 8.1: none here while a worker answers). */
export const renderStats = { worker: 0, mainThread: 0, hoverWorker: 0, hoverMainThread: 0 };

/** Pandoc citations ([@key], @key): expanded from the vault's library (plan W2.16), loaded only when a note has one. */
const CITATION_HINT = /(^|[\s([;\u2014\u2013"\u201C'])-?@[\p{L}\p{N}_]/mu;

export async function renderMarkdown(
  markdownText: string,
  isDark: () => boolean,
  opts: RenderOptions = {},
): Promise<ReactElement> {
  return hastToReact(await renderMarkdownHast(markdownText, isDark, opts));
}

/** `renderMarkdown` up to HAST: in the worker when there is one. */
export async function renderMarkdownHast(markdownText: string, isDark: () => boolean, opts: RenderOptions = {}): Promise<HastRoot> {
  const variant = await documentVariant(markdownText, opts.embeds);
  if (CITATION_HINT.test(markdownText)) {
    markdownText = await import("../citations/expand")
      .then((m) => m.expandWithLibrary(markdownText))
      .then((r) => r.markdown)
      .catch(() => markdownText);
  }
  const fromWorker = await renderDocInWorker({
    type: "render",
    channel: opts.channel?.id ?? null,
    version: opts.channel?.version ?? 0,
    dark: isDark(),
    host: hostData(opts.embeds),
    markdown: markdownText,
    variant,
    embeds: opts.embeds ? embedData(opts.embeds) : undefined,
  });
  if (fromWorker === STALE) throw new RenderSuperseded();
  if (fromWorker) {
    renderStats.worker++;
    for (const p of fromWorker.used) opts.embeds?.used.add(p);
    return fromWorker.hast;
  }
  renderStats.mainThread++;
  return renderHast(markdownText, isDark, opts.embeds, variant);
}

/**
 * Synchronous first-paint render (A7 levers 1 + 3), on the main thread.
 *
 * Same remark tree and heading ids as `renderMarkdown`, minus everything
 * that needs a lazy chunk: no Shiki (code renders as plain `<pre>`), no
 * KaTeX (math shows as its TeX source), no rehype-raw (inline HTML is
 * dropped). Heavy blocks (mermaid, charts, maps…) render through the same
 * `components` map, whose wrappers only fetch their chunk once the block
 * scrolls near the viewport and the browser is idle — so this pass never
 * triggers a vendor import. The preview uses it only until the render
 * worker has answered once (./Preview.tsx).
 */
export function renderMarkdownFast(markdownText: string, opts: { embeds?: EmbedContext } = {}): ReactElement {
  return hastToReact(renderHastFast(markdownText, opts.embeds));
}

/**
 * A hover card (plan 4.6): the part of `content` that `fragment` names (a
 * heading's section, a block, or the start), rendered like the first paint
 * — no Shiki, KaTeX or raw HTML. Cut and rendered in the render worker when
 * there is one (W10.E4), so pointing at a link never blocks typing.
 */
export async function renderHoverCard(content: string, fragment: string | null): Promise<ReactElement> {
  const fromWorker = await renderHoverInWorker({ type: "hover", channel: null, version: 0, dark: false, host: hostData(), content, fragment });
  if (fromWorker && fromWorker !== STALE) {
    renderStats.hoverWorker++;
    return hastToReact(fromWorker);
  }
  renderStats.hoverMainThread++;
  const { previewMarkdown } = await import("./hoverMarkdown");
  return hastToReact(renderHastFast(previewMarkdown(content, fragment)));
}

/** Extract YAML frontmatter (parsed) from a markdown source, or null. */
export function extractFrontmatter(
  markdownText: string,
): Record<string, unknown> | null {
  const m = markdownText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  try {
    const parsed = YAML.parse(m[1]);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Extract heading TOC from markdown (used by Outline panel). */
export function extractToc(
  markdownText: string,
): Array<{ depth: number; text: string; id: string }> {
  const out: Array<{ depth: number; text: string; id: string }> = [];
  // Strip YAML / TOML frontmatter before parsing so it never appears in the
  // heading list (a top-level `---title:…---` block parses as a setext h2
  // when the frontmatter plugin isn't applied).
  // CriticMarkup delimiters are dropped so ids match the rendered
  // headings, whose <ins>/<del>/<mark> text rehype-slug reads.
  const stripped = stripCriticDelimiters(markdownText)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/m, "")
    .replace(/^\+\+\+\r?\n[\s\S]*?\r?\n\+\+\+\r?\n?/m, "");
  const tree = unified().use(remarkParse).parse(stripped) as MdastRoot;
  // One slugger for the whole document, like rehype-slug: a repeated
  // heading gets `-1`, `-2`… and Hebrew keeps its letters (T26).
  const slugger = headingSlugger();
  visit(tree, "heading", (node) => {
    const text = mdToString(node);
    if (!text.trim()) return;
    const id = slugger.slug(text);
    out.push({ depth: node.depth, text, id });
  });
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mdToString(node: any): string {
  if (typeof node?.value === "string") return node.value;
  if (Array.isArray(node?.children))
    return node.children.map(mdToString).join("");
  return "";
}
