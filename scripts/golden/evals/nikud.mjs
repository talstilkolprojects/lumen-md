/**
 * Harness for the nikud golden set (plan 6.3, Hebrew niqqud on this device).
 *
 * Runs the shipped code — addNikud() from src/text/nikudRun.ts through tsx —
 * with onnxruntime-node and a Nakdimon ONNX file:
 *   --model PATH, or NAKDIMON_ONNX, or models/nakdimon/Nakdimon.onnx
 * (the file model-convert.yml mirrors; sha256 in models/registry.json).
 *
 * Per part (benyehuda = classical, nakdimon = modern, the acceptance part):
 *   <part>_word_acc       Hebrew words whose points are all right
 *   <part>_word_acc_voc   same, vowels compared as pronounced (Nakdimon's
 *                         "VOC": qamats = patah, tsere = segol, shva and
 *                         dagesh lene ignored)
 *   <part>_der            letters with a wrong mark set / letters that take one
 *   skeleton_ok           outputs whose consonants equal the input's (must be 1)
 *
 * Numbers only; no item, input or output is ever reported. Without a model
 * file it returns { models_measured: 0 } — "not measured", never a number.
 *
 *   node scripts/golden/evals/nikud.mjs --dev [--model PATH]
 *   node scripts/golden/evals/nikud.mjs --dev --menaked DIR   (plan W2.5)
 *
 * --menaked DIR (or MENAKED_DIR): DictaBERT-char-menaked instead — the
 * folder scripts/models/export-menaked.py writes (model_quantized.onnx +
 * menaked.json), through the same decoding the worker uses. Also reports
 * ms_per_20_words, measured with onnxruntime-node on the machine running
 * it: a sanity check only; W2.5's latency targets are browser numbers.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);

export function modelPath() {
  return opt("--model") ?? process.env.NAKDIMON_ONNX ?? join(ROOT, "models", "nakdimon", "Nakdimon.onnx");
}

export function menakedDir() {
  return opt("--menaked") ?? process.env.MENAKED_DIR ?? null;
}

/** DictaBERT-char-menaked as a NikudEngine (src/text/nikudRun.ts), as in src/ai/nikud.worker.ts. */
async function menakedEngine(dir) {
  const ort = require("onnxruntime-node");
  const { decodeMenaked, encodeMenaked, parseMenakedSpec } = await tsImport("../../../src/text/menaked.ts", import.meta.url);
  const spec = parseMenakedSpec(JSON.parse(readFileSync(join(dir, "menaked.json"), "utf8")));
  const s = await ort.InferenceSession.create(join(dir, "model_quantized.onnx"));
  return {
    maxlen: spec.maxTokens - 1,
    async run(batch) {
      const { ids, mask, length } = encodeMenaked(batch, spec);
      const dims = [batch.length, length];
      const feeds = { [spec.inputs.ids]: new ort.Tensor("int64", ids, dims), [spec.inputs.mask]: new ort.Tensor("int64", mask, dims) };
      if (spec.inputs.types) feeds[spec.inputs.types] = new ort.Tensor("int64", new BigInt64Array(ids.length), dims);
      const out = await s.run(feeds);
      const logits = { nikud: out[spec.outputs.nikud].data, shin: out[spec.outputs.shin].data };
      return batch.map((chunk, row) => decodeMenaked(chunk, logits, row, length, spec));
    },
  };
}

let session;
async function infer(path) {
  if (!session) {
    const ort = require("onnxruntime-node");
    const s = await ort.InferenceSession.create(path);
    session = async (ids, rows, length) => {
      const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("int32", ids, [rows, length]) });
      return { N: out.N.data, D: out.D.data, S: out.S.data };
    };
  }
  return session;
}

const LETTER = /[א-ת]/;
// What a reference may carry that the model never writes: cantillation, meteg, rafe.
const NOT_MODELLED = /[֑-ֽֿׅ֯ׄ]/g;

function normalizeRef(s) {
  return s.normalize("NFD").replace(NOT_MODELLED, "").replace(/ׇ/g, "ָ");
}

/** Nakdimon's vocalize(): vowels as pronounced. */
function voc(marks, letter) {
  return [...marks]
    .map((m) => {
      if (m === "ּ") return "בכפ".includes(letter) || letter === "ו" ? m : "";
      if ("ֲַָ".includes(m)) return "ַ";
      if ("ֳֹ".includes(m)) return "ֹ";
      if (m === "ֻ") return "ֻ";
      if ("ֱֵֶ".includes(m)) return "ֶ";
      if (m === "ְ") return "";
      return m;
    })
    .join("");
}

/** [letter, sorted marks] for every Hebrew letter of a word. */
function letters(word, canon) {
  const out = [];
  for (const m of canon(word).matchAll(/([א-ת])([ְ-ׇ]*)/g)) out.push([m[1], [...m[2]].sort().join("")]);
  return out;
}

export async function score({ items }, path = modelPath(), menaked = menakedDir()) {
  if (menaked ? !existsSync(join(menaked, "menaked.json")) : !existsSync(path)) return { models_measured: 0 };
  const run = menaked ? await menakedEngine(menaked) : await infer(path);
  let ms = 0;
  let words20 = 0;
  const { addNikud } = await tsImport("../../../src/text/nikudRun.ts", import.meta.url);
  const { canonicalMarks, removeNikud, sameSkeleton } = await tsImport("../../../src/text/nikud.ts", import.meta.url);
  const canon = (s) => canonicalMarks(normalizeRef(s));
  const tally = {};
  let skeletonOk = 0;
  for (const it of items) {
    const part = it.part ?? String(it.id ?? "").split("-")[0];
    const t = (tally[part] ??= { words: 0, exact: 0, voc: 0, letters: 0, wrong: 0 });
    const ref = String(it.text ?? "");
    const input = it.plain ?? removeNikud(ref);
    const t0 = performance.now();
    const hyp = await addNikud(input, run);
    ms += performance.now() - t0;
    words20 += input.split(/\s+/).filter(Boolean).length / 20;
    if (sameSkeleton(hyp, input)) skeletonOk++;
    const rw = ref.split(/\s+/).filter((w) => LETTER.test(w));
    const hw = hyp.split(/\s+/).filter((w) => LETTER.test(w));
    if (rw.length !== hw.length) {
      t.words += rw.length; // misaligned: every word counts as wrong
      continue;
    }
    rw.forEach((r, k) => {
      const a = letters(r, canon);
      const b = letters(hw[k], canon);
      t.words++;
      let exact = a.length === b.length;
      let vocOk = exact;
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        t.letters++;
        if (a[i][1] !== b[i][1]) {
          t.wrong++;
          exact = false;
        }
        if (voc(a[i][1], a[i][0]) !== voc(b[i][1], b[i][0])) vocOk = false;
      }
      if (exact) t.exact++;
      if (vocOk) t.voc++;
    });
  }
  const out = { models_measured: 1, engine: menaked ? "menaked" : "nakdimon", skeleton_ok: items.length ? skeletonOk / items.length : NaN, ms_per_20_words: words20 ? Math.round(ms / words20) : NaN };
  for (const [part, t] of Object.entries(tally)) {
    out[`${part}_word_acc`] = t.words ? t.exact / t.words : NaN;
    out[`${part}_word_acc_voc`] = t.words ? t.voc / t.words : NaN;
    out[`${part}_der`] = t.letters ? t.wrong / t.letters : NaN;
  }
  return out;
}

/** The dev items: benyehuda (committed) and nakdimon (local/, fetched by hf_build.py fetch-local). */
export function devItems() {
  const dir = join(ROOT, "eval", "golden", "nikud");
  const by = JSON.parse(readFileSync(join(dir, "dev", "benyehuda.json"), "utf8")).items.map((x) => ({ ...x, part: "benyehuda" }));
  const localFile = join(dir, "local", "nakdimon.json");
  const nak = existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")).items.map((x) => ({ ...x, part: "nakdimon" })) : [];
  return [...by, ...nak];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && argv.includes("--dev")) {
  const items = devItems();
  const counts = items.reduce((m, x) => ({ ...m, [x.part]: (m[x.part] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ split: "dev", model: menakedDir() ?? modelPath(), items: counts, ...(await score({ items })) }, null, 2));
}
