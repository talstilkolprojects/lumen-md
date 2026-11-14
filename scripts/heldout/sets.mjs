/**
 * The held-out sets (plan W6.17): their sources, sizes, licences and how
 * each one is drawn from its pool with the evaluator's split secret.
 *
 * Every source here is public and openly licensed, and none is a pool of
 * any dev set in this repo (eval/golden uses HeQ, Belebele, FLORES+, NTREX,
 * Tatoeba, Ben-Yehuda, FLEURS test and validation, Common Voice test, and
 * its own six fonts; the probes are written by the agents). What is secret
 * is which items of the pool a set holds: the HMAC order of
 * scripts/lib/heldout.mjs#rankPool.
 *
 * This file never reads a pool by itself: scripts/heldout.mjs pipes the
 * rows in from scripts/heldout/fetch.py (or, in tests, from a folder of
 * synthetic rows) and the items go straight into an encrypted bundle.
 */
import { createHmac } from "node:crypto";
import { grammarLabel, parseSlots, rankPool, take } from "../lib/heldout.mjs";

/** Where each pool comes from. `revision` is the one the first sealed build pinned (null until then). */
export const SOURCES = {
  mkqa: {
    name: "MKQA (Apple)",
    home: "https://github.com/apple/ml-mkqa",
    file: "dataset/mkqa.jsonl.gz",
    license: "CC-BY-SA-3.0",
    licenseEvidence: "README, section License: the dataset is under Creative Commons Attribution-ShareAlike 3.0 Unported (read 2026-11-12); fetch.py checks the README of the pinned commit again at build time",
    pool: "10,000 open-domain questions, aligned across 26 languages (he and en used)",
  },
  massive: {
    name: "MASSIVE 1.1 (Amazon)",
    home: "https://huggingface.co/datasets/AmazonScience/massive",
    file: "he-IL/{train,validation,test} parquet (refs/convert/parquet)",
    license: "CC-BY-4.0",
    licenseEvidence: "dataset card front matter `license: cc-by-4.0` and the full CC BY 4.0 text in the card; checked at build time against the card",
    pool: "he-IL: 11,514 train / 2,033 dev / 2,974 test utterances with intent, slots and crowd judgments",
  },
  "global-mmlu": {
    name: "Global-MMLU (Cohere Labs)",
    home: "https://huggingface.co/datasets/CohereForAI/Global-MMLU",
    file: "he/test-*.parquet, en/test-*.parquet",
    license: "Apache-2.0",
    licenseEvidence: "dataset card front matter `license: apache-2.0`; checked at build time against the card",
    pool: "the MMLU test questions, human-checked translations aligned by sample_id",
  },
  fleurs: {
    name: "FLEURS he_il, train split (Google)",
    home: "https://huggingface.co/datasets/google/fleurs",
    file: "data/he_il/train.tsv + audio/train.tar.gz",
    license: "CC-BY-4.0",
    licenseEvidence: "dataset card front matter `license: cc-by-4.0`; checked at build time against the card",
    pool: "read Wikipedia sentences; the repo samples only the validation split (models:day) and the test split (eval/golden/asr-he)",
  },
  fontsource: {
    name: "Fontsource OFL Hebrew fonts (npm)",
    home: "https://fontsource.org",
    file: "@fontsource/{noto-sans-hebrew,noto-serif-hebrew,alef,suez-one}",
    license: "OFL-1.1",
    licenseEvidence: "each package's package.json `license: OFL-1.1`; the fonts only render the images (OFL does not cover documents made with a font); eval/golden/ocr-he uses six other fonts",
    pool: "four fonts the golden OCR set does not use",
  },
};

/** OCR fonts: none of them is among eval/golden/ocr-he's six. */
export const OCR_FONTS = [
  { pkg: "noto-sans-hebrew", family: "Noto Sans Hebrew" },
  { pkg: "noto-serif-hebrew", family: "Noto Serif Hebrew" },
  { pkg: "alef", family: "Alef" },
  { pkg: "suez-one", family: "Suez One" },
];

const SHORT_TYPES = new Set(["entity", "date", "number", "number_with_unit", "short_phrase", "binary"]);
const HEBREW_LINE = /^[א-ת0-9\s,.;:!?()"'\-–־׳״]+$/;

/**
 * The sets. `rows` names the pools a set is drawn from (fetch.py's sources),
 * `prefix` + a row's id is its item's id, `size` the items it holds, `fields` the text the contamination check
 * looks for, `select(pools, secret)` the keyed draw. Sets drawn from the
 * same pool take disjoint items (`after`).
 */
export const SETS = [
  {
    id: "qa-he",
    prefix: "mkqa-",
    task: "Hebrew question answering, closed book: a short factual answer to a Hebrew question",
    plan: ["W6.17", "7.9", "E18"],
    source: "mkqa",
    rows: ["mkqa"],
    size: 300,
    metric: "share of answers that contain a reference answer or alias (MKQA's he and en answers), and token F1",
    engine: "ollama",
    fields: (it) => [it.question],
    select: (pools, s, taken = {}) =>
      take(rankPool(pools.mkqa, s.split, "mkqa"), 300, { exclude: new Set((taken["ocr-he"] ?? []).map((x) => x.id.replace(/^ocr-/, ""))), accept: (r) => !!r.he_query && r.answers_he?.length && r.answers_he.every((a) => SHORT_TYPES.has(a.type)) }).map((r) => ({
        id: `mkqa-${r.id}`,
        question: r.he_query,
        answers: [...r.answers_he, ...(r.answers_en ?? []).filter((a) => SHORT_TYPES.has(a.type))].map((a) => ({ type: a.type, text: a.text ?? "", aliases: a.aliases ?? [] })),
      })),
  },
  {
    id: "ocr-he",
    prefix: "ocr-",
    task: "Hebrew OCR: printed lines rendered in four fonts the golden OCR set does not use, clean and degraded",
    plan: ["W6.17", "7.5"],
    source: "mkqa",
    sourceAlso: ["fontsource"],
    rows: ["mkqa"],
    size: 120,
    after: ["qa-he"],
    metric: "CER per condition (the app's tesseract.js pipeline and src/ai/ocrCer.ts)",
    engine: "ocr",
    fields: (it) => [it.text],
    select: (pools, s, taken) => {
      const exclude = new Set((taken["qa-he"] ?? []).map((x) => x.id.replace(/^mkqa-/, "")));
      return take(rankPool(pools.mkqa, s.split, "mkqa"), 120, { exclude, accept: (r) => !!r.he_query && r.he_query.length >= 12 && r.he_query.length <= 70 && HEBREW_LINE.test(r.he_query) }).map((r) => {
        const pick = (what, n) => Number.parseInt(createHmac("sha256", s.split).update(`ocr:${what}:${r.id}`).digest("hex").slice(0, 8), 16) % n;
        return { id: `ocr-${r.id}`, text: r.he_query, font: OCR_FONTS[pick("font", OCR_FONTS.length)].family, size: [22, 28, 34][pick("size", 3)], condition: ["clean", "clean", "degraded"][pick("cond", 3)] };
      });
    },
  },
  {
    id: "asr-he",
    prefix: "",
    task: "Hebrew dictation WER: read sentences from FLEURS's train split, which no dev set samples",
    plan: ["W6.17", "6.1", "W4.13"],
    source: "fleurs",
    rows: ["fleurs"],
    size: 200,
    metric: "WER and CER (scripts/asr/eval.mjs, the same engine as models:day's asr-zipformer step)",
    engine: "asr",
    fields: (it) => [it.text],
    select: (pools, s) =>
      take(rankPool(pools.fleurs, s.split, "fleurs-train"), 200, { accept: (r) => r.durationMs >= 2000 && r.durationMs <= 20000 && !!r.text }).map((r) => ({ id: r.id, text: r.text, durationMs: r.durationMs, file: r.file, audio: `fleurs/${r.file.replace(/\.[a-z0-9]+$/i, "")}.opus` })),
  },
  {
    id: "grammar-he",
    prefix: "massive-dev-",
    task: "Hebrew grammar and spelling: does the sentence have an error? Human labels from MASSIVE's crowd judgments (dev partition)",
    plan: ["W6.17", "W5.3"],
    source: "massive",
    rows: ["massive-validation"],
    size: 300,
    metric: "precision, recall and F1 of \"has an error\" (150 flawed + 150 clean); the model as judge, and the app's checker where the branch has it",
    engine: "ollama",
    fields: (it) => [it.text],
    select: (pools, s) => {
      const labelled = pools["massive-validation"].map((r) => ({ r, label: grammarLabel(r.judgments) })).filter((x) => x.label);
      const ranked = rankPool(labelled, s.split, "massive-validation", (x) => x.r.id);
      const half = (label) => take(ranked, 150, { accept: (x) => x.label === label, key: (x) => x.r.id });
      return [...half("flawed"), ...half("clean")].map((x) => ({ id: `massive-dev-${x.r.id}`, text: x.r.utt, flawed: x.label === "flawed" }));
    },
  },
  {
    id: "xling",
    prefix: "gmmlu-",
    task: "Cross-lingual parity: the same MMLU question in Hebrew, in English, and Hebrew with English options",
    plan: ["W6.17", "W5.28", "E49"],
    source: "global-mmlu",
    rows: ["global-mmlu"],
    size: 200,
    metric: "accuracy in Hebrew, in English and mixed; the Hebrew − English gap",
    engine: "ollama",
    fields: (it) => [it.he.question, it.en.question],
    select: (pools, s) =>
      take(rankPool(pools["global-mmlu"], s.split, "global-mmlu"), 200, { accept: (r) => r.he?.question && r.en?.question && r.he.options?.length === 4 && r.en.options?.length === 4 && /^[A-D]$/.test(r.answer) }).map((r) => ({ id: `gmmlu-${r.id}`, subject: r.subject, he: r.he, en: r.en, answer: r.answer })),
  },
  {
    id: "toolcall-he",
    prefix: "massive-test-",
    task: "Hebrew tool calls: a spoken-style request → the right tool with the right arguments (MASSIVE he-IL test partition)",
    plan: ["W6.17", "W4.31", "W5.20", "5.3"],
    source: "massive",
    rows: ["massive-test"],
    size: 300,
    metric: "valid calls (W4.31's target ≥ 95 %), right intent, slot F1",
    engine: "ollama",
    fields: (it) => [it.text],
    select: (pools, s) => {
      const pool = pools["massive-test"];
      const tools = toolsOf(pool);
      const byScenario = new Map();
      for (const name of Object.keys(tools)) {
        const sc = name.split("_")[0];
        (byScenario.get(sc) ?? byScenario.set(sc, []).get(sc)).push(name);
      }
      const all = Object.keys(tools).sort();
      return take(rankPool(pool, s.split, "massive-test"), 300, { accept: (r) => !!tools[r.intent] }).map((r) => {
        const own = byScenario.get(r.intent.split("_")[0]) ?? [r.intent];
        const others = rankPool(all.filter((n) => !own.includes(n)).map((id) => ({ id })), s.split, `distractors:${r.id}`).slice(0, 4).map((x) => x.id);
        return { id: `massive-test-${r.id}`, text: r.utt, intent: r.intent, slots: parseSlots(r.annot_utt), tools: [...own, ...others].sort().map((name) => ({ name, params: tools[name] })) };
      });
    },
  },
];

/** MASSIVE intents as tools: each intent's slot types (seen anywhere in the partition) are its parameters. */
export function toolsOf(pool) {
  const tools = {};
  for (const r of pool) {
    if (!r.intent) continue;
    const t = (tools[r.intent] ??= new Set());
    for (const s of parseSlots(r.annot_utt)) t.add(s.type);
  }
  return Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, [...v].sort()]));
}

export const setById = (id) => SETS.find((s) => s.id === id);

/** Draw every set from its pools, in order, so sets sharing a pool stay disjoint. */
export function drawAll(sets, pools, secrets) {
  const taken = {};
  for (const set of sets) {
    for (const dep of set.after ?? []) if (!taken[dep]) taken[dep] = setById(dep).select(pools, secrets, taken);
    taken[set.id] = set.select(pools, secrets, taken);
  }
  return Object.fromEntries(sets.map((s) => [s.id, taken[s.id]]));
}
