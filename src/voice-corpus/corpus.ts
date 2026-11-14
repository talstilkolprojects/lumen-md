/**
 * The first open Hebrew voice (plan W7.10): the recording-corpus kit.
 *
 * No neural Hebrew voice may be shipped today: MMS, SASPEECH (licence-gate: mention-only),
 * Phonikud's checkpoints and ILSpeech are all non-commercial, so W2.6's
 * read-aloud sleeps. This kit makes a corpus we can release as CC0 ourselves: about two
 * hours from one volunteer speaker, read from a script of public-domain and
 * CC0 sentences, recorded in the app with a noise and level check, exported
 * in the LJSpeech layout Piper's trainer reads. Training is an owner / GPU
 * step (scripts/voice-corpus/piper-train.sh).
 *
 * Pure: no DOM, no audio APIs (the recorder passes samples in).
 */

// ------------------------------------------------------------ the script

const HEB = /[א-ת]/;
const NIKUD = /[֑-ׇ]/g;

export interface ScriptOptions {
  minWords?: number;
  maxWords?: number;
  /** Sentences wanted (≈ 2 hours at ~5 s each: 1,500). */
  count?: number;
}

/** A sentence a speaker can read without guessing: Hebrew only, no digits, Latin or symbols, a sensible length. */
export function readable(s: string, o: ScriptOptions = {}): boolean {
  const t = s.trim();
  const words = t.split(/\s+/).length;
  if (words < (o.minWords ?? 4) || words > (o.maxWords ?? 16)) return false;
  if (!HEB.test(t) || /[0-9A-Za-z@#$%^&*_=+<>{}[\]|\\/~`]/.test(t)) return false;
  return /^[א-ת֑-ׇ\s,.?!:;׳״"'()\-–—]+$/.test(t);
}

/** Letter bigrams (nikud ignored, final forms kept): what a script should cover. */
export function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.replace(NIKUD, "").match(/[א-ת]+/g) ?? []) {
    const p = `^${w}$`;
    for (let i = 0; i + 2 <= p.length; i++) out.add(p.slice(i, i + 2));
  }
  return out;
}

/**
 * The recording script: greedy coverage of letter bigrams (each pick adds the
 * most unseen ones per word), duplicates and unreadable lines dropped. The
 * same input gives the same script.
 */
export function buildScript(pool: readonly { text: string; source: string }[], o: ScriptOptions = {}): Array<{ id: string; text: string; source: string }> {
  const seen = new Set<string>();
  const cands = pool
    .map((p) => ({ ...p, text: p.text.replace(/\s+/g, " ").trim() }))
    .filter((p) => readable(p.text, o) && !seen.has(p.text) && seen.add(p.text))
    .map((p) => ({ ...p, grams: bigrams(p.text), words: p.text.split(" ").length }));
  const covered = new Set<string>();
  const out: Array<{ id: string; text: string; source: string }> = [];
  const want = o.count ?? 1500;
  const used = new Set<number>();
  while (out.length < want && used.size < cands.length) {
    let best = -1;
    let score = -1;
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i)) continue;
      let gain = 0;
      for (const g of cands[i].grams) if (!covered.has(g)) gain++;
      const s = gain / cands[i].words;
      if (s > score) {
        score = s;
        best = i;
      }
    }
    used.add(best);
    for (const g of cands[best].grams) covered.add(g);
    out.push({ id: `he_${String(out.length + 1).padStart(4, "0")}`, text: cands[best].text, source: cands[best].source });
  }
  return out;
}

// ------------------------------------------------------------ the recorder's check

export interface TakeCheck {
  /** Loudest sample, dBFS. */
  peakDb: number;
  /** Speech level (RMS of the loudest 50 ms windows), dBFS. */
  speechDb: number;
  /** Background (RMS of the quietest 10% of 50 ms windows), dBFS. */
  noiseDb: number;
  snrDb: number;
  clipped: number;
  /** Seconds of near-silence at the start and end. */
  leadS: number;
  tailS: number;
  ok: boolean;
  problems: Array<"clipping" | "too-quiet" | "too-loud" | "noisy" | "no-lead" | "no-tail" | "too-long">;
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);

/** Checks one take (mono float samples −1…1): level, clipping, background noise, silence around the speech. */
export function checkTake(samples: Float32Array, rate: number): TakeCheck {
  const win = Math.max(1, Math.round(rate * 0.05));
  const rms: number[] = [];
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i += win) {
    let s = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) {
      const a = Math.abs(samples[j]);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      s += samples[j] * samples[j];
    }
    rms.push(Math.sqrt(s / Math.max(1, end - i)));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const noise = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.1)));
  const speech = sorted.slice(Math.floor(sorted.length * 0.8));
  const mean = (xs: number[]) => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / Math.max(1, xs.length));
  const noiseDb = db(mean(noise));
  const speechDb = db(mean(speech));
  // Near-silence: under the background + 6 dB, and never louder than −45 dBFS (a take with no pause has no background to measure).
  const quiet = (r: number) => db(r) < Math.min(noiseDb + 6, -45);
  let lead = 0;
  while (lead < rms.length && quiet(rms[lead])) lead++;
  let tail = 0;
  while (tail < rms.length && quiet(rms[rms.length - 1 - tail])) tail++;
  const problems: TakeCheck["problems"] = [];
  if (clipped > 0) problems.push("clipping");
  if (speechDb < -30) problems.push("too-quiet");
  if (db(peak) > -1) problems.push("too-loud");
  if (speechDb - noiseDb < 35) problems.push("noisy");
  if (lead * 0.05 < 0.15) problems.push("no-lead");
  if (tail * 0.05 < 0.15) problems.push("no-tail");
  if (samples.length / rate > 15) problems.push("too-long");
  return { peakDb: db(peak), speechDb, noiseDb, snrDb: speechDb - noiseDb, clipped, leadS: lead * 0.05, tailS: tail * 0.05, ok: problems.length === 0, problems };
}

/** 16-bit PCM mono WAV (Piper trains on 22,050 Hz). */
export function wav(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}

/** LJSpeech `metadata.csv` (`id|text|text`), the layout piper_train.preprocess reads; only takes that passed. */
export function ljspeechMetadata(takes: ReadonlyArray<{ id: string; text: string; ok: boolean }>): string {
  return takes.filter((t) => t.ok).map((t) => `${t.id}|${t.text.replace(/\|/g, " ")}|${t.text.replace(/\|/g, " ")}`).join("\n") + "\n";
}

export interface CorpusSummary {
  takes: number;
  ok: number;
  seconds: number;
  hours: number;
  enough: boolean;
}

/** Two hours of good takes is the bar Phonikud reports for fine-tuning. */
export function summary(takes: ReadonlyArray<{ ok: boolean; seconds: number }>): CorpusSummary {
  const good = takes.filter((t) => t.ok);
  const seconds = good.reduce((a, t) => a + t.seconds, 0);
  return { takes: takes.length, ok: good.length, seconds, hours: seconds / 3600, enough: seconds >= 2 * 3600 };
}

// ------------------------------------------------------------ the listening test (acceptance)

export interface Rating {
  rater: string;
  sentence: string;
  /** 1..5 */
  score: number;
  /** Words the rater marked as mispronounced. */
  wrongWords: number;
  words: number;
}

/** MOS over raters and sentences, with a 95% interval; pronunciation errors as a share of words. */
export function listeningResult(ratings: readonly Rating[]): { raters: number; sentences: number; mos: number; ci95: number; wrongWordRate: number; pass: boolean } {
  const raters = new Set(ratings.map((r) => r.rater)).size;
  const sentences = new Set(ratings.map((r) => r.sentence)).size;
  const n = ratings.length;
  const mos = ratings.reduce((a, r) => a + r.score, 0) / Math.max(1, n);
  const sd = Math.sqrt(ratings.reduce((a, r) => a + (r.score - mos) ** 2, 0) / Math.max(1, n - 1));
  const ci95 = (1.96 * sd) / Math.sqrt(Math.max(1, n));
  const words = ratings.reduce((a, r) => a + r.words, 0);
  const wrongWordRate = ratings.reduce((a, r) => a + r.wrongWords, 0) / Math.max(1, words);
  return { raters, sentences, mos, ci95, wrongWordRate, pass: raters >= 10 && sentences >= 30 && mos >= 3.5 && wrongWordRate <= 0.05 };
}

/** Real-time factor: seconds of compute per second of audio (≤ 0.5 in a browser worker on a mid-range machine). */
export const rtf = (computeMs: number, audioSamples: number, rate: number): number => computeMs / 1000 / (audioSamples / rate);

/** Licences the voice, data and code may have (acceptance: CC0 or MIT only, approved in gate 0.10). */
export const ALLOWED_LICENCES = ["CC0-1.0", "MIT"] as const;
export const licenceOk = (spdx: string): boolean => (ALLOWED_LICENCES as readonly string[]).includes(spdx);
