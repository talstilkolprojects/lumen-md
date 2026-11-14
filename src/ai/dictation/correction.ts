/**
 * The Whisper pass over each finished sentence of live Hebrew dictation
 * (plan W4.13). The Zipformer streams text while the user speaks; at the
 * pause, the sentence's audio is transcribed again by ivrit.ai's turbo
 * (WebGPU) or Ozen v1 (WebGPU or wasm) and that text is inserted instead —
 * when it arrives within the deadline and reads as the same sentence.
 * Otherwise the streaming text is inserted: a slow or confused second pass
 * never costs the user their words.
 */
import type { EngineId } from "./engines";

/** p95 target for a corrected sentence (plan W4.13): after it, the streaming text goes in. */
export const CORRECTION_DEADLINE_MS = 2000;

/** Whisper reads at most 30 s; a longer sentence keeps its streaming text. */
export const CORRECTION_MAX_SECONDS = 30;

/** Below this character similarity the two passes heard different things (a segment boundary moved): keep the streaming text. */
export const MIN_SIMILARITY = 0.5;

export type SegmentCorrector = (audio: Float32Array, streamingText: string) => Promise<string>;

/** The models (WHISPER_MODELS.turboHe / .ozenHe in transformersEngine.ts — not imported, so the dictation session stays small). */
export const CORRECTION_MODEL: Record<"whisper-turbo-he" | "ozen-he", string> = {
  "whisper-turbo-he": "ivrit-ai/whisper-large-v3-turbo-onnx",
  "ozen-he": "itayinbar/Ozen-v1",
};

const letters = (s: string) => [...s.normalize("NFC").replace(/[\p{P}\p{S}\s֑-ׇ]/gu, "").toLowerCase()];

/** 1 − (character edit distance / longer length), on letters only. */
export function similarity(a: string, b: string): number {
  const x = letters(a);
  const y = letters(b);
  if (!x.length && !y.length) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/** Which text goes in: Whisper's when it is non-empty and reads as the same sentence. */
export function pickText(streaming: string, whisper: string | null): string {
  const w = (whisper ?? "").trim();
  if (!w) return streaming;
  if (!streaming.trim()) return w;
  return similarity(streaming, w) >= MIN_SIMILARITY ? w : streaming;
}

/**
 * A corrector for `engine`, over `transcribe` (transformersEngine's
 * transcribeAudio in the app). Never throws: on an error or after the
 * deadline it returns the streaming text.
 */
export function makeCorrector(
  engine: "whisper-turbo-he" | "ozen-he",
  transcribe: (audio: Float32Array, opts: { language: string; model: string; signal: AbortSignal }) => Promise<{ text: string }>,
  deadlineMs = CORRECTION_DEADLINE_MS,
): SegmentCorrector {
  return async (audio, streamingText) => {
    if (!audio.length || audio.length > CORRECTION_MAX_SECONDS * 16000) return streamingText;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => {
      timer = setTimeout(() => {
        ctl.abort();
        done(null);
      }, deadlineMs);
    });
    try {
      const out = await Promise.race([transcribe(audio, { language: "he", model: CORRECTION_MODEL[engine], signal: ctl.signal }).then((r) => r.text), late]);
      return pickText(streamingText, out);
    } catch {
      return streamingText;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Whether a correction model is already in the browser (transformers.js
 * keeps its files in the "transformers-cache" Cache Storage): live
 * dictation never downloads one. Transcribing a Hebrew file once fetches it.
 */
export async function downloadedCorrectionModels(cacheName = "transformers-cache"): Promise<Set<EngineId>> {
  const out = new Set<EngineId>();
  try {
    if (typeof caches === "undefined") return out;
    const cache = await caches.open(cacheName);
    const keys = (await cache.keys()).map((r) => r.url);
    for (const [engine, model] of Object.entries(CORRECTION_MODEL) as Array<[EngineId, string]>) {
      if (keys.some((u) => u.includes(`/${model}/`) && /\.onnx(\?|$)/.test(u))) out.add(engine);
    }
  } catch {
    /* why: no Cache Storage (private mode, file://): no correction */
  }
  return out;
}

/**
 * The audio of the sentence being spoken, at 16 kHz: blocks since the
 * previous finished sentence, capped at Whisper's window. The tail after a
 * pause is kept as the next sentence's start (the worker reports a pause a
 * little after the audio that ends it).
 */
export class SegmentAudio {
  private blocks: Float32Array[] = [];
  private length = 0;
  constructor(private readonly keepSeconds = 0.4) {}

  push(block: Float32Array): void {
    this.blocks.push(block.slice());
    this.length += block.length;
    const max = CORRECTION_MAX_SECONDS * 16000;
    while (this.length > max && this.blocks.length > 1) this.length -= this.blocks.shift()!.length;
  }

  /** The sentence's samples; what follows the pause stays for the next one. */
  take(): Float32Array {
    const all = new Float32Array(this.length);
    let at = 0;
    for (const b of this.blocks) {
      all.set(b, at);
      at += b.length;
    }
    const keep = Math.min(all.length, Math.round(this.keepSeconds * 16000));
    const tail = all.slice(all.length - keep);
    this.blocks = keep ? [tail] : [];
    this.length = keep;
    return all;
  }
}
