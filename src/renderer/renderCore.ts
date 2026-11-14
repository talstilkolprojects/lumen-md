/**
 * The Markdown pipeline up to HAST (plan 8.1).
 *
 * Everything here is plain data in, plain data out: Markdown text goes in,
 * a HAST tree comes out — no React, no DOM, no i18n bundle. That is what
 * lets the same code run in the render worker (./render.worker.ts) and, as
 * the fallback when there is no worker, on the main thread
 * (./pipeline.ts). The tree is turned into React elements on the main
 * thread by ./hastToReact.ts, the only step that needs the components map.
 *
 * What the pipeline needs from the app — translated callout titles, the
 * languages a plugin renders — comes through `RenderHost`, set by whoever
 * runs it: the window sets one that asks i18n and the plugin registry, the
 * worker one that reads the strings and languages each request carries.
 */
import { unified } from "unified";
import type { Processor } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
// rehype-katex (+ katex + mhchem, ~84 KB gz) is dynamically imported via
// ./katexPlugin only for docs that contain `$` — it is no longer a static
// dependency of the main chunk (A7 lever 1/3).
import rehypeSlug from "rehype-slug";
import { visit } from "unist-util-visit";
import type { Root as MdastRoot, Code } from "mdast";
import type { Element, Root as HastRoot } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import { DARK_DATA_KEY, SLUG_PLACEHOLDER } from "./renderProtocol";
import { markdownSyntax } from "./syntax";
import { defaultCalloutTitle, remarkObsidian } from "./remarkObsidian";
import { rehypeDirAuto } from "./rehypeDirAuto";
import { rehypeMathIsolate } from "../lib/mathIsolate";
import { rehypeSanitizeRaw } from "./rehypeSanitizeRaw";
// rehype-raw is dynamically imported in buildFullProcessor() — it pulls in
// parse5 (~275 KB raw / ~40 KB gzipped) and most docs don't need it.
import { rehypeShiki } from "./shiki";
import { rehypeKatexCached } from "./math";
import { prepareCriticMarkup, rehypeCriticMarkup } from "./criticMarkup";
import { boundMarkdown } from "./boundMarkdown";
import { remarkBreaks, remarkWikiLinks, remarkAdmonitions, remarkColumns, remarkStripFrontmatter } from "./remarkLumen";
import { EMBEDS_DATA_KEY, remarkEmbeds } from "./remarkEmbeds";
import { remarkBlockIds } from "./remarkBlockIds";
import type { EmbedContext } from "./embeds";
import { remarkBaseEmbeds } from "../views/bases/embed";

/** What the pipeline asks of the app it runs in. */
export interface RenderHost {
  /** A callout's default title, by its kind and the type written in the note. */
  calloutTitle(kind: string, type: string): string;
  /** Does a plugin render code blocks of this language (plan 11.2)? */
  pluginLang(lang: string): boolean;
}

let host: RenderHost = { calloutTitle: defaultCalloutTitle, pluginLang: () => false };
/** The host of the render running now: the file's own (`HOST_DATA_KEY`), else the default. */
let active: RenderHost = host;

/** Set the default host (the window: i18n + plugin registry). */
export function setRenderHost(next: RenderHost): void {
  host = next;
  active = next;
}

/** vfile data key: a render's own host (the worker passes the request's). */
export const HOST_DATA_KEY = "lumenRenderHost";

/**
 * First transformer of every run: the host for this file. The remark
 * passes that ask it run synchronously after it, so two renders never see
 * each other's host.
 */
function remarkRenderHost() {
  return (_tree: MdastRoot, file: { data: Record<string, unknown> }) => {
    active = (file.data[HOST_DATA_KEY] as RenderHost | undefined) ?? host;
  };
}

export const SPECIAL_LANGS = new Set([
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
  // Government data with a local snapshot (plan W7.6).
  "dataset",
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
        if (active.pluginLang(lang)) {
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

declare module "unified" {
  // The pipeline's result is the HAST tree itself (`hastResult` below).
  interface CompileResultMap {
    HastRoot: HastRoot;
  }
}

/** A processor whose result is the HAST tree itself (no compiler to React or HTML). */
export type HastProcessor = Processor<MdastRoot, MdastRoot, HastRoot, HastRoot, HastRoot>;
type RehypeKatex = typeof import("./katexPlugin").default;

/** The terminal step: the result of `process` is the tree (structured-cloneable, for postMessage). */
function hastResult(this: { compiler?: unknown }) {
  this.compiler = (tree: HastRoot) => tree;
}

/** Parse + the Lumen dialect transforms that run before embeds are expanded. */
function buildDialect() {
  return unified()
    .use(remarkParse)
    .use(remarkRenderHost)
    // Frontmatter, GFM, math and directives: the syntax the conformance suite tests.
    .use(markdownSyntax)
    .use(remarkStripFrontmatter)
    // W1.3 — Obsidian callouts, %%comments%%, ==highlights==, ![[image|300]].
    // Before soft breaks (a callout's title ends at the first line break)
    // and before wiki links (an embed is not a link).
    .use(remarkObsidian, { calloutTitle: (kind: string, type: string) => active.calloutTitle(kind, type) })
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

function toHast(p: ReturnType<typeof buildBase>): HastProcessor {
  return p.use(hastResult) as unknown as HastProcessor;
}

// Full processors, cached per (raw HTML?, math?) combination.
const fullProcessors = new Map<string, HastProcessor>();
let fastProcessor: HastProcessor | null = null;
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

async function getFullProcessor(isDark: () => boolean, opts: { raw: boolean; math: boolean }): Promise<HastProcessor> {
  const key = `${opts.raw ? 1 : 0}${opts.math ? 1 : 0}`;
  const cached = fullProcessors.get(key);
  if (cached) return cached;
  const proc = await buildFullProcessor(isDark, opts);
  fullProcessors.set(key, proc);
  return proc;
}

/** A rehype transformer that gives the headings of one block their ids (./incrementalPreview.ts). */
export type BlockSlugPlugin = () => (tree: HastRoot, file?: { data: Record<string, unknown> }) => void;

/**
 * `tree` without source positions: a block's positions are relative to the
 * block, nothing renders them, and a long note keeps thousands of blocks
 * (less to clone through postMessage and to keep).
 */
export function withoutPositions<T extends HastRoot>(tree: T): T {
  visit(tree, (node) => {
    delete (node as { position?: unknown }).position;
  });
  return tree;
}

/** vfile data key: the heading texts `blockSlugs` recorded, in order. */
export const SLUG_TEXTS_KEY = "lumenSlugTexts";

/**
 * rehype-slug's rule for one block of a long document (headings that
 * already have an id are skipped), with the ids left as placeholders
 * (`SLUG_PLACEHOLDER` + index) and the heading texts recorded in the
 * file's data (`SLUG_TEXTS_KEY`): the window numbers them with the
 * document's slugger, so a repeated heading in a later block still gets
 * `-1` (./incrementalPreview.ts). The texts are read where rehype-slug
 * reads them — before KaTeX and Shiki.
 */
export const blockSlugs: BlockSlugPlugin = () => (tree: HastRoot, file?: { data: Record<string, unknown> }) => {
  const texts: string[] = [];
  if (file) file.data[SLUG_TEXTS_KEY] = texts;
  visit(tree, "element", (node: Element) => {
    if (!/^h[1-6]$/.test(node.tagName)) return;
    const props = (node.properties ??= {});
    if (props.id) return;
    props.id = SLUG_PLACEHOLDER + texts.length;
    texts.push(hastToString(node));
  });
};

async function buildFullProcessor(
  isDark: () => boolean,
  opts: { raw: boolean; math: boolean },
  blockSlugs?: BlockSlugPlugin,
): Promise<HastProcessor> {
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
  // Plan 8.1 step 2: rehype-katex runs once per distinct formula (./math.ts).
  if (rehypeKatex) p = p.use(rehypeKatexCached(rehypeKatex)).use(rehypeMathIsolate);
  return toHast(p.use(rehypeShiki, { isDark }));
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
): Promise<HastProcessor> {
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

/** The vfile input: the prepared source, plus the embed context for remarkEmbeds. */
function input(markdownText: string, embeds?: EmbedContext, renderHost?: RenderHost, dark?: boolean) {
  const data: Record<string, unknown> = {};
  if (dark !== undefined) data[DARK_DATA_KEY] = dark;
  if (embeds) data[EMBEDS_DATA_KEY] = embeds;
  if (renderHost) data[HOST_DATA_KEY] = renderHost;
  // A block that would take seconds to parse (plan W4.16) is shown as raw text.
  return { value: prepareCriticMarkup(boundMarkdown(markdownText)), data };
}

/**
 * The full render of `markdownText` as HAST: Shiki, KaTeX and rehype-raw
 * loaded when the text (or a note it embeds) needs them. Citations are
 * expanded by the caller (they need the vault's library).
 */
export async function renderHast(markdownText: string, isDark: () => boolean, embeds?: EmbedContext, variant?: Variant, renderHost?: RenderHost): Promise<HastRoot> {
  const proc = await getFullProcessor(isDark, variant ?? (await documentVariant(markdownText, embeds)));
  const file = await proc.process(input(markdownText, embeds, renderHost, isDark()));
  return file.result as HastRoot;
}

/** Which lazy parts the full pipeline needs: rehype-raw / KaTeX, if the note or a note it embeds needs them. */
export type Variant = { raw: boolean; math: boolean };

export async function documentVariant(markdownText: string, embeds?: EmbedContext): Promise<Variant> {
  // An embedded note's inline HTML / math needs the same passes the host
  // would get for it: the sanitizer runs over embedded HTML exactly as over
  // the host's own.
  const sources = embeds ? [markdownText, ...(await import("./embeds")).embeddedTexts(markdownText, embeds)] : [markdownText];
  const each = sources.map(pipelineOptions);
  return { raw: each.some((o) => o.raw), math: each.some((o) => o.math) };
}

/**
 * Synchronous first-paint render as HAST (A7 levers 1 + 3): the same remark
 * tree and heading ids as `renderHast`, minus everything that needs a lazy
 * chunk — no Shiki, no KaTeX, no rehype-raw.
 */
export function renderHastFast(markdownText: string, embeds?: EmbedContext, renderHost?: RenderHost): HastRoot {
  fastProcessor ??= toHast(buildBase().use(rehypeCriticMarkup).use(rehypeSlug).use(rehypeDirAuto));
  return fastProcessor.processSync(input(markdownText, embeds, renderHost)).result as HastRoot;
}
