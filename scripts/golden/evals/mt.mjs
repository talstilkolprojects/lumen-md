#!/usr/bin/env node
/**
 * Translation quality per layer (plan 6.4): chrF on the mt-he-en golden set.
 *
 *   node scripts/golden/evals/mt.mjs --dev [--models DIR] [--layers opus,m2m100] [--out scores.json] [--write-quality]
 *
 * Metric: chrF as sacreBLEU's chrF2 computes it (character n-grams 1–6,
 * whitespace removed, β = 2, corpus level, no word n-grams) — chrF(), below.
 * Direction he→en uses the set's reference (NTREX's English); en→he scores
 * against NTREX's Hebrew, which is translationese (SOURCES.md), so that
 * number is indicative.
 *
 * Layers and where they can run:
 *   opus     the converted Opus-MT models, from --models DIR (one folder per
 *            model id, as model-convert.yml's artifacts) or MT_MODELS_DIR.
 *            Not downloadable from this machine or the CI runner until Tal's
 *            15.9(0) / 15.9: without a folder the layer is "not runnable".
 *   m2m100   Xenova/m2m100_418M from Hugging Face, only with MT_ALLOW_REMOTE=1
 *            (the agent sandbox has no Hugging Face access).
 *   chrome   Chrome's built-in Translator API: a browser API with no Node
 *            or headless equivalent — not measurable here (see the PR).
 *   llm      the translator agent needs a model endpoint; not measured here.
 *
 * --write-quality copies the measured numbers into src/ai/mt/quality.json,
 * which decides the automatic layer choice; everything not measured stays
 * null. Scores only are printed — no item, input or output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSet } from "../../lib/golden.mjs";
import { GOLDEN, ROOT } from "../common.mjs";

// ── chrF (sacreBLEU chrF2) ──────────────────────────────────────────────

function charNgrams(sentence, order) {
  const s = sentence.split(/\s+/).join("");
  const out = Array.from({ length: order }, () => new Map());
  for (let n = 1; n <= order; n++) {
    const m = out[n - 1];
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Corpus chrF, 0–100: per order, matches / hypothesis / reference totals
 * summed over sentences; precision and recall averaged over the orders
 * both sides have n-grams for; F_β with β = 2.
 */
export function chrF(hyps, refs, { order = 6, beta = 2 } = {}) {
  if (hyps.length !== refs.length) throw new Error(`chrF: ${hyps.length} hypotheses for ${refs.length} references`);
  const stats = Array.from({ length: order }, () => ({ hyp: 0, ref: 0, match: 0 }));
  for (let i = 0; i < hyps.length; i++) {
    const h = charNgrams(String(hyps[i] ?? ""), order);
    const r = charNgrams(String(refs[i] ?? ""), order);
    for (let n = 0; n < order; n++) {
      for (const c of h[n].values()) stats[n].hyp += c;
      for (const c of r[n].values()) stats[n].ref += c;
      for (const [g, c] of h[n]) stats[n].match += Math.min(c, r[n].get(g) ?? 0);
    }
  }
  let prec = 0;
  let rec = 0;
  let effective = 0;
  for (const s of stats) {
    if (s.hyp > 0 && s.ref > 0) {
      prec += s.match / s.hyp;
      rec += s.match / s.ref;
      effective++;
    }
  }
  if (!effective) return 0;
  prec /= effective;
  rec /= effective;
  if (prec + rec === 0) return 0;
  const b2 = beta * beta;
  return (100 * (1 + b2) * prec * rec) / (b2 * prec + rec);
}

// ── Layer runners (Node) ────────────────────────────────────────────────

const OPUS = { "he-en": "opus-mt-tc-big-he-en", "en-he": "opus-mt-en-he" };

async function transformers() {
  const mod = await import("@huggingface/transformers");
  return mod;
}

/** A translator (texts → texts) for a layer and pair, or { skip: reason }. */
export async function runnerFor(layer, pair, opts = {}) {
  const key = `${pair.source}-${pair.target}`;
  if (layer === "opus") {
    const dir = opts.models ?? process.env.MT_MODELS_DIR;
    const id = OPUS[key];
    if (!id) return { skip: "no converted model for this pair" };
    if (!dir) return { skip: "the converted models are not downloadable here (--models DIR after Tal's 15.9(0) / 15.9)" };
    try {
      const { env, pipeline } = await transformers();
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = dir.endsWith("/") ? dir : dir + "/";
      const pipe = await pipeline("translation", id, { dtype: "q8" });
      return { translate: async (texts) => (await pipe(texts, { max_new_tokens: 256 })).map((r) => r.translation_text ?? "") };
    } catch (e) {
      return { skip: `could not load ${id} from ${dir}: ${String(e.message).split("\n")[0].slice(0, 120)}` };
    }
  }
  if (layer === "m2m100") {
    if (process.env.MT_ALLOW_REMOTE !== "1") return { skip: "needs Hugging Face (set MT_ALLOW_REMOTE=1 where it is reachable)" };
    try {
      const { env, pipeline } = await transformers();
      env.allowRemoteModels = true;
      const pipe = await pipeline("translation", "Xenova/m2m100_418M", { dtype: "q8" });
      return { translate: async (texts) => (await pipe(texts, { src_lang: pair.source, tgt_lang: pair.target, max_new_tokens: 256 })).map((r) => r.translation_text ?? "") };
    } catch (e) {
      return { skip: `could not load Xenova/m2m100_418M: ${String(e.message).split("\n")[0].slice(0, 120)}` };
    }
  }
  if (layer === "chrome") return { skip: "a browser-only API (Chrome's Translator): no Node or headless-CI equivalent" };
  if (layer === "llm") return { skip: "the translator agent needs a model endpoint; not measured by this harness" };
  return { skip: `unknown layer ${layer}` };
}

/** chrF of one layer on one direction over `items` ({ he, en }), or { skip }. */
export async function scoreLayer(layer, pair, items, opts = {}) {
  const r = await runnerFor(layer, pair, opts);
  if (r.skip) return r;
  const src = items.map((it) => String(it[pair.source] ?? ""));
  const ref = items.map((it) => String(it[pair.target] ?? ""));
  const hyp = [];
  for (let i = 0; i < src.length; i += 8) hyp.push(...(await r.translate(src.slice(i, i + 8))));
  return { chrF: chrF(hyp, ref), n: items.length };
}

export const PAIRS = [
  { source: "he", target: "en" },
  { source: "en", target: "he" },
];
export const LAYERS = ["chrome", "opus", "m2m100", "llm"];

/** { layer: { "he-en": chrF | null, … } } plus the reasons for every null. */
export async function scoreAll(items, { layers = LAYERS, models } = {}) {
  const chrf = {};
  const reasons = {};
  for (const layer of layers) {
    chrf[layer] = {};
    for (const pair of PAIRS) {
      const key = `${pair.source}-${pair.target}`;
      const r = await scoreLayer(layer, pair, items, { models });
      chrf[layer][key] = r.skip ? null : Number(r.chrF.toFixed(2));
      if (r.skip) (reasons[layer] ??= {})[key] = r.skip;
    }
  }
  return { chrF: chrf, reasons };
}

// ── CLI ────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1].replace(/\\/g, "/") || process.argv[1]?.endsWith("evals/mt.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  if (!args.includes("--dev")) {
    console.error("usage: mt.mjs --dev [--models DIR] [--layers a,b] [--out scores.json] [--write-quality]");
    process.exit(2);
  }
  const { items } = loadSet(GOLDEN, "mt-he-en", { split: "dev" });
  const ntrex = items.filter((it) => it.part === "ntrex" && it.he && it.en);
  const layers = opt("--layers")?.split(",") ?? LAYERS;
  const { chrF: scores, reasons } = await scoreAll(ntrex, { layers, models: opt("--models") });
  const rows = [`| layer | he→en chrF | en→he chrF |`, `|---|---|---|`];
  for (const l of layers) rows.push(`| ${l} | ${scores[l]["he-en"] ?? `not measured: ${reasons[l]?.["he-en"]}`} | ${scores[l]["en-he"] ?? `not measured: ${reasons[l]?.["en-he"]}`} |`);
  console.log(`mt-he-en dev split, ntrex part: ${ntrex.length} items\n\n${rows.join("\n")}`);
  const out = opt("--out");
  if (out) writeFileSync(out, JSON.stringify({ set: "mt-he-en", split: "dev", part: "ntrex", n: ntrex.length, chrF: scores, reasons, measuredOn: new Date().toISOString().slice(0, 10) }, null, 2) + "\n");
  if (args.includes("--write-quality")) {
    const file = join(ROOT, "src", "ai", "mt", "quality.json");
    const q = JSON.parse(readFileSync(file, "utf8"));
    let changed = 0;
    for (const l of layers) {
      for (const p of PAIRS) {
        const k = `${p.source}-${p.target}`;
        if (scores[l][k] !== null) {
          q.chrF[l] = { ...(q.chrF[l] ?? {}), [k]: scores[l][k] };
          changed++;
        }
      }
    }
    if (changed) q.measuredOn = new Date().toISOString().slice(0, 10);
    writeFileSync(file, JSON.stringify(q, null, 2) + "\n");
    console.log(`\n${changed ? `${changed} measurement(s) written to` : "nothing measured; unchanged:"} src/ai/mt/quality.json`);
  }
}
