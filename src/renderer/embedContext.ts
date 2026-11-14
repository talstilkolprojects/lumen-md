/**
 * The preview's `EmbedContext` (./embeds) for `![[embeds]]`, built from the
 * in-memory workspace index the backlinks and search panels already keep
 * (src/storage/workspaceIndex.ts). The remark pipeline is synchronous, so it
 * cannot read files itself: the index is brought up to date here, before
 * the render, and the render reads note texts from it. After an autosave the
 * index re-reads only the saved files, so a re-render after a change costs
 * one file read, not a vault scan.
 */

import { t } from "../i18n";
import { createEmbedContext, embeddedTexts, hasEmbeds, type EmbedContext, type EmbedNoticeKind } from "./embeds";
import "./embedContextStrings";

/** The workspace path a preview doc key (./previewDoc) names, or null. */
export function hostPathOf(docKey: string | null | undefined): string | null {
  return docKey?.startsWith("ws:") ? docKey.slice(3) : null;
}

export function embedNotice(kind: EmbedNoticeKind, vars: Record<string, string | number>): string {
  switch (kind) {
    case "notFound":
      return t("embed.notFound", vars);
    case "sectionNotFound":
      return t("embed.sectionNotFound", vars);
    case "cycle":
      return t("embed.cycle", vars);
    case "depth":
      return t("embed.depth", vars);
  }
}

/**
 * Context for rendering `markdownText`, or undefined when it has no embeds
 * (the common case costs one regex test). Never throws: without a
 * workspace (no OPFS) every target is reported missing.
 */
export async function loadEmbedContext(markdownText: string, docKey: string | null): Promise<EmbedContext | undefined> {
  if (!hasEmbeds(markdownText)) return undefined;
  let files: { path: string; content: string; modified?: number }[] = [];
  try {
    const { ensureIndex, indexedNotes } = await import("../storage/workspaceIndex");
    await ensureIndex();
    // W2.22: the notes' text, read from the index for this render.
    files = await indexedNotes();
  } catch {
    /* why: no workspace */
  }
  const make = (extra: typeof files = []) =>
    createEmbedContext({ hostPath: hostPathOf(docKey), hostText: markdownText, files: extra.length ? [...files, ...extra] : files, notice: embedNotice });
  const ctx = make();
  // Pasted images (`lumen-asset-*`, at the vault root) are left out of the
  // index: look up the ones these notes embed, so a missing one is reported.
  const assets = await existingAssets([markdownText, ...embeddedTexts(markdownText, ctx)]);
  return assets.length ? make(assets) : ctx;
}

const ASSET_EMBED = /!\[\[\s*(?:\.?\/)?([^\]|#\r\n]*lumen-asset-[^\]|#\r\n]*?)\s*(?:[|#][^\]\r\n]*)?\]\]/g;

async function existingAssets(texts: string[]): Promise<{ path: string; content: string }[]> {
  const names = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(ASSET_EMBED)) names.add(m[1]);
  if (!names.size) return [];
  try {
    const { workspaceHasFile } = await import("../storage/workspace");
    const found = await Promise.all([...names].map(async (path) => ((await workspaceHasFile(path)) ? path : null)));
    return found.filter((p): p is string => !!p).map((path) => ({ path, content: "" }));
  } catch {
    return [];
  }
}
