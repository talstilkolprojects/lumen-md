/**
 * Capabilities the app shows only after a public benchmark says they work
 * (plan W11.H8, W11.H9, W11.H14). The verdicts come from
 * eval/public/_verdicts.json, which `npm run eval:public -- verdicts`
 * writes from the committed results in eval/results — never by hand.
 *
 * - A neural Hebrew voice (Chatterbox Multilingual, …) appears only when its
 *   ASR round trip on the 200 frozen FLEURS-he prompts passes (CER ≤ 6 %, or
 *   within 2 points of natural speech) AND its registry entry is allowed and
 *   verified (the training-data question to Resemble is part of that, W11.O2).
 * - Handwriting recognition is offered only at median CER ≤ 20 % on the
 *   ivrit.ai handwriting benchmark.
 *
 * Loaded lazily with the features that ask; not in the startup bundle.
 */
import { voicePasses } from "../eval/public/adapters/ttsRoundTrip";
import { handwritingExposed } from "../eval/public/adapters/handwriting";

export interface Verdicts {
  voices: Record<string, { pass: boolean; cer: number; naturalCer: number; result: string }>;
  handwriting: Record<string, { exposed: boolean; medianCer: number; result: string }>;
}

export interface GateRegistryEntry {
  id: string;
  class: string;
  verified: boolean;
}

export interface NeuralVoiceCandidate {
  /** models/registry.json id. */
  id: string;
  engine: "chatterbox";
  language: "he";
}

/** Voices under evaluation. None is shown until it passes; see the file comment. */
export const NEURAL_VOICE_CANDIDATES: readonly NeuralVoiceCandidate[] = [{ id: "chatterbox-multilingual", engine: "chatterbox", language: "he" }];

/** The candidates the read-aloud menu may offer. The stored `pass` is re-derived from the numbers, so a hand-edited flag does not count. */
export function exposedNeuralVoices(candidates: readonly NeuralVoiceCandidate[], verdicts: Verdicts, registry: readonly GateRegistryEntry[]): NeuralVoiceCandidate[] {
  const reg = new Map(registry.map((e) => [e.id, e]));
  return candidates.filter((c) => {
    const v = verdicts.voices[c.id];
    const e = reg.get(c.id);
    return !!v && v.pass === true && voicePasses(v) && !!e && e.class === "allowed" && e.verified === true;
  });
}

export function handwritingOffered(engineId: string, verdicts: Verdicts): boolean {
  const v = verdicts.handwriting[engineId];
  return !!v && v.exposed === true && handwritingExposed(v);
}

/** The committed verdicts and registry (lazy JSON imports). */
export async function loadGateInputs(): Promise<{ verdicts: Verdicts; registry: GateRegistryEntry[] }> {
  const [v, r] = await Promise.all([import("../../eval/public/_verdicts.json"), import("../../models/registry.json")]);
  const verdicts = ((v as { default?: Verdicts }).default ?? v) as Verdicts;
  const reg = ((r as { default?: { models: GateRegistryEntry[] } }).default ?? r) as { models: GateRegistryEntry[] };
  return { verdicts, registry: reg.models };
}
