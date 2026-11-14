/**
 * Image search in the app (plan 6.7): the pure logic of ./imageSearch.ts
 * wired to the vault (OPFS), the transformers.js worker and IndexedDB.
 * Loaded only when the Images tab of the search dialog is opened.
 */

import "./imageSearchStrings";
import { get, set } from "idb-keyval";
import { CONVERTED_MODELS_BASE, requestConvertedModel, type ConsentDeps } from "./convertedModels";
import type { ConsentDeps as MtConsent } from "./mt/localModels";
import { SIGLIP_ID, queryVector, rankImages, updateImageIndex, type ImageHit, type ImageIndex } from "./imageSearch";

const INDEX_KEY = "lumen.imageSearch.index.v1";

export class ImageSearchUnavailableError extends Error {
  constructor(readonly reason: "noHost" | "declined") {
    super(`image search ${reason}`);
    this.name = "ImageSearchUnavailableError";
  }
}

export interface ImageSearchDeps {
  consent: Omit<ConsentDeps, "isCached" | "base" | "registry">;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

async function host(deps: ImageSearchDeps): Promise<{ host: string; dtype: "q8" | "q4f16" }> {
  const base = CONVERTED_MODELS_BASE;
  if (!base) throw new ImageSearchUnavailableError("noHost");
  const [{ transformersDevice, translationDtypeFor }, { isModelCached }] = await Promise.all([import("./transformersEngine"), import("./modelCache")]);
  const dtype = translationDtypeFor(await transformersDevice());
  const answer = await requestConvertedModel(SIGLIP_ID, dtype, {
    ...deps.consent,
    base,
    isCached: async (entry, d) => isModelCached(await navigator.storage.getDirectory(), entry, d).catch(() => false),
  });
  if (answer === "unavailable") throw new ImageSearchUnavailableError("noHost");
  if (answer === "declined") throw new ImageSearchUnavailableError("declined");
  return { host: base, dtype };
}

/** Update the index (only new or changed images) and rank them for `query`. */
export async function searchImages(query: string, deps: ImageSearchDeps): Promise<{ hits: ImageHit[]; translated: string | null; embedded: number }> {
  const { host: h, dtype } = await host(deps);
  const [{ embedImagesLocal, embedTextsForImagesLocal }, ws] = await Promise.all([import("./transformersEngine"), import("../storage/workspace")]);
  const { index, embedded } = await updateImageIndex({
    list: async () => (await ws.listWorkspace({ includeAssets: true })).map((e) => ({ path: e.path, size: e.size, modified: e.modified })),
    read: (p) => ws.readWorkspaceBlob(p),
    embedImages: (blobs, signal) => embedImagesLocal(SIGLIP_ID, blobs, { host: h, dtype, signal }),
    load: async () => ((await get<ImageIndex>(INDEX_KEY).catch(() => undefined)) ?? null),
    save: (i) => set(INDEX_KEY, i),
    signal: deps.signal,
    onProgress: deps.onProgress,
  });
  const q = await queryVector(query, {
    embedText: (texts, signal) => embedTextsForImagesLocal(SIGLIP_ID, texts, { host: h, dtype, signal }),
    toEnglish: async (text, signal) => {
      const [{ translateLocally }, i18n] = await Promise.all([import("./mt"), import("../i18n")]);
      // Only layers that are ready: no second download prompt for a search.
      const quiet: MtConsent = { confirm: async () => false, t: i18n.t, locale: i18n.getLocale() };
      const r = await translateLocally(text, { source: "he", target: "en" }, quiet, { signal });
      return r.layer ? r.text : null;
    },
    signal: deps.signal,
  });
  return { hits: rankImages(index, q.vector), translated: q.translated ? q.text : null, embedded };
}
