#!/usr/bin/env node
/**
 * Image search quality (plan 6.7): recall@1, recall@5 and nDCG@10 of the one
 * relevant image among the split's images, per query language, on the
 * image-search golden set (Crossmodal-3600, 7.10).
 *
 *   node scripts/golden/evals/image-search.mjs --dev [--models DIR] [--out scores.json]
 *
 * Model: SigLIP base multilingual (Apache-2.0), the converted ONNX from
 * model-convert.yml (plan 6.0), loaded from --models DIR (one folder per
 * model id, as the workflow's artifact) or IMAGE_SEARCH_MODELS_DIR. Not
 * downloadable from this machine or the CI runner until Tal's 15.9(0) /
 * 15.9: without a folder the eval says "not runnable" and exits 0.
 *
 * Plan 6.7 acceptance: recall@5 ≥ 80 % on 30 golden Hebrew queries. The
 * Hebrew run is reported twice: the query as written, and translated to
 * English first (6.7.2) with the set's own English caption standing in for
 * the translation (an upper bound for that route; the real translation
 * layer is measured in mt.mjs).
 *
 * Only scores are printed: no image, query or output.
 */
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadSet } from "../../lib/golden.mjs";
import { GOLDEN } from "../common.mjs";

export const MODEL_ID = "siglip-base-patch16-256-multilingual";
export const TARGET_RECALL_AT_5 = 0.8;

/** Ranks (1-based) of each query's relevant image, given unit vectors. */
export function ranksOf(queryVecs, imageVecs, relevant) {
  return queryVecs.map((q, i) => {
    const scores = imageVecs.map((v, j) => ({ j, s: v.reduce((a, x, k) => a + x * q[k], 0) }));
    scores.sort((a, b) => b.s - a.s || a.j - b.j);
    const r = scores.findIndex((x) => x.j === relevant[i]);
    return r < 0 ? null : r + 1;
  });
}

export function metrics(ranks, k = 5) {
  const n = ranks.length || 1;
  let r1 = 0;
  let rk = 0;
  let ndcg = 0;
  for (const r of ranks) {
    if (r === null) continue;
    if (r === 1) r1++;
    if (r <= k) rk++;
    if (r <= 10) ndcg += 1 / Math.log2(r + 1);
  }
  return { recallAt1: r1 / n, recallAt5: rk / n, ndcg10: ndcg / n, n: ranks.length };
}

const norm = (row) => {
  const n = Math.hypot(...row) || 1;
  return row.map((v) => v / n);
};

async function siglip(dir) {
  const T = await import("@huggingface/transformers");
  T.env.allowRemoteModels = false;
  T.env.allowLocalModels = true;
  T.env.localModelPath = dir.endsWith("/") ? dir : dir + "/";
  const [processor, tokenizer, vision, text] = await Promise.all([
    T.AutoProcessor.from_pretrained(MODEL_ID),
    T.AutoTokenizer.from_pretrained(MODEL_ID),
    T.SiglipVisionModel.from_pretrained(MODEL_ID, { dtype: "q8" }),
    T.SiglipTextModel.from_pretrained(MODEL_ID, { dtype: "q8" }),
  ]);
  const rows = (t) => {
    const d = t.dims.at(-1);
    return Array.from({ length: t.data.length / d }, (_, r) => norm(Array.from(t.data.slice(r * d, (r + 1) * d))));
  };
  return {
    images: async (paths) => {
      const out = [];
      for (const p of paths) out.push(...rows((await vision(await processor(await T.RawImage.read(p)))).pooler_output));
      return out;
    },
    texts: async (texts) => rows((await text(tokenizer(texts, { padding: "max_length", truncation: true, max_length: 64 }))).pooler_output),
  };
}

const isMain = process.argv[1]?.endsWith("evals/image-search.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  if (!args.includes("--dev")) {
    console.error("usage: image-search.mjs --dev [--models DIR] [--out scores.json]");
    process.exit(2);
  }
  const { items } = loadSet(GOLDEN, "image-search", { split: "dev" });
  const dir = join(GOLDEN, "image-search", "dev");
  const withImages = items.filter((it) => it.image && existsSync(join(dir, it.image)));
  const models = opt("--models") ?? process.env.IMAGE_SEARCH_MODELS_DIR;
  const report = { set: "image-search", split: "dev", items: items.length, withImages: withImages.length, target: { recallAt5: TARGET_RECALL_AT_5, lang: "he" } };
  if (!withImages.length) report.notRunnable = "the dev images are not in the repo yet (workflow job xm3600-images, plan 7.10)";
  else if (!models) report.notRunnable = "the converted SigLIP is not downloadable here (--models DIR after Tal's 15.9(0) / 15.9)";
  else {
    const m = await siglip(models);
    const imgs = await m.images(withImages.map((it) => join(dir, it.image)));
    const relevant = withImages.map((_, i) => i);
    report.en = metrics(ranksOf(await m.texts(withImages.map((it) => it.query)), imgs, relevant));
    report.he = metrics(ranksOf(await m.texts(withImages.map((it) => it.query_he)), imgs, relevant));
    // 6.7.2: Hebrew translated to English first. The set's English caption stands in for the translation: an upper bound.
    report.heViaEnglishUpperBound = report.en;
    // Hebrew goes to SigLIP directly only within 5 points of English (src/ai/imageSearch.ts HEBREW_DIRECT).
    report.hebrewDirect = report.he.recallAt5 >= report.en.recallAt5 - 0.05;
    report.pass = report.he.recallAt5 >= TARGET_RECALL_AT_5 || (!report.hebrewDirect && report.en.recallAt5 >= TARGET_RECALL_AT_5);
  }
  const out = opt("--out");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  // Not runnable is not a failure: the PR says "not measured".
  process.exitCode = report.pass === false ? 1 : 0;
}
