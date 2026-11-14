/**
 * Live dictation on this device (plan 1.3 / T37).
 *
 * The browser's `SpeechRecognition` is not local: Chrome streams the audio to
 * Google's servers. Under the local-only policy it is never used; elsewhere
 * only after the user agrees, and every use is written to the privacy ledger.
 * The default path records PCM from the microphone, cuts it into ~5-second
 * segments at 16 kHz and transcribes each one with Whisper in the
 * transformers.js worker — nothing leaves the device.
 *
 * This file holds the parts that need no DOM audio APIs, so they can be
 * tested: the engine choice, resampling and the segmenter.
 */
import type { AiPolicy } from "./policy";

/** Opt-in for the browser speech service (it sends audio to the vendor). */
export const WEB_SPEECH_KEY = "lumen.dictate.webSpeech";

export type DictationEngine = "local" | "webspeech";

/** Local unless the policy allows a network service and the user opted in. */
export function chooseDictationEngine(policy: AiPolicy, webSpeechAvailable: boolean, optedIn: boolean): DictationEngine {
  if (policy === "local-only" || !webSpeechAvailable || !optedIn) return "local";
  return "webspeech";
}

export function webSpeechOptedIn(): boolean {
  try {
    return localStorage.getItem(WEB_SPEECH_KEY) === "1";
  } catch {
    // why: storage blocked — treat as not opted in
    return false;
  }
}

/** Average-pooling resample of mono PCM to 16 kHz (Whisper's rate). */
export function downsampleTo16k(input: Float32Array, rate: number): Float32Array {
  if (rate === 16000) return input.slice();
  const ratio = rate / 16000;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return x.length ? Math.sqrt(s / x.length) : 0;
}

export interface SegmenterOptions {
  /** Input sample rate (the AudioContext's). */
  rate: number;
  /** Segment length in seconds (default 5). */
  seconds?: number;
  /** Segments quieter than this RMS are dropped (default 0.01). */
  silence?: number;
  /** Gets each 16 kHz segment, in order. */
  onSegment: (samples16k: Float32Array) => void;
}

/** Collects microphone frames and emits fixed-length 16 kHz segments; silent ones are skipped. */
export class Segmenter {
  private chunks: Float32Array[] = [];
  private length = 0;
  private readonly size: number;
  private readonly silence: number;

  constructor(private readonly opts: SegmenterOptions) {
    this.size = Math.round(opts.rate * (opts.seconds ?? 5));
    this.silence = opts.silence ?? 0.01;
  }

  push(frame: Float32Array): void {
    this.chunks.push(frame.slice());
    this.length += frame.length;
    while (this.length >= this.size) this.emit(this.size);
  }

  /** Emit whatever is buffered (on stop). */
  flush(): void {
    if (this.length) this.emit(this.length);
  }

  private emit(n: number): void {
    const seg = new Float32Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - filled);
      seg.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.length -= n;
    if (rms(seg) < this.silence) return;
    this.opts.onSegment(downsampleTo16k(seg, this.opts.rate));
  }
}

/** Runs async jobs one at a time, in order; a failed job doesn't stop the queue. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  add(job: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(job, job).catch(() => {});
    return this.tail;
  }
  idle(): Promise<void> {
    return this.tail;
  }
}
