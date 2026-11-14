/**
 * Neural Hebrew read-aloud (plan W2.6): niqqud (6.3 / W2.5) → IPA
 * (./hebrewG2P.ts) → a licensed Piper-format voice (./voices.ts) in a worker
 * (./piper.worker.ts) → Web Audio, with the word being read highlighted.
 *
 * Dormant until a voice exists: HEBREW_VOICES is empty (decision 15.10), so
 * `neuralHebrewVoice()` returns null without importing or fetching
 * anything, and read-aloud stays on the system voices. With a voice:
 * - its two files download once, after consent, from pinned URLs, and are
 *   checked against their sha256 before use (Cache Storage "lumen-voices");
 *   after that, reading makes no network request;
 * - the next sentence is synthesized while the current one plays, so only
 *   the first sentence waits; `onFirstAudio` reports that wait (target
 *   < 400 ms on the desktop, plan W2.6).
 */
import { HEBREW_VOICES, parsePiperConfig, phonemeIds, scales, usableVoices, wordTimes, type PiperConfig, type VoiceFile, type VoicePack } from "./voices";
import { isVocalized, sentenceToIpa, wordToIpa } from "./hebrewG2P";
import type { Sentence, WordRange } from "../tts";

/** The voice to read Hebrew with, or null (today: always null — no licensed voice). */
export async function neuralHebrewVoice(): Promise<VoicePack | null> {
  if (!HEBREW_VOICES.length) return null;
  const mod = (await import("../../../models/registry.json")) as unknown as { default?: { models: Array<{ id: string; class: string; verified: boolean }> }; models?: Array<{ id: string; class: string; verified: boolean }> };
  return usableVoices(HEBREW_VOICES, (mod.default ?? mod).models ?? [])[0] ?? null;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** A pinned file from Cache Storage or its URL, refused unless its sha256 matches. */
export async function verifiedFile(f: VoiceFile, deps: { fetch?: typeof fetch; caches?: CacheStorage | null } = {}): Promise<ArrayBuffer> {
  const cache = deps.caches === undefined ? (typeof caches !== "undefined" ? await caches.open("lumen-voices") : null) : deps.caches ? await deps.caches.open("lumen-voices") : null;
  const hit = await cache?.match(f.url);
  const res = hit ?? (await (deps.fetch ?? fetch)(f.url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.clone().arrayBuffer();
  if (body.byteLength !== f.bytes || hex(await crypto.subtle.digest("SHA-256", body)) !== f.sha256) {
    if (hit) await cache?.delete(f.url);
    throw new Error("voice file does not match its checksum");
  }
  if (!hit) await cache?.put(f.url, res);
  return body;
}

export interface Synth {
  config: PiperConfig;
  synth(ids: number[], scales: [number, number, number]): Promise<Float32Array>;
}

let worker: { voice: string; synth: Synth } | null = null;

async function loadSynth(voice: VoicePack): Promise<Synth> {
  if (worker?.voice === voice.id) return worker.synth;
  const [model, configBytes] = await Promise.all([verifiedFile(voice.model), verifiedFile(voice.config)]);
  const config = parsePiperConfig(JSON.parse(new TextDecoder().decode(configBytes)));
  const w = new Worker(new URL("./piper.worker.ts", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  w.onmessage = (e: MessageEvent<{ type: string; id: number; value?: unknown; message?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.type === "result") p.resolve(e.data.value);
    else p.reject(new Error(e.data.message ?? "voice error"));
  };
  const call = <T>(msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage({ ...msg, id }, transfer);
    });
  await call({ type: "load", model, ortBase: `${import.meta.env.BASE_URL ?? "/"}ort/` }, [model]);
  const synth: Synth = {
    config,
    synth: async (ids, sc) => (await call<{ audio: Float32Array }>({ type: "synth", ids, scales: sc, speaker: voice.speaker })).audio,
  };
  worker = { voice: voice.id, synth };
  return synth;
}

/** One sentence → what to synthesize, and each spoken word's IPA (for the word timings). */
export function prepareSentence(vocalized: string): { ipa: string; words: string[] } {
  const words = vocalized.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return { ipa: sentenceToIpa(vocalized), words: words.map((w) => wordToIpa(w)) };
}

export interface NeuralOptions {
  rate?: number;
  /** Adds niqqud to unpointed Hebrew (the niqqud service); text already pointed is used as is. */
  point: (text: string) => Promise<string>;
  onSentence?: (s: Sentence, index: number) => void;
  onWord?: (s: Sentence, word: WordRange) => void;
  onFirstAudio?: (ms: number) => void;
  startAt?: number;
  signal?: AbortSignal;
  /** The note, for mapping words back to it. */
  source: string;
  /** Tests. */
  synth?: Synth;
  audio?: AudioContext;
  wordRanges: (source: string, s: Sentence) => WordRange[];
}

/** Read `sentences` with the neural voice; resolves when done or aborted. */
export async function speakNeural(voice: VoicePack, sentences: readonly Sentence[], opts: NeuralOptions): Promise<void> {
  const t0 = performance.now();
  const synth = opts.synth ?? (await loadSynth(voice));
  const ctx = opts.audio ?? new AudioContext();
  const rate = opts.rate ?? 1;
  const render = async (s: Sentence) => {
    const pointed = isVocalized(s.text) ? s.text : await opts.point(s.text);
    const { ipa, words } = prepareSentence(pointed);
    const { ids } = phonemeIds(ipa, synth.config);
    return { audio: await synth.synth(ids, scales(synth.config, rate)), words };
  };
  let first = true;
  let next = sentences[opts.startAt ?? 0] ? render(sentences[opts.startAt ?? 0]) : null;
  for (let i = opts.startAt ?? 0; i < sentences.length && next; i++) {
    if (opts.signal?.aborted) return;
    const s = sentences[i];
    const { audio, words } = await next;
    next = i + 1 < sentences.length ? render(sentences[i + 1]) : null; // prefetch while this one plays
    if (opts.signal?.aborted) return;
    const buf = ctx.createBuffer(1, audio.length, synth.config.audio.sample_rate);
    buf.copyToChannel(Float32Array.from(audio), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    opts.onSentence?.(s, i);
    if (first) {
      opts.onFirstAudio?.(performance.now() - t0);
      first = false;
    }
    const ranges = opts.wordRanges(opts.source, s);
    const timers = wordTimes(words, buf.duration).map((at, w) => (ranges[w] ? setTimeout(() => !opts.signal?.aborted && opts.onWord?.(s, ranges[w]), at * 1000) : null));
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      opts.signal?.addEventListener("abort", () => {
        try {
          src.stop();
        } catch {
          // why: the source already stopped (it ended before the abort)
          /* not started */
        }
        resolve();
      }, { once: true });
      src.start();
    });
    for (const tm of timers) if (tm) clearTimeout(tm);
  }
}
