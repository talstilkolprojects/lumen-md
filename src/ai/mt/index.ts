/**
 * Local translation (plan 6.4): pick a layer for the pair, get its model
 * with consent, translate the document with everything that must not change
 * kept (./segments.ts), paragraph by paragraph in the language each one is
 * in (plan 6.5). When no local layer can take the pair, the caller falls
 * back to the LLM translator agent (layer 3b).
 */
import "./strings";
import { createChromeLayer } from "./chromeTranslator";
import { rankLayers, type LayerDeps, type LayerId, type MtLayer, type Pair } from "./layers";
import { createM2m100Layer, createOpusLayer, type ConsentDeps } from "./localModels";
import { translateMarkdown as translateSegments } from "./segments";

export type { Pair, LayerId } from "./layers";

export interface LocalTranslationResult {
  text: string;
  layer: LayerId;
  /** The layer's quality on this pair is not measured yet (src/ai/mt/quality.json). */
  unmeasured: boolean;
}

export interface NoLocalLayer {
  layer: null;
  /** Why each supported layer could not run: i18n keys ("mt.layer.opus.noHost"…) or "declined". */
  reasons: Partial<Record<LayerId, string>>;
}

export interface TranslateOptions extends LayerDeps {
  /** Language detection for paragraph routing (plan 6.5); omitted: every paragraph is translated. */
  detect?: (text: string) => { lang: string; confident: boolean };
  /** Layers to use (tests); default: Chrome, Opus-MT, M2M100. */
  layers?: MtLayer[];
}

export function defaultLayers(consent: ConsentDeps): MtLayer[] {
  return [createChromeLayer(), createOpusLayer(consent), createM2m100Layer(consent)];
}

/**
 * Translate `markdown` from `pair.source` to `pair.target` locally, or
 * report that no layer could. A declined download stops further download
 * prompts in this call; layers that are already ready are still tried.
 */
export async function translateLocally(markdown: string, pair: Pair, consent: ConsentDeps, opts: TranslateOptions = {}): Promise<LocalTranslationResult | NoLocalLayer> {
  const layers = opts.layers ?? defaultLayers(consent);
  const supported = layers.filter((l) => l.supports(pair));
  const reasons: Partial<Record<LayerId, string>> = {};
  for (const l of layers) if (!supported.includes(l)) reasons[l.id] = `mt.layer.${l.id}.pair`;
  let declined = false;
  for (const cand of rankLayers(pair, supported.map((l) => l.id))) {
    const layer = supported.find((l) => l.id === cand.layer)!;
    const a = await layer.availability(pair);
    if (a.state === "unavailable") {
      reasons[layer.id] = a.reason;
      continue;
    }
    if (a.state === "downloadable" && declined) {
      reasons[layer.id] = "declined";
      continue;
    }
    const ok = await layer.prepare(pair, opts);
    if (!ok) {
      reasons[layer.id] = a.state === "downloadable" ? "declined" : "mt.layer.failed";
      if (a.state === "downloadable") declined = true;
      continue;
    }
    const detect = opts.detect;
    const text = await translateSegments(markdown, (texts, signal) => layer.translate(texts, pair, { ...opts, signal }), {
      signal: opts.signal,
      shouldTranslate: detect ? (p) => !(detect(p).confident && detect(p).lang === pair.target) : undefined,
    });
    return { text, layer: layer.id, unmeasured: cand.unmeasured };
  }
  return { layer: null, reasons };
}
