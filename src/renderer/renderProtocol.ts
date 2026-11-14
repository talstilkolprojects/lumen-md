/**
 * Messages between the window and the render worker (plan 8.1).
 *
 * Every request names a channel (one per preview) and a version. A newer
 * request on a channel makes the older ones stale: the window says so with
 * `cancel`, and the worker skips a stale request that is still queued, or
 * drops the result of one that finished meanwhile — it answers `stale`, so
 * the window's promise settles without cloning a tree nobody will show.
 * Everything here is structured-cloneable.
 */
import type { Root as HastRoot } from "hast";

/** What the pipeline needs from the window, carried by each request (./renderCore.ts RenderHost). */
export interface HostData {
  /** `callout.<kind>` titles and `embed.<kind>` notice templates, already translated. */
  strings: Record<string, string>;
  /** Code-block languages a plugin renders (plan 11.2). */
  pluginLangs: string[];
}

/** An `EmbedContext` (./embeds) as data: the note texts it may read. */
export interface EmbedData {
  hostPath: string | null;
  hostText: string;
  files: { path: string; content?: string; modified?: number }[];
}

interface Base {
  id: number;
  /** The preview this request is for, or null (one-off renders are never cancelled). */
  channel: string | null;
  version: number;
  dark: boolean;
  host: HostData;
}

/** A whole document, Shiki / KaTeX / rehype-raw as it needs them. */
export interface RenderDocRequest extends Base {
  type: "render";
  markdown: string;
  /** rehype-raw / KaTeX: decided by the window from the text before citations were expanded. */
  variant: { raw: boolean; math: boolean };
  embeds?: EmbedData;
}

/**
 * One block of a long document (./incrementalPreview.ts): heading ids are
 * left as placeholders (`SLUG_PLACEHOLDER` + index) and the heading texts
 * returned, so the window numbers them with the document's slugger.
 */
export interface RenderBlockRequest extends Base {
  type: "block";
  text: string;
  /** The document's pipeline variant (./renderCore.ts pipelineOptions over the whole text). */
  raw: boolean;
  math: boolean;
  /** Show the block as raw text: it took longer than its deadline before (plan W4.16). */
  asRaw: boolean;
}

/** A hover card (plan 4.6, W10.E4): the part of `content` the link's fragment names, rendered without lazy chunks. */
export interface RenderHoverRequest extends Base {
  type: "hover";
  content: string;
  fragment: string | null;
}

export interface CancelRequest {
  type: "cancel";
  channel: string;
  /** Requests on the channel with a lower version are stale. */
  version: number;
}

export type RenderRequest = RenderDocRequest | RenderBlockRequest | RenderHoverRequest | CancelRequest;

export type RenderReply =
  | { id: number; ok: true; hast: HastRoot; used?: string[]; slugTexts?: string[]; ms: number }
  | { id: number; ok: false; error: string }
  | { id: number; stale: true };

/** The id a block's heading gets until the window numbers it: placeholder + its index in the block. */
export const SLUG_PLACEHOLDER = "\u0000lumen-slug:";

/** vfile data key: the theme of a render (the request says it; a cached processor's `isDark` may belong to another caller). */
export const DARK_DATA_KEY = "lumenDark";
