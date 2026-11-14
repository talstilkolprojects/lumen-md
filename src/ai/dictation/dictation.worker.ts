/// <reference lib="webworker" />
/**
 * Live dictation worker (plan 6.1): Silero VAD + the Zipformer2 streaming
 * engine on ONNX Runtime Web (wasm, the same-origin files staged by
 * scripts/copy-ort.mjs). Audio (16 kHz) comes in; interim text while the
 * user speaks and final text at each pause go out. Nothing here touches
 * the network: the model bytes are handed over by the main thread.
 */
import * as ort from "onnxruntime-web/wasm";
import { Silero } from "@ricky0123/vad-web/dist/models/silero";
import { ZipformerModel, type ZipformerStream } from "./zipformer";
import { EnergyVad, Framer, Segmenter } from "./segmenter";

export type DictationIn =
  | { type: "load"; ortBase: string; encoder: Uint8Array; decoder: Uint8Array; joiner: Uint8Array; tokens: string; vad: Uint8Array | null }
  | { type: "audio"; samples: Float32Array }
  | { type: "stop" };

export type DictationOut =
  | { type: "ready"; vad: "silero" | "energy"; loadMs: number }
  | { type: "speaking"; active: boolean }
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "stopped" }
  | { type: "error"; message: string };

const post = (m: DictationOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

/** Seconds of silence that flush the last chunk (> the encoder's 1.41 s window). */
const TAIL_S = 1.5;
/** Interim hypothesis every this many seconds of audio while no chunk is ready. */
const PEEK_S = 0.32;

let model: ZipformerModel | null = null;
let vad: { process: (f: Float32Array) => Promise<{ isSpeech: number }>; reset_state: () => void } | null = null;
const energy = new EnergyVad();
const framer = new Framer();
const segmenter = new Segmenter();
let stream: ZipformerStream | null = null;
let sincePeek = 0;
let lastInterim = "";
let queue: Promise<void> = Promise.resolve();

function interim(text: string) {
  if (text !== lastInterim) {
    lastInterim = text;
    post({ type: "interim", text });
  }
}

async function feed(s: ZipformerStream, audio: Float32Array) {
  s.acceptWaveform(audio);
  sincePeek += audio.length / 16000;
  if (s.isReady()) {
    await s.decode();
    sincePeek = 0;
    interim(s.result().text);
  } else if (sincePeek >= PEEK_S) {
    sincePeek = 0;
    interim((await s.peek()).text);
  }
}

async function finish(s: ZipformerStream, speechMs: number) {
  s.acceptWaveform(new Float32Array(Math.round(TAIL_S * 16000)));
  s.inputFinished();
  await s.decode();
  const text = s.result().text;
  lastInterim = "";
  if (speechMs >= segmenter.minSpeechMs && text) post({ type: "final", text });
  else post({ type: "interim", text: "" });
}

async function onAudio(samples: Float32Array) {
  if (!model) return;
  for (const frame of framer.push(samples)) {
    const prob = vad ? (await vad.process(frame)).isSpeech : energy.prob(frame);
    const step = segmenter.push(frame, prob);
    if (step.type === "start") {
      stream = model.createStream();
      sincePeek = 0;
      post({ type: "speaking", active: true });
      for (const a of step.audio) await feed(stream, a);
    } else if (step.type === "speech" && stream) {
      await feed(stream, step.audio);
    } else if (step.type === "end" && stream) {
      stream.acceptWaveform(step.audio);
      const s = stream;
      stream = null;
      post({ type: "speaking", active: false });
      await finish(s, step.speechMs);
    }
  }
}

async function onLoad(m: Extract<DictationIn, { type: "load" }>) {
  const t0 = performance.now();
  ort.env.wasm.wasmPaths = { mjs: `${m.ortBase}ort-wasm-simd-threaded.mjs`, wasm: `${m.ortBase}ort-wasm-simd-threaded.wasm` };
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1)) : 1;
  model = await ZipformerModel.load(ort, { encoder: m.encoder, decoder: m.decoder, joiner: m.joiner, tokens: m.tokens });
  if (m.vad) {
    try {
      const bytes = m.vad;
      vad = await Silero.new(ort, async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch {
      vad = null;
    }
  }
  post({ type: "ready", vad: vad ? "silero" : "energy", loadMs: Math.round(performance.now() - t0) });
}

async function onStop() {
  const open = segmenter.flush();
  if (open && stream) {
    const s = stream;
    stream = null;
    post({ type: "speaking", active: false });
    await finish(s, open.speechMs);
  }
  vad?.reset_state();
  post({ type: "stopped" });
}

self.onmessage = (ev: MessageEvent<DictationIn>) => {
  const m = ev.data;
  // One message at a time, in order: decoding is async (ONNX Runtime).
  queue = queue
    .then(() => (m.type === "load" ? onLoad(m) : m.type === "audio" ? onAudio(m.samples) : onStop()))
    .catch((e: unknown) => post({ type: "error", message: e instanceof Error ? e.message : String(e) }));
};
