/**
 * Harness for the Hebrew speech-recognition golden set (plan 6.1, 7.1):
 * WER and CER per part (FLEURS, Common Voice, the owner's), after the set's
 * normalisation — NFC, no punctuation, no niqqud — and the latency of live
 * dictation, on the engine the browser runs — the app's Zipformer2 port on
 * onnxruntime-web's WebAssembly build — or on sherpa-onnx's WebAssembly
 * build as the reference (LUMEN_ASR_ENGINE=sherpa), with the ivrit.ai
 * Zipformer2 streaming model (int8).
 *
 *   score({ items }) → { "wer.fleurs": 0.1, "cer.fleurs": …, "wer": …, "latency.p95Ms": …, "rtf": … }
 *
 * The model is not in the repo (72 MB): LUMEN_ASR_MODEL_DIR points to the
 * folder with encoder/decoder/joiner .int8.onnx and tokens.txt
 * (scripts/asr/fetch-model.sh downloads it). Audio is decoded with ffmpeg.
 *
 * Latency is measured, not assumed: the audio is fed in 64 ms slices at
 * real time (a clock that advances with the audio and with every
 * millisecond of decoding), and each word's latency is when it is on screen
 * — committed (latency.*) or already in an interim hypothesis that the
 * final text confirms (shown.*) — minus when it was spoken (the token
 * timestamps). Reported as p50 / p95 over every word.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/* ── Normalisation and error rates ───────────────────────────────────── */

const MARKS = /[֑-ׇֽֿׁׂׅׄ]/g;

/** The set's normal form: NFC, no niqqud or cantillation, no punctuation, single spaces, lower case. */
export function normalizeAsr(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(MARKS, "")
    .normalize("NFC")
    .replace(/[־\-‐-―]/g, " ") // maqaf and dashes join words: split them
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Edit distance between two sequences. */
export function editDistance(a, b) {
  const n = a.length;
  const m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[m];
}

/** Errors and reference length, words and characters, of one hypothesis (both normalised here). */
export function errors(reference, hypothesis) {
  const r = normalizeAsr(reference);
  const h = normalizeAsr(hypothesis);
  const rw = r ? r.split(" ") : [];
  const hw = h ? h.split(" ") : [];
  const rc = [...r.replace(/ /g, "")];
  const hc = [...h.replace(/ /g, "")];
  return { wordErrors: editDistance(rw, hw), words: rw.length, charErrors: editDistance(rc, hc), chars: rc.length };
}

/** Corpus-level rates: total edits over total reference length. */
export function rates(list) {
  const sum = (k) => list.reduce((s, x) => s + x[k], 0);
  return { wer: sum("words") ? sum("wordErrors") / sum("words") : 0, cer: sum("chars") ? sum("charErrors") / sum("chars") : 0 };
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/* ── Audio and the engine ─────────────────────────────────────────────── */

/** 16 kHz mono float samples of any audio file (ffmpeg). */
export function decodeAudio(path) {
  const r = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${path}`);
  const buf = r.stdout;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

export const MODEL = {
  repo: "ivrit-ai/zipformer2-66m-streaming-he",
  files: ["sherpa-onnx/encoder.int8.onnx", "sherpa-onnx/decoder.int8.onnx", "sherpa-onnx/joiner.int8.onnx", "sherpa-onnx/tokens.txt"],
};

/**
 * The recognizer, on WebAssembly either way, behind sherpa-onnx's
 * interface (createStream / acceptWaveform / isReady / decode / getResult):
 *   - "lumen" (default): the app's own engine, src/ai/dictation/zipformer.ts
 *     on onnxruntime-web's wasm build — what the browser runs;
 *   - "sherpa": sherpa-onnx's WebAssembly build (npm `sherpa-onnx`), the reference.
 */
export async function createRecognizer(modelDir = process.env.LUMEN_ASR_MODEL_DIR, engine = process.env.LUMEN_ASR_ENGINE ?? "lumen") {
  if (!modelDir || !existsSync(join(modelDir, "encoder.int8.onnx"))) throw new Error("the streaming model is not downloaded (LUMEN_ASR_MODEL_DIR; scripts/asr/fetch-model.sh)");
  return engine === "sherpa" ? sherpaRecognizer(modelDir) : lumenRecognizer(modelDir);
}

async function sherpaRecognizer(modelDir) {
  // Not a dependency of the app: the ASR workflow installs it (npm i --no-save sherpa-onnx@1.13.8).
  const pkg = process.env.LUMEN_SHERPA_ONNX ?? "sherpa-onnx";
  const sherpa = (await import(/* @vite-ignore */ pkg)).default;
  const r = sherpa.createOnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: join(modelDir, "encoder.int8.onnx"), decoder: join(modelDir, "decoder.int8.onnx"), joiner: join(modelDir, "joiner.int8.onnx") },
      tokens: join(modelDir, "tokens.txt"),
      numThreads: 1,
      provider: "cpu",
      debug: 0,
      modelType: "zipformer2",
    },
    decodingMethod: "greedy_search",
    enableEndpoint: 0,
  });
  return {
    createStream: () => {
      const s = r.createStream();
      return { acceptWaveform: (x) => s.acceptWaveform(16000, x), inputFinished: () => s.inputFinished(), free: () => s.free?.(), raw: s };
    },
    isReady: (s) => r.isReady(s.raw),
    decode: (s) => r.decode(s.raw),
    getResult: (s) => r.getResult(s.raw),
  };
}

/** The app's engine, bundled from src/ with rolldown (Vite's bundler) for Node. */
export async function lumenRecognizer(modelDir) {
  const bundler = "rolldown";
  const { rolldown } = await import(/* @vite-ignore */ bundler);
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
  const out = join(mkdtempSync(join(tmpdir(), "lumen-asr-")), "zipformer.mjs");
  const bundle = await rolldown({ input: join(root, "src/ai/dictation/zipformer.ts"), platform: "node", external: ["onnxruntime-web"], logLevel: "silent" });
  await bundle.write({ file: out, format: "esm" });
  await bundle.close();
  const { ZipformerModel } = await import(pathToFileURL(out).href);
  const ortPkg = "onnxruntime-web";
  const ort = await import(/* @vite-ignore */ ortPkg);
  ort.env.wasm.numThreads = 1;
  const read = (f) => new Uint8Array(readFileSync(join(modelDir, f)));
  const model = await ZipformerModel.load(ort, { encoder: read("encoder.int8.onnx"), decoder: read("decoder.int8.onnx"), joiner: read("joiner.int8.onnx"), tokens: readFileSync(join(modelDir, "tokens.txt"), "utf8") });
  return {
    createStream: () => model.createStream(),
    isReady: (s) => s.isReady(),
    decode: (s) => s.decode(),
    getResult: (s) => s.result(),
    peek: (s) => s.peek(),
  };
}

// Seconds of audio per feed: the app's capture posts 1024-sample blocks (64 ms).
const SLICE = 1024 / 16000;
/** Silence after the speech that the app's VAD waits for before it ends the segment (segmenter.ts, pauseMs). */
export const PAUSE = 0.7;
/** Silence the app then pads in at once to flush the last chunk (dictation.worker.ts, TAIL_S) — compute time only, no wall time. */
export const TAIL = 1.5;

/** How often the app asks for an interim hypothesis between chunks (s). */
export const PEEK = 0.32;

/** Index ranges [first, last] of each word in a token list (a word starts at "▁" or, from sherpa-onnx, " "). */
export function wordSpans(tokens) {
  const spans = [];
  tokens.forEach((t, i) => {
    if (i === 0 || /^[▁ ]/.test(t)) spans.push([i, i]);
    else spans[spans.length - 1][1] = i;
  });
  return spans;
}

/**
 * Per word of the final text, how long after it was spoken it was on
 * screen: the first hypothesis (interim or committed) whose tokens agree
 * with the final ones up to the word's end, minus the word's last token
 * timestamp. `snapshots` = [{ clock, tokens }] in time order.
 */
export function wordLatencies(final, snapshots) {
  const out = [];
  const same = (a, upto) => a.length > upto && a.slice(0, upto + 1).every((t, k) => t === final.tokens[k]);
  for (const [, last] of wordSpans(final.tokens)) {
    const hit = snapshots.find((s) => same(s.tokens, last));
    if (hit) out.push(Math.max(0, hit.clock - (final.timestamps[last] ?? hit.clock)));
  }
  return out;
}

/**
 * Transcribe one clip as live dictation would: 64 ms slices in real time,
 * a chunk decoded as soon as it is complete, and — when the engine can
 * (`peek`) — an interim hypothesis every 320 ms in between. The end of a
 * segment follows the app's path: the VAD's pause (0.7 s of silence, in
 * real time), then the 1.5 s flush padding fed at once — it costs compute,
 * not wall time. Returns the text, per-word latencies (committed, and
 * shown incl. interim), the compute time and the duration.
 */
export async function transcribeLive(recognizer, samples, now = () => performance.now() / 1000) {
  const stream = recognizer.createStream();
  let clock = 0; // wall time since the clip started, in seconds
  let compute = 0;
  const committed = [];
  const shown = [];
  const step = Math.round(SLICE * 16000);
  const timed = async (fn) => {
    const t0 = now();
    const r = await fn();
    const dt = now() - t0;
    compute += dt;
    clock += dt;
    return r;
  };
  const snap = (list, r) => list.push({ clock, tokens: [...(r.tokens ?? [])] });
  let lastPeek = 0;
  // The clip, then the pause the VAD waits for — both arrive in real time.
  const audio = new Float32Array(samples.length + Math.round(PAUSE * 16000));
  audio.set(samples);
  for (let at = 0; at < audio.length; at += step) {
    const slice = audio.subarray(at, Math.min(audio.length, at + step));
    clock = Math.max(clock, (at + slice.length) / 16000); // the audio arrives in real time
    stream.acceptWaveform(slice);
    if (recognizer.isReady(stream)) {
      await timed(async () => {
        while (recognizer.isReady(stream)) await recognizer.decode(stream);
      });
      const r = recognizer.getResult(stream);
      snap(committed, r);
      snap(shown, r);
      lastPeek = clock;
    } else if (recognizer.peek && clock - lastPeek >= PEEK) {
      const r = await timed(() => recognizer.peek(stream));
      snap(shown, r);
      lastPeek = clock;
    }
  }
  // The segment ended: the flush padding goes in at once, as the worker's finish() does.
  stream.acceptWaveform(new Float32Array(Math.round(TAIL * 16000)));
  stream.inputFinished();
  await timed(async () => {
    while (recognizer.isReady(stream)) await recognizer.decode(stream);
  });
  const r = recognizer.getResult(stream);
  snap(committed, r);
  snap(shown, r);
  stream.free?.();
  const final = { tokens: r.tokens ?? [], timestamps: r.timestamps ?? [] };
  return { text: r.text ?? "", latencies: wordLatencies(final, committed), shownLatencies: wordLatencies(final, shown), compute, duration: samples.length / 16000 };
}

/* ── The harness ──────────────────────────────────────────────────────── */

/** Scores of every part, with `transcribe(item) → { text, latencies, compute, duration }`. */
export async function scoreWith(transcribe, items) {
  const parts = new Map();
  const latencies = [];
  const shown = [];
  let compute = 0;
  let duration = 0;
  for (const it of items) {
    const out = await transcribe(it);
    if (!parts.has(it.part)) parts.set(it.part, []);
    parts.get(it.part).push(errors(it.text, out.text));
    latencies.push(...(out.latencies ?? []));
    shown.push(...(out.shownLatencies ?? []));
    compute += out.compute ?? 0;
    duration += out.duration ?? 0;
  }
  const scores = {};
  const all = [];
  for (const [part, list] of parts) {
    const r = rates(list);
    scores[`wer.${part}`] = round(r.wer);
    scores[`cer.${part}`] = round(r.cer);
    scores[`items.${part}`] = list.length;
    all.push(...list);
  }
  const r = rates(all);
  scores.wer = round(r.wer);
  scores.cer = round(r.cer);
  if (latencies.length) {
    scores["latency.p50Ms"] = Math.round(percentile(latencies, 50) * 1000);
    scores["latency.p95Ms"] = Math.round(percentile(latencies, 95) * 1000);
  }
  // With interim hypotheses (engines that can peek): when the word was first on screen, correct.
  if (shown.length) {
    scores["shown.p50Ms"] = Math.round(percentile(shown, 50) * 1000);
    scores["shown.p95Ms"] = Math.round(percentile(shown, 95) * 1000);
  }
  if (duration) scores.rtf = round(compute / duration);
  return scores;
}

const round = (x) => Math.round(x * 10000) / 10000;

export async function score({ items }) {
  const recognizer = await createRecognizer();
  return scoreWith(async (it) => transcribeLive(recognizer, decodeAudio(it.audio)), items);
}
