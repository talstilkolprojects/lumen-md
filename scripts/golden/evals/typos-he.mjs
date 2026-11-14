#!/usr/bin/env node
/**
 * Harness for typos-he (plan 9.2): the offline Hebrew checker — the
 * dictionary-free rules plus the bundled FrequencyWords list, with no
 * Hspell and no network — on the 7.1 spelling-error set.
 *
 *   recall_nonword   share of the non-word errors (`nonword: true`) that a
 *                    finding overlaps, in `text`              (target ≥ 0.70)
 *   fp_per_token     findings on the `clean` side per Hebrew word (≤ 0.05)
 *   fp_sentences     share of clean sentences with any finding (reported)
 *
 * In CI, run-evals.mjs calls score() on the test split and publishes only
 * these numbers. Locally, `node scripts/golden/evals/typos-he.mjs` scores
 * the committed dev split.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const WORD = /[א-ת]+(?:["״'׳][א-ת]+)?/g;

async function checker() {
  const freq = await tsImport(pathToFileURL(join(ROOT, "src/ai/hebrewFreq.ts")).href, import.meta.url);
  const spell = await tsImport(pathToFileURL(join(ROOT, "src/ai/hebrewSpell.ts")).href, import.meta.url);
  const list = freq.parseFrequencyList(readFileSync(join(ROOT, "public", freq.HEBREW_FREQ_PATH), "utf8"));
  return (text) => freq.offlineHebrewChecks(list, text, spell.hebrewRules);
}

export async function score({ items }) {
  const check = await checker();
  let errors = 0;
  let found = 0;
  let tokens = 0;
  let fp = 0;
  let fpSentences = 0;
  for (const it of items) {
    const hits = check(it.text);
    for (const e of it.errors ?? []) {
      if (!e.nonword) continue;
      errors++;
      if (hits.some((m) => m.offset < e.end && e.start < m.offset + m.length)) found++;
    }
    if (typeof it.clean === "string") {
      const clean = check(it.clean);
      fp += clean.length;
      if (clean.length) fpSentences++;
      tokens += [...it.clean.matchAll(WORD)].length;
    }
  }
  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    recall_nonword: errors ? r(found / errors) : NaN,
    fp_per_token: tokens ? r(fp / tokens) : NaN,
    fp_sentences: items.length ? r(fpSentences / items.length) : NaN,
    errors,
    clean_tokens: tokens,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadSet } = await import("../../lib/golden.mjs");
  const { GOLDEN } = await import("../common.mjs");
  const { items } = loadSet(GOLDEN, "typos-he", { split: "dev" });
  console.log(JSON.stringify({ split: "dev", items: items.length, ...(await score({ items })) }, null, 2));
}
