/**
 * Speech segments for live dictation (plan 6.1): per 32 ms frame (512
 * samples at 16 kHz) a speech probability — Silero VAD v5, or an energy
 * estimate when the VAD model is missing — decides when a segment starts
 * (with the 320 ms before it, so the first syllable is not cut) and when it
 * ends (after a pause), which is when its text is final and punctuated.
 * Pure: the caller feeds probabilities and frames, and gets back what to
 * do with each frame.
 */

export const FRAME = 512;

export interface SegmenterOptions {
  /** Over this probability a frame is speech (Silero's default 0.5). */
  positive: number;
  /** Under this a frame counts toward the pause (Silero's default: positive − 0.15). */
  negative: number;
  /** A pause this long ends the segment (ms). */
  pauseMs: number;
  /** Audio kept from before the speech started (ms). */
  preMs: number;
  /** Shorter segments are dropped as noise (ms of speech frames). */
  minSpeechMs: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = { positive: 0.5, negative: 0.35, pauseMs: 700, preMs: 320, minSpeechMs: 160 };

const MS_PER_FRAME = (FRAME / 16000) * 1000;

export type SegmentStep =
  | { type: "idle" }
  /** A segment starts: feed `audio` (the pre-roll and this frame) to a new stream. */
  | { type: "start"; audio: Float32Array[] }
  /** Inside a segment: feed the frame. */
  | { type: "speech"; audio: Float32Array }
  /** The pause ended the segment (after this frame was fed): finish the stream. `speechMs` = speech in it. */
  | { type: "end"; audio: Float32Array; speechMs: number };

export class Segmenter {
  private pre: Float32Array[] = [];
  private active = false;
  private silent = 0;
  private speech = 0;
  constructor(private readonly o: SegmenterOptions = DEFAULT_SEGMENTER) {}

  get speaking(): boolean {
    return this.active;
  }

  push(frame: Float32Array, prob: number): SegmentStep {
    if (!this.active) {
      if (prob >= this.o.positive) {
        this.active = true;
        this.silent = 0;
        this.speech = 1;
        const audio = [...this.pre, frame];
        this.pre = [];
        return { type: "start", audio };
      }
      this.pre.push(frame);
      while (this.pre.length * MS_PER_FRAME > this.o.preMs) this.pre.shift();
      return { type: "idle" };
    }
    if (prob < this.o.negative) this.silent++;
    else {
      this.silent = 0;
      if (prob >= this.o.positive) this.speech++;
    }
    if (this.silent * MS_PER_FRAME >= this.o.pauseMs) {
      this.active = false;
      const speechMs = this.speech * MS_PER_FRAME;
      this.silent = 0;
      this.speech = 0;
      return { type: "end", audio: frame, speechMs };
    }
    return { type: "speech", audio: frame };
  }

  /** The user stopped: end an open segment. */
  flush(): { speechMs: number } | null {
    if (!this.active) return null;
    this.active = false;
    const speechMs = this.speech * MS_PER_FRAME;
    this.speech = 0;
    this.silent = 0;
    return { speechMs };
  }

  get minSpeechMs(): number {
    return this.o.minSpeechMs;
  }
}

/**
 * Speech probability from energy, when Silero is unavailable: a frame
 * well above the running noise floor is speech. Crude; Silero is the default.
 */
export class EnergyVad {
  private floor = 1e-4;
  prob(frame: Float32Array): number {
    let e = 0;
    for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
    e /= frame.length;
    this.floor = e < this.floor ? e : this.floor * 0.995 + e * 0.005;
    const ratio = e / Math.max(this.floor, 1e-7);
    return ratio > 20 ? 0.9 : ratio > 6 ? 0.45 : 0.1;
  }
}

/** Re-blocks 16 kHz audio into FRAME-sample frames. */
export class Framer {
  private rest = new Float32Array(0);
  push(samples: Float32Array): Float32Array[] {
    const all = new Float32Array(this.rest.length + samples.length);
    all.set(this.rest);
    all.set(samples, this.rest.length);
    const out: Float32Array[] = [];
    let at = 0;
    for (; at + FRAME <= all.length; at += FRAME) out.push(all.slice(at, at + FRAME));
    this.rest = all.slice(at);
    return out;
  }
}

/**
 * Linear-phase box low-pass + decimation from the capture rate to 16 kHz:
 * each output sample averages the input samples within one output period
 * around it. Keeps its position across calls.
 */
export class Resampler {
  private pos = 0;
  private prev = new Float32Array(0);
  constructor(private readonly from: number, private readonly to = 16000) {}
  push(input: Float32Array): Float32Array {
    if (this.from === this.to) return input.slice();
    const ratio = this.from / this.to;
    const buf = new Float32Array(this.prev.length + input.length);
    buf.set(this.prev);
    buf.set(input, this.prev.length);
    const out: number[] = [];
    const half = ratio / 2;
    while (this.pos + half < buf.length) {
      const a = Math.max(0, Math.floor(this.pos - half));
      const b = Math.min(buf.length, Math.ceil(this.pos + half));
      let s = 0;
      for (let i = a; i < b; i++) s += buf[i];
      out.push(s / Math.max(1, b - a));
      this.pos += ratio;
    }
    const keepFrom = Math.max(0, Math.floor(this.pos - half) - 1);
    this.prev = buf.slice(keepFrom);
    this.pos -= keepFrom;
    return Float32Array.from(out);
  }
}
