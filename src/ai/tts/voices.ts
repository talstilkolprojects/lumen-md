/**
 * Neural Hebrew voices (plan W2.6): the voice-pack seam.
 *
 * A voice is a Piper-format VITS model (`<voice>.onnx` + its JSON config with
 * `phoneme_id_map` and `audio.sample_rate`), run by onnxruntime-web in
 * ./piper.worker.ts. The engine is the archived MIT Piper format, not
 * piper1-gpl; phonemes come from ./hebrewG2P.ts, so no eSpeak (GPL).
 *
 * Licence (decision 15.10, 10.11): every public Hebrew voice is trained on a
 * non-commercial corpus, and Meta's MMS Hebrew voice is non-commercial too
 * (both are forbidden entries in models/registry.json), so none may ship;
 * BlueTTS stays out until its training data's licence is clear. HEBREW_VOICES
 * is therefore empty, and read-aloud uses the system's Hebrew voice. A voice
 * is listed here only with a licence the gate allows (models/registry.json,
 * class "allowed", verified) and pinned files (URL at a revision + sha256).
 */

export interface VoiceFile {
  url: string;
  bytes: number;
  sha256: string;
}

export interface VoicePack {
  id: string;
  language: "he";
  /** Licence of the weights AND of the data they were trained on. */
  license: string;
  attribution: string;
  model: VoiceFile;
  config: VoiceFile;
  /** For a multi-speaker model. */
  speaker?: number;
}

/** No licensed Hebrew voice exists yet (decision 15.10). */
export const HEBREW_VOICES: readonly VoicePack[] = [];

export interface RegistryEntry {
  id: string;
  class: string;
  verified: boolean;
}

/** Voices whose registry entry allows them (class allowed + verified) and whose files are pinned. */
export function usableVoices(voices: readonly VoicePack[], registry: readonly RegistryEntry[]): VoicePack[] {
  const ok = new Map(registry.map((e) => [e.id, e.class === "allowed" && e.verified === true]));
  const pinned = (f: VoiceFile) => /^https:\/\//.test(f.url) && f.bytes > 0 && /^[0-9a-f]{64}$/.test(f.sha256);
  return voices.filter((v) => ok.get(v.id) === true && pinned(v.model) && pinned(v.config));
}

/** The parts of a Piper voice config this engine reads. */
export interface PiperConfig {
  audio: { sample_rate: number };
  phoneme_id_map: Record<string, number[]>;
  inference?: { noise_scale?: number; length_scale?: number; noise_w?: number };
  num_speakers?: number;
}

export function parsePiperConfig(json: unknown): PiperConfig {
  const c = json as Partial<PiperConfig> | null;
  if (!c || typeof c !== "object" || !c.audio || typeof c.audio.sample_rate !== "number" || !c.phoneme_id_map || typeof c.phoneme_id_map !== "object") {
    throw new Error("not a Piper voice config");
  }
  for (const k of ["^", "$", "_"]) if (!Array.isArray(c.phoneme_id_map[k])) throw new Error(`voice config lacks the "${k}" phoneme`);
  return c as PiperConfig;
}

/**
 * IPA → Piper's input ids: BOS (^), each phoneme followed by the pad (_),
 * EOS ($). Phonemes the voice does not know are skipped and reported.
 */
export function phonemeIds(ipa: string, config: PiperConfig): { ids: number[]; unknown: string[] } {
  const map = config.phoneme_id_map;
  const ids = [...map["^"]];
  const unknown: string[] = [];
  for (const ph of Array.from(ipa.normalize("NFD"))) {
    const id = map[ph];
    if (!id) {
      if (!unknown.includes(ph)) unknown.push(ph);
      continue;
    }
    ids.push(...id, ...map["_"]);
  }
  ids.push(...map["$"]);
  return { ids, unknown };
}

/** Synthesis scales in Piper's order [noise, length, noise_w]; `rate` 2 = twice as fast. */
export function scales(config: PiperConfig, rate = 1): [number, number, number] {
  const inf = config.inference ?? {};
  const r = Math.min(Math.max(rate, 0.5), 2);
  return [inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / r, inf.noise_w ?? 0.8];
}

/**
 * When each word starts, for highlighting while a synthesized sentence
 * plays: the sentence's duration shared out by each word's phoneme count
 * (VITS gives no alignment). → seconds from the start of the audio.
 */
export function wordTimes(wordsIpa: readonly string[], durationSec: number): number[] {
  const weight = wordsIpa.map((w) => Math.max(1, Array.from(w.replace(/ˈ/g, "")).length) + 1);
  const total = weight.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let t = 0;
  for (const w of weight) {
    out.push(t);
    t += (durationSec * w) / total;
  }
  return out;
}
