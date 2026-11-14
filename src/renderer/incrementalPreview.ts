/**
 * The preview of a long document, rendered block by block (plan 8.4).
 *
 * The full pipeline turns the whole document into one React tree; for a
 * 2 MB note that is seconds of main thread on every pause in typing. Here
 * the document is split into top-level blocks (./blocks.ts) and each block
 * goes through the same pipeline on its own. After an edit only the
 * changed blocks are rendered again; the others keep their React element —
 * the same object, so React skips them entirely. Rendering yields to the
 * browser every few milliseconds, so even the first render of a long note
 * never holds a frame.
 *
 * What a block cannot render on its own falls back to the full pipeline
 * (`canRenderInBlocks`): footnotes and reference definitions (they reach
 * across the document) and CriticMarkup. Heading ids are numbered across
 * blocks with the document's slugger, so they match the full render.
 */

import { Fragment, jsx } from "react/jsx-runtime";
import type { ReactElement } from "react";
import type { Element, Root as HastRoot } from "hast";
import { visit } from "unist-util-visit";
import { headingSlugger } from "../lib/slug";
import { mayContainCriticMarkup } from "../editor/suggesting";
import { BlockTracker } from "./blocks";
import { prepareCriticMarkup } from "./criticMarkup";
import { asRawText, boundMarkdown } from "./boundMarkdown";
import { blockSlugs, buildBlockProcessor, pipelineOptions, SLUG_TEXTS_KEY, withoutPositions, type HastProcessor } from "./renderCore";
import { hastToReact } from "./hastToReact";
import { hostData } from "./pipeline";
import { nextVersion, renderBlockInWorker, STALE } from "./renderClient";
import { DARK_DATA_KEY, SLUG_PLACEHOLDER } from "./renderProtocol";
import { blockAt, estimateBlockHeight, firstScreen, RenderQueue } from "./viewport";

/** A block whose render takes longer than this is shown as raw text on its next render (plan W4.16). */
export const BLOCK_DEADLINE_MS = 200;

/** Footnotes, reference definitions and CriticMarkup need the whole document. */
export function canRenderInBlocks(markdown: string): boolean {
  // Examples inside code (`[^1]` in a fence, a `[label]: x` code span) are not Markdown.
  const text = withoutCode(markdown);
  if (mayContainCriticMarkup(text)) return false;
  if (/\[\^[^\]\s]+\]/.test(text)) return false;
  return !hasDefinitionLine(text);
}

/**
 * A line that may hold a reference definition (`[label]: …`), at top level
 * or after quote / list-item prefixes (a definition counts document-wide
 * from inside them too). A linear scan: regexes over nested prefixes
 * backtrack badly on long whitespace runs.
 */
function hasDefinitionLine(text: string): boolean {
  if (!text.includes("]:")) return false;
  for (const line of text.split("\n")) {
    if (!line.includes("]:")) continue;
    // The label ends at the first unescaped `]` (`[a\]b]: /url`).
    if (/^\[(?:\\.|[^\]\\])+\]:/.test(line.slice(containerPrefix(line)))) return true;
  }
  return false;
}

/**
 * Length of `line`'s container prefix: indentation, `>` quote markers and
 * list markers, in any nesting. A linear scan: regexes over nested
 * prefixes backtrack badly on long whitespace runs.
 */
function containerPrefix(line: string): number {
  let i = 0;
  for (;;) {
    while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === ">")) i++;
    const marker = /^(?:[-+*]|\d{1,9}[.)])[ \t]/.exec(line.slice(i, i + 11));
    if (!marker) return i;
    i += marker[0].length;
  }
}

/**
 * `markdown` without what Markdown never reads as syntax: fenced and
 * indented code, code spans, HTML comments (an approximation that only
 * ever removes such regions).
 */
export function withoutCode(markdown: string): string {
  if (!/`|~~~|<!--|(?:^|\n)(?: {4}|\t)/.test(markdown)) return markdown;
  const out: string[] = [];
  /** An open fence: its marker and the column it started at (inside a list item or quote: > 0). */
  let fence: { marker: string; column: number } | null = null;
  for (const line of markdown.split("\n")) {
    // A fence may follow list markers and `>` (nested in a list item or a quote).
    const at = containerPrefix(line);
    // Without a container, 4+ spaces make it indented code, not a fence.
    const bare = /^[ \t]*$/.test(line.slice(0, at));
    const f = bare && at > 3 ? null : /^(`{3,}|~{3,})/.exec(line.slice(at));
    const m = f ? ([line.slice(0, at) + f[1], line.slice(0, at), f[1]] as const) : null;
    if (fence) {
      const closes =
        m && m[2][0] === fence.marker[0] && m[2].length >= fence.marker.length && /^[`~]+[ \t]*\r?$/.test(line.slice(m[1].length));
      // A nested fence also ends when its list item or quote does.
      const left = fence.column > 0 && line.trim() !== "" && !/^[ \t]*>/.test(line) && /^[ \t]*/.exec(line)![0].length < fence.column;
      if (closes) {
        fence = null;
        continue;
      }
      if (!left) continue;
      fence = null;
    }
    if (m && !(m[2][0] === "`" && line.slice(m[0].length).includes("`"))) {
      fence = { marker: m[2], column: m[1].length };
      continue;
    }
    out.push(line);
  }
  // Code spans may cross lines, not paragraphs. Indented code is a chunk
  // of 4-space lines at the start or after a chunk that is neither a list
  // nor indented (so never list-item content).
  const chunks = out.join("\n").split(/(\n[ \t]*\n)/);
  let prev = "";
  const kept = chunks.map((chunk, i) => {
    if (i % 2) return chunk; // a separator
    const indentedCode =
      chunk.split("\n").every((l) => /^(?: {4}|\t)/.test(l)) && !/^(?:[ \t]|[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/.test(prev);
    prev = chunk;
    return indentedCode ? "" : chunk.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, "");
  });
  // HTML comments are opaque too.
  return kept.join("").replace(/<!--[\s\S]*?-->/g, "");
}

interface Rendered {
  text: string;
  /** React key: stable for as long as this block is kept. */
  key: string;
  /** The block's tree, heading ids still placeholders: kept only for a block with headings (to re-number them). */
  hast: HastRoot | null;
  /** The heading texts this block gives to the slugger, in order. */
  slugTexts: string[];
  /** The ids the headings got in the element below. */
  ids: string[];
  element: ReactElement;
}

/** Options of one render: viewport-first order (plan 8.1 step 3). */
export interface RenderPass {
  /** The character the reader looks at: its block and a screen after it render first (default 0). */
  focusOffset?: number;
  /** How much of the preview the first screen covers, in px (default 1200). */
  viewportPx?: number;
  /** Called with the preview so far (pending blocks as placeholders) while the rest renders. */
  onPartial?: (el: ReactElement) => void;
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));
/** The rest of the note renders when the browser is idle. */
const yieldIdle = () =>
  new Promise<void>((r) => {
    const w = typeof window !== "undefined" ? window : undefined;
    if (w && typeof w.requestIdleCallback === "function") w.requestIdleCallback(() => r(), { timeout: 200 });
    else setTimeout(r, 0);
  });
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** `tree` with its placeholder heading ids replaced by `ids` (a copy; the kept tree keeps its placeholders). */
function withIds(tree: HastRoot, ids: string[]): HastRoot {
  if (!ids.length) return tree;
  const copy = structuredClone(tree);
  visit(copy, "element", (node: Element) => {
    const id = node.properties?.id;
    if (typeof id === "string" && id.startsWith(SLUG_PLACEHOLDER)) node.properties.id = ids[Number(id.slice(SLUG_PLACEHOLDER.length))];
  });
  return copy;
}

let previews = 0;

export class IncrementalPreview {
  private readonly tracker = new BlockTracker({ preview: true });
  private values: (Rendered | null)[] = [];
  private variant = "";
  private nextKey = 0;
  private running: Promise<unknown> = Promise.resolve();
  /** The worker channel of this preview: a newer render makes the older one's requests stale. */
  private readonly channel = `inc${++previews}`;
  /** Main-thread fallback (no render worker): one processor per document variant. */
  private processor: { variant: string; proc: Promise<HastProcessor> } | null = null;
  /** Pending blocks the reader scrolled to: they render next. */
  private readonly jump = new Set<number>();
  private pendingCount = 0;
  /** Blocks rendered since this preview was created (a test counter). */
  rendered = 0;
  /** Blocks rendered in the render worker (a test counter). */
  renderedInWorker = 0;
  /** Block texts whose render took longer than BLOCK_DEADLINE_MS: raw text from then on (plan W4.16). */
  readonly slowBlocks = new Set<string>();

  /** How many blocks of the render in progress are still placeholders. */
  get pending(): number {
    return this.pendingCount;
  }

  /** The reader scrolled to these pending blocks (their placeholders' `data-lumen-pending`): render them next. */
  prioritize(indices: Iterable<number>): void {
    for (const i of indices) this.jump.add(i);
  }

  /**
   * The preview of `markdown`, or null when `isStale()` turned true while
   * rendering (a newer text is on its way). One render at a time.
   */
  render(markdown: string, isDark: () => boolean, isStale: () => boolean = () => false, pass: RenderPass = {}): Promise<ReactElement | null> {
    const run = this.running.then(() => this.renderNow(markdown, isDark, isStale, pass));
    this.running = run.catch(() => undefined);
    return run;
  }

  private async renderNow(markdown: string, isDark: () => boolean, isStale: () => boolean, pass: RenderPass): Promise<ReactElement | null> {
    if (isStale()) return null;
    const opts = pipelineOptions(markdown);
    const dark = isDark();
    const variant = `${opts.raw ? 1 : 0}${opts.math ? 1 : 0}${dark ? 1 : 0}`;
    if (variant !== this.variant) {
      // Another pipeline (inline HTML / math appeared) or theme: start over.
      this.variant = variant;
      this.tracker.reset();
      this.values = [];
    }
    const version = nextVersion(this.channel);
    const u = this.tracker.update(markdown);
    const reusable = new Map<string, Rendered>();
    for (let k = u.head; k < u.oldTail && k < this.values.length; k++) {
      const v = this.values[k];
      if (v) reusable.set(v.text, v);
    }
    const middle = u.blocks.slice(u.head, u.tail).map((b) => {
      const v = reusable.get(markdown.slice(b.start, b.end));
      if (v) reusable.delete(v.text);
      return v ?? null;
    });
    const values = this.values.slice(0, u.head).concat(middle, this.values.slice(u.oldTail));
    this.values = values;
    const texts = u.blocks.map((b) => markdown.slice(b.start, b.end));

    // Viewport first: the block at the focus and a screen after it, then the rest in order.
    const pendingIdx = values.flatMap((v, i) => (v ? [] : [i]));
    const heights = texts.map((t) => estimateBlockHeight(t));
    const first = firstScreen(heights, blockAt(u.blocks, pass.focusOffset ?? 0), pass.viewportPx ?? 1200);
    const queue = new RenderQueue(pendingIdx, first);
    const firstLeft = new Set(first.filter((i) => queue.has(i)));
    this.jump.clear();
    this.pendingCount = queue.size;
    let partialAt = 0;
    let sliceStart = now();
    const ctx = { opts, isDark, dark, version };
    // Render in the worker a few blocks ahead, so its queue never runs dry.
    const inFlight = new Map<number, Promise<Rendered | null | typeof STALE>>();
    const ahead = () => {
      while (inFlight.size < 4) {
        const i = queue.next(this.jump);
        if (i === undefined) break;
        this.jump.delete(i);
        inFlight.set(i, this.renderBlock(texts[i], ctx));
      }
    };
    ahead();
    while (inFlight.size) {
      const [i, p] = inFlight.entries().next().value as [number, Promise<Rendered | null | typeof STALE>];
      const v = await p;
      inFlight.delete(i);
      if (v === STALE || v === null || isStale()) return null;
      values[i] = v;
      this.pendingCount = queue.size + inFlight.size;
      firstLeft.delete(i);
      ahead();
      if (!firstLeft.size && this.pendingCount && pass.onPartial && (partialAt === 0 || now() - partialAt > 250)) {
        // The first screen is in: show it while the rest renders (and every 250 ms after).
        partialAt = now();
        pass.onPartial(this.compose(values, texts, heights));
      }
      if (now() - sliceStart > 8) {
        await (firstLeft.size ? yieldToBrowser() : yieldIdle());
        if (isStale()) return null;
        sliceStart = now();
      }
    }
    this.pendingCount = 0;
    return this.compose(values, texts, heights);
  }

  /**
   * The preview of `values`: heading ids numbered over the whole document
   * in order (a kept block whose ids changed gets new ids, not a new
   * render), pending blocks as placeholders.
   */
  private compose(values: (Rendered | null)[], texts: string[], heights: number[]): ReactElement {
    const running = headingSlugger();
    const children = values.map((v, i) => {
      if (!v) {
        return jsx("div", { "data-lumen-pending": String(i), "aria-busy": "true", style: { minHeight: heights[i] } }, `p${i}:${texts[i].length}`);
      }
      const ids = v.slugTexts.map((t) => running.slug(t));
      if (ids.some((id, k) => id !== v.ids[k])) {
        // A heading above it changed how its repeats are numbered.
        v.ids = ids;
        v.key = `b${++this.nextKey}`;
        v.element = jsx(Fragment, { children: hastToReact(withIds(v.hast!, ids)) }, v.key);
      }
      return v.element;
    });
    return jsx(Fragment, { children });
  }

  private async renderBlock(text: string, ctx: { opts: { raw: boolean; math: boolean }; isDark: () => boolean; dark: boolean; version: number }): Promise<Rendered | null | typeof STALE> {
    // Plan W4.16: a block over the parser's bounds, or one that already
    // took longer than its deadline, is shown as raw text — so editing a
    // note with such a block stays responsive.
    const asRaw = this.slowBlocks.has(text);
    const fromWorker = await renderBlockInWorker({ type: "block", channel: this.channel, version: ctx.version, dark: ctx.dark, host: hostData(), text, ...ctx.opts, asRaw });
    if (fromWorker === STALE) return STALE;
    let hast: HastRoot;
    let slugTexts: string[];
    let ms: number;
    if (fromWorker) {
      ({ hast, slugTexts, ms } = fromWorker);
      this.renderedInWorker++;
    } else {
      const variant = `${ctx.opts.raw ? 1 : 0}${ctx.opts.math ? 1 : 0}`;
      if (this.processor?.variant !== variant) this.processor = { variant, proc: buildBlockProcessor(ctx.isDark, ctx.opts, blockSlugs) };
      const proc = await this.processor.proc;
      const started = now();
      const file = await proc.process({ value: prepareCriticMarkup(asRaw ? asRawText(text) : boundMarkdown(text)), data: { [DARK_DATA_KEY]: ctx.dark } });
      hast = withoutPositions(file.result as HastRoot);
      slugTexts = (file.data[SLUG_TEXTS_KEY] as string[] | undefined) ?? [];
      ms = now() - started;
    }
    if (ms > BLOCK_DEADLINE_MS) this.slowBlocks.add(text);
    this.rendered++;
    const key = `b${++this.nextKey}`;
    // Heading ids are given in compose(), in document order: a block with
    // headings gets its element there (its ids here never match a slug).
    if (slugTexts.length) return { text, key, hast, slugTexts, ids: slugTexts.map(() => SLUG_PLACEHOLDER), element: jsx(Fragment, {}, key) };
    return { text, key, hast: null, slugTexts, ids: [], element: jsx(Fragment, { children: hastToReact(hast) }, key) };
  }
}
