/**
 * The fuzz oracle (plan W8.8): which tokens the preview shades as redacted,
 * and which of them the export keeps. A kept one is a leak.
 *
 * The preview's side follows src/renderer/pipeline.ts as closely as a test can
 * without the whole unified pipeline (review 8, rr8/preview.ts): the note's
 * `prepareCriticMarkup` text, YAML frontmatter dropped, micromark with the
 * syntax extensions the tree pass loads (GFM table and footnote, math,
 * directive; an unknown directive becomes a `div`, as mdast-util-to-hast does),
 * raw HTML kept, then `DOMParser`: under vitest's jsdom that is parse5, the
 * parser rehype-raw uses; in the offline Chromium harness it is Blink's, which
 * implements the same WHATWG tree builder. A note that the preview would render
 * block by block (`canRenderInBlocks`) is also shaded block by block.
 *
 * The export's side is `prepareForExportSync` with photos left alone: the same
 * text transform as `exportReadyText`, the one door of every export.
 */
import { micromark } from "micromark";
import { directive, directiveHtml, type Handle } from "micromark-extension-directive";
import { gfmFootnote, gfmFootnoteHtml } from "micromark-extension-gfm-footnote";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";
import { math, mathHtml } from "micromark-extension-math";
import { prepareForExportSync } from "../../../src/lib/redaction";
import { splitBlocks } from "../../../src/renderer/blocks";
import { prepareCriticMarkup } from "../../../src/renderer/criticMarkup";
import { canRenderInBlocks } from "../../../src/renderer/incrementalPreview";

import { TOKEN, tokensIn } from "./tokens";

export { TOKEN, tokensIn };

const asDiv: Handle = function (d) {
  this.tag("<div>");
  if (d.label) this.raw(d.label);
  if (d.content) this.raw(d.content);
  this.tag("</div>");
  return undefined;
};

const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?=\r?\n|$)/;

/** The preview's HTML for a note (before sanitising, which keeps `redact`). */
export function previewHtml(md: string, critic = true): string {
  const src = critic ? prepareCriticMarkup(md) : md;
  const fm = FRONTMATTER.exec(src);
  const body = fm ? src.slice(fm[0].length) : src;
  return micromark(body, {
    allowDangerousHtml: true,
    extensions: [gfmTable(), gfmFootnote(), math(), directive()],
    htmlExtensions: [gfmTableHtml(), gfmFootnoteHtml(), mathHtml({ throwOnError: false }), directiveHtml({ "*": asDiv })],
  });
}

/** The tokens of every text node inside a `redact` element, as the HTML parser builds the tree. */
export function shadedIn(html: string): Set<string> {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  const out = new Set<string>();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest("redact")) continue;
    for (const m of (n.nodeValue ?? "").matchAll(TOKEN)) out.add(m[0]);
  }
  return out;
}

export interface Leak {
  /** Shaded in the whole-note preview and kept by the export. */
  full: string[];
  /** Shaded only when the note renders block by block, and kept. */
  blocks: string[];
  /** How many tokens the preview shaded (a fuzz set that shades nothing proves nothing). */
  shaded: number;
}

export function leaksOf(md: string): Leak {
  const kept = tokensIn(prepareForExportSync(md, { keepImageMetadata: true }));
  const whole = shadedIn(previewHtml(md));
  const full = [...whole].filter((t) => kept.has(t));
  let blocks: string[] = [];
  if (canRenderInBlocks(md)) {
    const per = new Set<string>();
    for (const b of splitBlocks(md, { preview: true }).blocks) for (const t of shadedIn(previewHtml(md.slice(b.start, b.end)))) per.add(t);
    blocks = [...per].filter((t) => kept.has(t) && !whole.has(t));
  }
  return { full, blocks, shaded: whole.size };
}

export const leaks = (md: string): boolean => {
  const l = leaksOf(md);
  return l.full.length + l.blocks.length > 0;
};

export const haveDom = typeof DOMParser !== "undefined" && typeof NodeFilter !== "undefined";
