/**
 * Per golden set (plan 7.8): what the page gets for each item and how its
 * outputs are scored. The scoring is the set's own metric (manifest.metric).
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { ndcgAt } from "../golden/evals/retrieval.mjs";
import { errorRate, normalizeAsr, normalizeOcr, round } from "./metrics.mjs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".webm": "audio/webm" };

/** An asset path (loadSet makes it absolute) → a data: URL the page can fetch. */
export function dataUrl(path) {
  const type = MIME[extname(path).toLowerCase()];
  if (!type) throw new Error(`no media type for ${extname(path)}`);
  return `data:${type};base64,${readFileSync(path).toString("base64")}`;
}

const byPart = (items) => {
  const m = new Map();
  for (const it of items) m.set(it.part, [...(m.get(it.part) ?? []), it]);
  return m;
};

export const TASKS = {
  retrieval: {
    payload: ({ items, corpus }) => ({
      shared: corpus,
      items: items.map((it) => ({ id: it.id, part: it.part, input: { query: it.query, skip: it.sameArticle ?? [] } })),
    }),
    /** nDCG@10 per part and over all items. */
    score(items, outputs) {
      const out = {};
      let all = 0;
      for (const [part, list] of byPart(items)) {
        let sum = 0;
        for (const it of list) sum += ndcgAt(Array.isArray(outputs[it.id]) ? outputs[it.id] : [], it.relevant, 10);
        out[`ndcg@10.${part}`] = round(sum / list.length);
        all += sum;
      }
      out["ndcg@10"] = round(all / (items.length || 1));
      return out;
    },
  },
  "ocr-he": {
    payload: ({ items }) => ({ items: items.map((it) => ({ id: it.id, part: it.part, input: { image: dataUrl(it.image) } })) }),
    /** CER per part and per condition (clean, degraded, nikud — nikud is report only, so `cer` leaves it out). */
    score(items, outputs) {
      const rates = new Map();
      const get = (k) => (rates.has(k) ? rates.get(k) : (rates.set(k, errorRate()), rates.get(k)));
      for (const it of items) {
        const ref = [...normalizeOcr(it.text)];
        const hyp = [...normalizeOcr(typeof outputs[it.id] === "string" ? outputs[it.id] : "")];
        get(`cer.${it.part}`).add(ref, hyp);
        get(`cer.${it.condition ?? "all"}`).add(ref, hyp);
        if (it.condition !== "nikud") get("cer").add(ref, hyp);
      }
      return Object.fromEntries([...rates].map(([k, r]) => [k, round(r.value)]));
    },
  },
  "asr-he": {
    payload: ({ items }) => ({ items: items.map((it) => ({ id: it.id, part: it.part, input: { audio: dataUrl(it.audio) } })) }),
    /** WER and CER per part and over all items, after the set's normalisation. */
    score(items, outputs) {
      const rates = new Map();
      const get = (k) => (rates.has(k) ? rates.get(k) : (rates.set(k, errorRate()), rates.get(k)));
      for (const it of items) {
        const ref = normalizeAsr(it.text);
        const hyp = normalizeAsr(typeof outputs[it.id] === "string" ? outputs[it.id] : "");
        const words = (s) => (s ? s.split(" ") : []);
        for (const k of ["", `.${it.part}`]) {
          get(`wer${k}`).add(words(ref), words(hyp));
          get(`cer${k}`).add([...ref.replace(/ /g, "")], [...hyp.replace(/ /g, "")]);
        }
      }
      return Object.fromEntries([...rates].map(([k, r]) => [k, round(r.value)]));
    },
  },
};
