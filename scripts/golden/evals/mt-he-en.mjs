/**
 * Harness for the mt-he-en golden set (plan 6.4, local translation), the
 * form run-evals.mjs expects: score({ items }) → numbers only.
 *
 * The work is in ./mt.mjs (chrF, the layer runners). Each layer that can
 * run in this environment is scored on both directions; a layer that
 * cannot (no converted models until 15.9, no Hugging Face, a browser-only
 * API) contributes nothing, and `layers_measured` says how many did, so a
 * run that measured nothing is visibly a zero, never a fake number.
 */
import { LAYERS, PAIRS, scoreAll } from "./mt.mjs";

export async function score({ items }) {
  const usable = items.filter((it) => it.he && it.en);
  const { chrF } = await scoreAll(usable, { layers: LAYERS, models: process.env.MT_MODELS_DIR });
  const out = { items: usable.length, layers_measured: 0 };
  for (const layer of LAYERS) {
    let measured = false;
    for (const p of PAIRS) {
      const v = chrF[layer][`${p.source}-${p.target}`];
      if (v !== null) {
        out[`chrf_${layer}_${p.source}_${p.target}`] = v;
        measured = true;
      }
    }
    if (measured) out.layers_measured++;
  }
  return out;
}
