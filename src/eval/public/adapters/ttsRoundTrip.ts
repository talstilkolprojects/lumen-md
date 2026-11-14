/**
 * ASR round-trip screen for Hebrew voices (plan W11.H9), the INSV-A method
 * of PashtoTTS-Bench (arXiv 2605.26978): synthesise frozen FLEURS-he
 * prompts, transcribe the synthetic audio with a fixed judge (ivrit.ai
 * Whisper-turbo), and score CER / WER against the prompt text — next to
 * the same judge on FLEURS' natural recordings of the same sentences, so a
 * voice is compared with human speech under the same ASR and normaliser.
 *
 * The 200 prompts are frozen in eval/public/tts-insva-fleurs-he.json
 * (`frozen.ids` + sha256) by `npm run eval:public -- freeze`: the first 200
 * distinct sentence ids of the FLEURS he_il test split in numeric order.
 */
import { countChars, countWords, microRate, r4 } from "../metrics";
import type { AsrEngine, AsrItem } from "./asr";

export interface TtsEngine {
  id: string;
  /** Synthesise `text`; returns the audio file path the judge reads. */
  synthesize(text: string, id: string): Promise<string>;
}

export interface RoundTripScore {
  n: number;
  metrics: { cer: number; wer: number; naturalCer: number; naturalWer: number };
  judge: string;
  voice: string;
}

/**
 * The frozen prompt set: one item per distinct FLEURS sentence id (the first
 * recording of each, by file name), the first `count` ids in numeric order.
 */
export function freezePrompts(items: readonly AsrItem[], count: number): AsrItem[] {
  const first = new Map<string, AsrItem>();
  for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const sid = it.id.split("/")[0];
    if (!first.has(sid)) first.set(sid, it);
  }
  const ids = [...first.keys()].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  if (ids.length < count) throw new Error(`only ${ids.length} distinct sentences, ${count} needed`);
  return ids.slice(0, count).map((id) => first.get(id)!);
}

/** The frozen items, in the manifest's order; fails when one is missing (the set changed under the pin). */
export function selectFrozen(items: readonly AsrItem[], ids: readonly string[]): AsrItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return ids.map((id) => {
    const it = byId.get(id);
    if (!it) throw new Error(`frozen prompt ${id} is not in the data`);
    return it;
  });
}

export async function scoreRoundTrip(prompts: readonly AsrItem[], voice: TtsEngine, judge: AsrEngine, norm: (s: string) => string): Promise<RoundTripScore> {
  const synth = { w: [] as ReturnType<typeof countWords>[], c: [] as ReturnType<typeof countChars>[] };
  const nat = { w: [] as ReturnType<typeof countWords>[], c: [] as ReturnType<typeof countChars>[] };
  for (const p of prompts) {
    const ref = norm(p.text);
    const audio = await voice.synthesize(p.text, p.id);
    const hyp = norm(await judge.transcribe(audio));
    synth.w.push(countWords({ ref, hyp }));
    synth.c.push(countChars({ ref, hyp }));
    const natural = norm(await judge.transcribe(p.audio));
    nat.w.push(countWords({ ref, hyp: natural }));
    nat.c.push(countChars({ ref, hyp: natural }));
  }
  return {
    n: prompts.length,
    judge: judge.id,
    voice: voice.id,
    metrics: { cer: r4(microRate(synth.c)), wer: r4(microRate(synth.w)), naturalCer: r4(microRate(nat.c)), naturalWer: r4(microRate(nat.w)) },
  };
}

/** The W11.H9 gate: CER ≤ 6 %, or no more than 2 points above natural speech under the same judge. */
export const VOICE_CER_MAX = 0.06;
export const VOICE_CER_MARGIN = 0.02;

export function voicePasses(m: { cer: number; naturalCer: number } | null | undefined): boolean {
  if (!m || !Number.isFinite(m.cer)) return false;
  if (m.cer <= VOICE_CER_MAX) return true;
  return Number.isFinite(m.naturalCer) && m.cer - m.naturalCer <= VOICE_CER_MARGIN + 1e-9;
}
