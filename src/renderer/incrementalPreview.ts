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
import { headingSlugger } from "../lib/slug";
import { mayContainCriticMarkup } from "../editor/suggesting";
import { BlockTracker } from "./blocks";
import { prepareCriticMarkup } from "./criticMarkup";
import type { Element, Root as HastRoot } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import { visit } from "unist-util-visit";
import { buildBlockProcessor, pipelineOptions } from "./pipeline";

/**
 * rehype-slug for one block: the same id rule (github-slugger over the
 * heading's text, headings that already have an id skipped), but numbered
 * with the document's slugger, so a repeated heading in a later block
 * still gets `-1`.
 */
function rehypeSlugAcrossBlocks(slug: (text: string) => string) {
  return () => (tree: HastRoot) => {
    visit(tree, "element", (node: Element) => {
      if (!/^h[1-6]$/.test(node.tagName)) return;
      const props = (node.properties ??= {});
      if (!props.id) props.id = slug(hastToString(node));
    });
  };
}

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
  element: ReactElement;
  /** The heading texts this block gave to the slugger, in order. */
  slugTexts: string[];
  ids: string[];
}

type Processor = Awaited<ReturnType<typeof buildBlockProcessor>>;
type Slugger = ReturnType<typeof headingSlugger>;

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class IncrementalPreview {
  private readonly tracker = new BlockTracker({ preview: true });
  private values: (Rendered | null)[] = [];
  private variant = "";
  private processor: Processor | null = null;
  private nextKey = 0;
  /** The slugger the block being rendered numbers its headings with. */
  private slugs: { slugger: Slugger; texts: string[]; ids: string[] } | null = null;
  private running: Promise<unknown> = Promise.resolve();
  /** Blocks rendered since this preview was created (a test counter). */
  rendered = 0;

  private readonly blockSlugs = rehypeSlugAcrossBlocks((text) => {
    const s = this.slugs!;
    const id = s.slugger.slug(text);
    s.texts.push(text);
    s.ids.push(id);
    return id;
  });

  /**
   * The preview of `markdown`, or null when `isStale()` turned true while
   * rendering (a newer text is on its way). One render at a time.
   */
  render(markdown: string, isDark: () => boolean, isStale: () => boolean = () => false): Promise<ReactElement | null> {
    const run = this.running.then(() => this.renderNow(markdown, isDark, isStale));
    this.running = run.catch(() => undefined);
    return run;
  }

  private async renderNow(markdown: string, isDark: () => boolean, isStale: () => boolean): Promise<ReactElement | null> {
    if (isStale()) return null;
    const opts = pipelineOptions(markdown);
    const variant = `${opts.raw ? 1 : 0}${opts.math ? 1 : 0}${isDark() ? 1 : 0}`;
    if (variant !== this.variant || !this.processor) {
      // Another pipeline (inline HTML / math appeared) or theme: start over.
      this.processor = await buildBlockProcessor(isDark, opts, this.blockSlugs);
      this.variant = variant;
      this.tracker.reset();
      this.values = [];
    }
    const proc = this.processor;
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

    const running = headingSlugger();
    const allTexts: string[] = [];
    let sliceStart = now();
    for (let i = 0; i < u.blocks.length; i++) {
      let v = values[i];
      if (v) {
        // Kept: still valid if its headings get the same ids here.
        const ids = v.slugTexts.map((t) => running.slug(t));
        if (ids.some((id, k) => id !== v!.ids[k])) {
          // A heading above it changed how its repeats are numbered.
          const seeded = headingSlugger();
          for (const t of allTexts) seeded.slug(t);
          v = await this.renderBlock(proc, v.text, seeded);
          values[i] = v;
        }
      } else {
        const b = u.blocks[i];
        v = await this.renderBlock(proc, markdown.slice(b.start, b.end), running);
        values[i] = v;
      }
      allTexts.push(...v.slugTexts);
      if (now() - sliceStart > 8) {
        await yieldToBrowser();
        if (isStale()) return null;
        sliceStart = now();
      }
    }
    return jsx(Fragment, { children: values.map((v) => v!.element) });
  }

  private async renderBlock(proc: Processor, text: string, slugger: Slugger): Promise<Rendered> {
    const slugs = { slugger, texts: [] as string[], ids: [] as string[] };
    this.slugs = slugs;
    let result: ReactElement;
    try {
      const file = await proc.process(prepareCriticMarkup(text));
      result = file.result as ReactElement;
    } finally {
      this.slugs = null;
    }
    this.rendered++;
    const key = `b${++this.nextKey}`;
    return { text, key, element: jsx(Fragment, { children: result }, key), slugTexts: slugs.texts, ids: slugs.ids };
  }
}
