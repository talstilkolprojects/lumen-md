/**
 * Local translation in three layers (plan 6.4):
 *
 *   1. chrome   Chrome's built-in Translator API: on-device, Hebrew included,
 *               main thread only, nothing to host.
 *   2. opus     Opus-MT en→he (Apache-2.0) and opus-mt-tc-big-he-en
 *               (CC-BY-4.0), converted by plan 6.0, in the transformers.js
 *               worker. Downloaded only through requestConvertedModel():
 *               size first, licence, attribution, consent. Unavailable
 *               while CONVERTED_MODELS_BASE is null (15.9).
 *   3. m2m100   M2M100-418M (MIT, ≈ 630 MB q8) for every other pair, same
 *               worker, same consent; then the local LLM (the translator
 *               agent) when no model fits. The non-commercial alternative
 *               in the plan is on the registry's deny-list and is not used.
 *
 * Which layer runs is decided here, by measured quality (./quality.json):
 * a layer measured below the Opus-MT baseline for a pair is never picked
 * automatically. The document itself is cut by ./segments.ts, so code,
 * links and frontmatter never reach a model.
 */
import quality from "./quality.json";

export type LayerId = "chrome" | "opus" | "m2m100" | "llm";

export interface Pair {
  /** BCP-47 primary tags: "he", "en", "fr"… */
  source: string;
  target: string;
}

export const pairKey = (p: Pair): string => `${p.source}-${p.target}`;

export type Availability =
  | { state: "ready" }
  /** Usable after a consented download of about `bytes` (unknown for Chrome's language packs). */
  | { state: "downloadable"; bytes?: number }
  /** Not usable here; `reason` is an i18n key the UI can show. */
  | { state: "unavailable"; reason: string };

export interface LayerDeps {
  signal?: AbortSignal;
  /** Progress of a download or a long translation, 0–100. */
  onProgress?: (p: { layer: LayerId; file?: string; progress: number }) => void;
}

export interface MtLayer {
  id: LayerId;
  /** Does this layer know the pair at all? (A model exists for it.) */
  supports(pair: Pair): boolean;
  availability(pair: Pair): Promise<Availability>;
  /** Ask for consent and download when needed. True when the layer can now translate the pair. */
  prepare(pair: Pair, deps: LayerDeps): Promise<boolean>;
  /** Plain-text segments → their translations, in order. */
  translate(texts: string[], pair: Pair, deps: LayerDeps): Promise<string[]>;
}

interface Quality {
  baseline: LayerId;
  chrF: Record<LayerId, Record<string, number | null>>;
}

/** Measured chrF of a layer on a pair, or null when it has not been measured. */
export function measuredChrF(layer: LayerId, pair: Pair, q: Quality = quality as Quality): number | null {
  return q.chrF[layer]?.[pairKey(pair)] ?? null;
}

export interface Candidate {
  layer: LayerId;
  /** True when the layer's quality on this pair is not measured (quality.json). */
  unmeasured: boolean;
}

/** The layers in the order the plan gives them. */
export const LAYER_ORDER: LayerId[] = ["chrome", "opus", "m2m100", "llm"];

/**
 * Which layers may run automatically for a pair, best first. A layer whose
 * measured chrF is below the baseline's measured chrF is left out; an
 * unmeasured layer stays in (flagged), after the measured ones.
 */
export function rankLayers(pair: Pair, supported: LayerId[], q: Quality = quality as Quality): Candidate[] {
  const base = measuredChrF(q.baseline, pair, q);
  const out: Candidate[] = [];
  for (const layer of LAYER_ORDER) {
    if (!supported.includes(layer)) continue;
    const score = measuredChrF(layer, pair, q);
    if (score !== null && base !== null && score < base) continue;
    out.push({ layer, unmeasured: score === null });
  }
  // Measured layers before unmeasured ones; among measured, by score; ties keep the plan's order.
  return out
    .map((c, i) => ({ c, i, score: measuredChrF(c.layer, pair, q) }))
    .sort((a, b) => Number(a.score === null) - Number(b.score === null) || (b.score ?? 0) - (a.score ?? 0) || a.i - b.i)
    .map((x) => x.c);
}
