/**
 * Streaming log-mel filterbank, Kaldi-compatible — the features the ivrit.ai
 * Zipformer2 was trained on, computed the way sherpa-onnx computes them
 * (kaldi-native-fbank with sherpa's defaults):
 *
 *   16 kHz, 25 ms frames every 10 ms, snip_edges = false (frames centred on
 *   multiples of 10 ms, the signal reflected at its edges), no dither, DC
 *   removed, pre-emphasis 0.97, Povey window, 512-point FFT, power spectrum,
 *   80 triangular mel bins over 20 Hz – 7600 Hz, natural log floored at
 *   FLT_EPSILON. Samples stay in [-1, 1] (sherpa's `normalize_samples =
 *   true`; icefall trains on lhotse features of unscaled audio) — scaling them
 *   by 32768 shifts every bin by 20.8 and the model mostly hears silence.
 *
 * Online: `accept()` audio as it arrives, `frames()` returns every frame
 * whose window is complete; after `finish()` the last frames (whose window
 * runs past the end, reflected) are released too. Only the samples a
 * future frame still needs are kept.
 */

export const SAMPLE_RATE = 16_000;
export const NUM_BINS = 80;
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const PREEMPH = 0.97;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2 - 400;
const FLT_EPSILON = 1.1920928955078125e-7;

const mel = (f: number) => 1127 * Math.log(1 + f / 700);

/** Kaldi's mel banks: for each bin, the first FFT bin it covers and its weights. */
function melBanks(): { offset: number; weights: Float32Array }[] {
  const nfft = FFT_SIZE / 2;
  const binWidth = SAMPLE_RATE / FFT_SIZE;
  const lo = mel(LOW_FREQ);
  const hi = mel(HIGH_FREQ);
  const delta = (hi - lo) / (NUM_BINS + 1);
  const banks = [];
  for (let b = 0; b < NUM_BINS; b++) {
    const left = lo + b * delta;
    const center = left + delta;
    const right = center + delta;
    let first = -1;
    let last = -1;
    const w = new Float32Array(nfft);
    for (let i = 0; i < nfft; i++) {
      const m = mel(binWidth * i);
      if (m > left && m < right) {
        w[i] = m <= center ? (m - left) / (center - left) : (right - m) / (right - center);
        if (first < 0) first = i;
        last = i;
      }
    }
    banks.push({ offset: first, weights: w.slice(first, last + 1) });
  }
  return banks;
}

/** In-place radix-2 FFT of a real signal of FFT_SIZE (re = signal, im = 0). */
function makeFft(n: number) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return (re: Float64Array, im: Float64Array) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const a = start + k;
          const b = a + half;
          const wr = cos[k * step];
          const wi = sin[k * step];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

const WINDOW = (() => {
  const w = new Float64Array(FRAME_LENGTH);
  for (let i = 0; i < FRAME_LENGTH; i++) w[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1)), 0.85);
  return w;
})();

let shared: { banks: ReturnType<typeof melBanks>; fft: ReturnType<typeof makeFft> } | null = null;

/** First sample of frame `m` (snip_edges = false: centred on m·shift + shift/2). */
const firstSample = (m: number) => m * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LENGTH / 2;

/** Frames ready for `n` samples: all complete windows, or (finished) Kaldi's count. */
export function framesReady(n: number, finished: boolean): number {
  let frames = Math.floor((n + FRAME_SHIFT / 2) / FRAME_SHIFT);
  if (finished) return frames;
  while (frames > 0 && firstSample(frames - 1) + FRAME_LENGTH > n) frames--;
  return frames;
}

export class OnlineFbank {
  /** Samples kept, starting at absolute sample `base`. */
  private buf = new Float32Array(0);
  private base = 0;
  private total = 0;
  private done = 0;
  private finished = false;
  /** The first samples, for the reflection of the first frames. */
  private head = new Float32Array(0);
  private readonly re = new Float64Array(FFT_SIZE);
  private readonly im = new Float64Array(FFT_SIZE);
  private readonly frame = new Float64Array(FRAME_LENGTH);

  constructor() {
    shared ??= { banks: melBanks(), fft: makeFft(FFT_SIZE) };
  }

  /** Add samples in [-1, 1] at 16 kHz. */
  accept(samples: Float32Array): void {
    if (this.finished) throw new Error("fbank: input already finished");
    const next = new Float32Array(this.buf.length + samples.length);
    next.set(this.buf);
    next.set(samples, this.buf.length);
    this.buf = next;
    this.total += samples.length;
    if (this.head.length < FRAME_LENGTH) {
      const h = new Float32Array(Math.min(FRAME_LENGTH, this.head.length + samples.length));
      h.set(this.head);
      h.set(samples.subarray(0, h.length - this.head.length), this.head.length);
      this.head = h;
    }
  }

  finish(): void {
    this.finished = true;
  }

  get numFrames(): number {
    return this.done;
  }

  /** Every frame now computable that was not returned before, each NUM_BINS log energies. */
  frames(): Float32Array[] {
    const out: Float32Array[] = [];
    const ready = framesReady(this.total, this.finished);
    for (; this.done < ready; this.done++) out.push(this.compute(this.done));
    // Drop what no future frame needs.
    const keepFrom = Math.max(0, firstSample(this.done));
    if (keepFrom > this.base) {
      this.buf = this.buf.slice(keepFrom - this.base);
      this.base = keepFrom;
    }
    return out;
  }

  private sample(s: number): number {
    const n = this.total;
    if (s < 0) s = -s - 1;
    else if (s >= n) s = 2 * n - 1 - s;
    if (s < this.base) return this.head[s] ?? 0;
    return this.buf[s - this.base] ?? 0;
  }

  private compute(m: number): Float32Array {
    const { banks, fft } = shared!;
    const x = this.frame;
    const start = firstSample(m);
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) {
      x[i] = this.sample(start + i);
      mean += x[i];
    }
    mean /= FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) x[i] -= mean;
    for (let i = FRAME_LENGTH - 1; i > 0; i--) x[i] -= PREEMPH * x[i - 1];
    x[0] -= PREEMPH * x[0];
    const re = this.re;
    const im = this.im;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FRAME_LENGTH; i++) re[i] = x[i] * WINDOW[i];
    fft(re, im);
    const out = new Float32Array(NUM_BINS);
    for (let b = 0; b < NUM_BINS; b++) {
      const { offset, weights } = banks[b];
      let e = 0;
      for (let k = 0; k < weights.length; k++) {
        const i = offset + k;
        e += weights[k] * (re[i] * re[i] + im[i] * im[i]);
      }
      out[b] = Math.log(Math.max(e, FLT_EPSILON));
    }
    return out;
  }
}
