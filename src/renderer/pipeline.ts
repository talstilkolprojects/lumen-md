import { pluginForLang } from "../plugins/runtime/rendererRegistry";
import { headingSlugger } from "../lib/slug";
import { unified } from "unified";
import type { Processor } from "unified";
import type { ReactElement } from "react";
import remarkParse from "remark-parse";
import { markdownSyntax } from "./syntax";
import { defaultCalloutTitle, isKnownCallout, remarkObsidian } from "./remarkObsidian";
import { t } from "../i18n";
import remarkRehype from "remark-rehype";
// rehype-katex (+ katex + mhchem, ~84 KB gz) is dynamically imported via
// ./katexPlugin only for docs that contain `$` — it is no longer a static
// dependency of the main chunk (A7 lever 1/3).
import rehypeSlug from "rehype-slug";
import { rehypeDirAuto } from "./rehypeDirAuto";
import { rehypeMathIsolate } from "../lib/mathIsolate";
import { rehypeSanitizeRaw } from "./rehypeSanitizeRaw";
// rehype-raw is dynamically imported in getProcessorWithRaw() — it
// pulls in parse5 (~275 KB raw / ~40 KB gzipped) and most docs don't
// need it. Splitting it out of the main bundle is M12-followup-2.
import rehypeReact from "rehype-react";
import { visit } from "unist-util-visit";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import YAML from "yaml";
import type { Root as MdastRoot, Code } from "mdast";
import type { Root as HastRoot } from "hast";
import { components } from "./components";
import { rehypeShiki } from "./shiki";
import { prepareCriticMarkup, rehypeCriticMarkup, stripCriticDelimiters } from "./criticMarkup";
import { boundMarkdown } from "./boundMarkdown";
import {
  remarkBreaks,
  remarkWikiLinks,
  remarkAdmonitions,
  remarkColumns,
  remarkStripFrontmatter,
} from "./remarkLumen";
import { EMBEDS_DATA_KEY, remarkEmbeds } from "./remarkEmbeds";
import { remarkBlockIds } from "./remarkBlockIds";
import type { EmbedContext } from "./embeds";
import { remarkBaseEmbeds } from "../views/bases/embed";

const SPECIAL_LANGS = new Set([
  "mermaid",
  "chart",
  "csv",
  "tsv",
  "json-table",
  "insights",
  "jsonl",
  "code-doctor",
  "fix-json",
  // Tabular conversions — share the DataBlock renderer.
  "sql",
  "pandas",
  "object",
  "data",
  "map",
  "geojson",
  "dot",
  "graphviz",
  "abc",
  "model",
  "plantuml",
  "puml",
  "embed",
  "htmlpreview",
  "html-preview",
  "bibtex",
  "bib",
  // obsidian-tasks queries over the vault (plan 4.13).
  "tasks",
  "database",
  "base",
  // Embedded queries and Dataview blocks (plan W2.12).
  "query",
  "dataview",
  // Single-language live previews — render the snippet inside a tiny
  // sandboxed iframe so users can experiment with HTML/CSS/JS/GLSL/SVG
  // without writing the full boilerplate of an `htmlpreview` block.
  "live-css",
  "css-live",
  "live-js",
  "js-live",
  "live-svg",
  "svg-live",
  "svg",
  "live-glsl",
  "glsl-live",
  "glsl",
  "shader",
  // Live Python via Pyodide (WASM, lazy-loaded on Run).
  "live-python",
  "python-live",
  "live-py",
  "py-live",
  // Live SQL via sql.js / SQLite (WASM, lazy-loaded on Run).
  "live-sql",
  "sql-live",
  // Live Lua via wasmoon (Lua 5.4 WASM in a Worker, lazy-loaded on Run).
  "live-lua",
  "lua-live",
  // Live R via webR (R in WASM, self-hosted under /webr/, loaded on Run).
  "live-r",
  "r-live",
  // Live Ruby via ruby.wasm (CRuby in WASI, in a Worker, loaded on Run).
  "live-ruby",
  "ruby-live",
  // Web Playground: multi-file HTML / CSS / JS / JSX / TS (+ React / Vue).
  "playground",
  "web-playground",
  // Plain `html` fence as alias for `html-preview` — Lumen treats a raw
  // HTML fence as "render this HTML safely in a sanitized preview" rather
  // than a syntax-highlighted code block. Matches the dynamic-blocks-
  // hardening contract: any HTML the user types must round-trip through
  // markupSanitizer before it touches the DOM.
  "html",
]);

/**
 * remark plugin: transform code blocks with special langs into custom hast nodes.
 * The block source becomes the text child so React components receive it as `children`.
 */
function remarkLumenBlocks() {
  return (tree: MdastRoot) => {
    visit(tree, "code", (node: Code) => {
      const lang = (node.lang ?? "").toLowerCase();
      if (!SPECIAL_LANGS.has(lang)) {
        // A language a plugin renders (plan 11.2): one tag, the plugin is found by language.
        if (pluginForLang(lang)) {
          const d = (node.data ?? (node.data = {})) as Record<string, unknown>;
          d.hName = "lumen-pluginblock";
          d.hProperties = { lang, meta: node.meta ?? "" };
          d.hChildren = [{ type: "text", value: node.value ?? "" }];
        }
        return;
      }
      // Aliases.
      let tag: string;
      if (lang === "json-table") tag = "lumen-jsontable";
      else if (lang === "insights" || lang === "jsonl") tag = "lumen-insights";
      else if (lang === "code-doctor" || lang === "fix-json") tag = "lumen-code-doctor";
      else if (lang === "graphviz") tag = "lumen-dot";
      else if (lang === "puml") tag = "lumen-plantuml";
      else if (lang === "html-preview" || lang === "htmlpreview" || lang === "html")
        tag = "lumen-htmlpreview";
      else if (lang === "bib") tag = "lumen-bibtex";
      // Tabular conversions all share the DataBlock component, with `lang`
      // forwarded as a prop so it picks the right parser.
      else if (lang === "sql" || lang === "pandas" || lang === "object" || lang === "data")
        tag = "lumen-data";
      // Live web-language blocks — fold short / long names into a
      // single tag so React mounts the right component regardless of
      // which spelling the user picked.
      else if (lang === "live-css" || lang === "css-live") tag = "lumen-livecss";
      else if (lang === "live-js" || lang === "js-live") tag = "lumen-livejs";
      else if (lang === "live-svg" || lang === "svg-live" || lang === "svg") tag = "lumen-livesvg";
      else if (lang === "live-glsl" || lang === "glsl-live" || lang === "glsl" || lang === "shader")
        tag = "lumen-liveglsl";
      else if (lang === "live-python" || lang === "python-live" || lang === "live-py" || lang === "py-live")
        tag = "lumen-livepython";
      else if (lang === "live-sql" || lang === "sql-live") tag = "lumen-livesql";
      else if (lang === "live-lua" || lang === "lua-live") tag = "lumen-livelua";
      else if (lang === "live-r" || lang === "r-live") tag = "lumen-liver";
      else if (lang === "live-ruby" || lang === "ruby-live") tag = "lumen-liveruby";
      else if (lang === "playground" || lang === "web-playground") tag = "lumen-playground";
      else tag = `lumen-${lang}`;
      const data = (node.data ?? (node.data = {})) as Record<string, unknown>;
      data.hName = tag;
      data.hProperties = { lang, meta: node.meta ?? "" };
      data.hChildren = [{ type: "text", value: node.value ?? "" }];
    });
  };
}

type LumenProcessor = Processor<MdastRoot, MdastRoot, HastRoot, HastRoot, ReactElement>;
type RehypeKatex = typeof import("./katexPlugin").default;

/** Parse + the Lumen dialect transforms that run before embeds are expanded. */
function buildDialect() {
/** A callout's default title: translated for Obsidian's own types, the type itself otherwise. */
function calloutTitle(kind: string, type: string): string {
  return isKnownCallout(type) ? t(`callout.${kind}`) : defaultCalloutTitle(kind, type);
}

  return unified()
    .use(remarkParse)
    // Frontmatter, GFM, math and directives: the syntax the conformance suite tests.
    .use(markdownSyntax)
    .use(remarkStripFrontmatter)
    // W1.3 — Obsidian callouts, %%comments%%, ==highlights==, ![[image|300]].
    // Before soft breaks (a callout's title ends at the first line break)
    // and before wiki links (an embed is not a link).
    .use(remarkObsidian, { calloutTitle })
    .use(remarkBreaks)
    .use(remarkAdmonitions)
    .use(remarkColumns)
    // ![[x.base]] becomes a base block before note embeds are expanded (Obsidian Bases).
    .use(remarkBaseEmbeds);
}

let embedParser: ReturnType<typeof buildDialect> | null = null;

/**
 * An embedded note's mdast (`![[note]]`, see ./embeds): the same parser
 * and dialect transforms as the host, CriticMarkup prepared the same way;
 * the host's remaining passes then run over the spliced-in nodes.
 */
function parseEmbeddedNote(markdown: string): MdastRoot {
  embedParser ??= buildDialect();
  return embedParser.runSync(embedParser.parse(prepareCriticMarkup(markdown))) as MdastRoot;
}

function buildBase() {
  return buildDialect()
    .use(remarkEmbeds, { parse: parseEmbeddedNote })
    // After embeds: an embedded block's own marker is gone by then, the rest get ids.
    .use(remarkBlockIds)
    .use(remarkWikiLinks)
    .use(remarkLumenBlocks)
    .use(remarkRehype, { allowDangerousHtml: true });
}

function toReact(p: ReturnType<typeof buildBase>): LumenProcessor {
  return p.use(rehypeReact, {
    Fragment,
    jsx,
    jsxs,
    components,
  } as unknown as Parameters<typeof rehypeReact>[0]) as unknown as LumenProcessor;
}

// Full processors, cached per (raw HTML?, math?) combination.
const fullProcessors = new Map<string, LumenProcessor>();
let fastProcessor: LumenProcessor | null = null;
let katexPromise: Promise<RehypeKatex> | null = null;

function loadKatex(): Promise<RehypeKatex> {
  if (!katexPromise) {
    katexPromise = import("./katexPlugin").then((m) => m.default);
    katexPromise.catch(() => {
      katexPromise = null; // allow a retry after a failed chunk fetch
    });
  }
  return katexPromise;
}

async function getFullProcessor(
  isDark: () => boolean,
  opts: { raw: boolean; math: boolean },
): Promise<LumenProcessor> {
  const key = `${opts.raw ? 1 : 0}${opts.math ? 1 : 0}`;
  const cached = fullProcessors.get(key);
  if (cached) return cached;
  const proc = await buildFullProcessor(isDark, opts);
  fullProcessors.set(key, proc);
  return proc;
}

/** A rehype transformer that gives the headings of one block their ids (./incrementalPreview.ts). */
export type BlockSlugPlugin = () => (tree: HastRoot) => void;

async function buildFullProcessor(
  isDark: () => boolean,
  opts: { raw: boolean; math: boolean },
  blockSlugs?: BlockSlugPlugin,
): Promise<LumenProcessor> {
  // rehype-raw pulls in parse5 (~40 KB gz); only docs with inline HTML
  // pay for it (M12-followup-2).
  const [rehypeRaw, rehypeKatex] = await Promise.all([
    opts.raw ? import("rehype-raw").then((m) => m.default) : null,
    opts.math ? loadKatex() : null,
  ]);
  let p = buildBase();
  // Inline HTML goes through the allowlist sanitizer right after parsing (T48).
  if (rehypeRaw) p = p.use(rehypeRaw).use(rehypeSanitizeRaw);
  // CriticMarkup (suggesting mode) → <ins>/<del>/<mark>; before rehypeSlug
  // so heading ids are computed from the rendered text.
  p = p.use(rehypeCriticMarkup);
  p = blockSlugs ? p.use(blockSlugs) : p.use(rehypeSlug);
  p = p.use(rehypeDirAuto);
  // W5.14 — each formula an LTR isolate, so it keeps its order inside Hebrew.
  if (rehypeKatex) p = p.use(rehypeKatex).use(rehypeMathIsolate);
  return toReact(p.use(rehypeShiki, { isDark }));
}

/**
 * The full pipeline for rendering a long document block by block
 * (./incrementalPreview.ts): one processor per document, whose heading
 * ids come from `blockSlugs` in place of rehype-slug.
 */
export function buildBlockProcessor(
  isDark: () => boolean,
  opts: { raw: boolean; math: boolean },
  blockSlugs: BlockSlugPlugin,
): Promise<LumenProcessor> {
  return buildFullProcessor(isDark, opts, blockSlugs);
}

/** Which lazy parts (rehype-raw, KaTeX) the full pipeline needs for `source`. */
export function pipelineOptions(source: string): { raw: boolean; math: boolean } {
  return { raw: hasRawHtml(source), math: hasMath(source) };
}

/**
 * Cheap detection: does the markdown source contain anything that
 * looks like raw HTML? Matches `<tag`, `</tag`, `<!--`. Doesn't try to
 * be strict about code-fence boundaries — a false positive just means
 * we load the bigger pipeline once for that doc, never a correctness
 * issue.
 */
function hasRawHtml(source: string): boolean {
  return /<[a-zA-Z!/]/.test(source);
}

/** remark-math only recognises `$…$` / `$$…$$`; no `$` → no KaTeX. */
function hasMath(source: string): boolean {
  return source.includes("$");
}

export interface RenderOptions {
  /**
   * Workspace notes and files for `![[embeds]]` (./embeds, built by
   * ./embedContext). Without it an embed renders as a plain wiki link to its
   * target.
   */
  embeds?: EmbedContext;
}

/** The vfile input: the prepared source, plus the embed context for remarkEmbeds. */
function input(markdownText: string, opts: RenderOptions) {
  const data: Record<string, unknown> = {};
  if (opts.embeds) data[EMBEDS_DATA_KEY] = opts.embeds;
  // A block that would take seconds to parse (plan W4.16) is shown as raw text.
  return { value: prepareCriticMarkup(boundMarkdown(markdownText)), data };
}

/** Pandoc citations ([@key], @key): expanded from the vault's library (plan W2.16), loaded only when a note has one. */
const CITATION_HINT = /(^|[\s([;\u2014\u2013"\u201C'])-?@[\p{L}\p{N}_]/mu;

export async function renderMarkdown(
  markdownText: string,
  isDark: () => boolean,
  opts: RenderOptions = {},
): Promise<ReactElement> {
  // An embedded note's inline HTML / math needs the same passes the host
  // would get for it: the sanitizer runs over embedded HTML exactly as over
  // the host's own.
  const sources = opts.embeds
    ? [markdownText, ...(await import("./embeds")).embeddedTexts(markdownText, opts.embeds)]
    : [markdownText];
  const each = sources.map(pipelineOptions);
  if (CITATION_HINT.test(markdownText)) {
    markdownText = await import("../citations/expand")
      .then((m) => m.expandWithLibrary(markdownText))
      .then((r) => r.markdown)
      .catch(() => markdownText);
  }
  const proc = await getFullProcessor(isDark, {
    raw: each.some((o) => o.raw),
    math: each.some((o) => o.math),
  });
  const file = await proc.process(input(markdownText, opts));
  return file.result as ReactElement;
}

/**
 * Synchronous first-paint render (A7 levers 1 + 3).
 *
 * Same remark tree and heading ids as `renderMarkdown`, minus everything
 * that needs a lazy chunk: no Shiki (code renders as plain `<pre>`), no
 * KaTeX (math shows as its TeX source), no rehype-raw (inline HTML is
 * dropped). Heavy blocks (mermaid, charts, maps…) render through the same
 * `components` map, whose wrappers only fetch their chunk once the block
 * scrolls near the viewport and the browser is idle — so this pass never
 * triggers a vendor import.
 */
export function renderMarkdownFast(markdownText: string, opts: RenderOptions = {}): ReactElement {
  if (!fastProcessor) {
    fastProcessor = toReact(buildBase().use(rehypeCriticMarkup).use(rehypeSlug).use(rehypeDirAuto));
  }
  return fastProcessor.processSync(input(markdownText, opts)).result as ReactElement;
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
