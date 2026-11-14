/**
 * Chatterbox Multilingual (Resemble AI, MIT weights) as a Hebrew voice
 * candidate (plan W11.H8). Hidden: ../publicGates.ts shows it only after
 * the ASR round-trip screen (W11.H9) passes and its registry entry is
 * allowed — which waits on the training-data answer from Resemble (W11.O2).
 *
 * The pipeline is fixed here: niqqud first (W2.5: DictaBERT-char-menaked,
 * else Nakdimon — Resemble's reference script dots Hebrew with dicta-onnx
 * before synthesis), then the ONNX model. The runtime is a seam: the
 * desktop runs the ONNX export (BricksDisplay/chatterbox-multilingual-ONNX)
 * first; the browser only if the q4 export fits (owed, W11.M — the graph's
 * input and output names are read from the files when they are pinned).
 * Its output carries Resemble's PerTh watermark; the registry entry says so.
 */

export interface ChatterboxAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface ChatterboxRuntime {
  /** Synthesise dotted Hebrew. */
  synthesize(dotted: string, opts: { language: "he"; signal?: AbortSignal }): Promise<ChatterboxAudio>;
}

export interface ChatterboxDeps {
  /** Add niqqud (nikudService). Returns the text unchanged when no niqqud model is available. */
  nikud: (text: string, signal?: AbortSignal) => Promise<string>;
  runtime: ChatterboxRuntime;
}

const HEBREW = /[א-ת]/;
const POINTED = /[ְ-ׇּׁׂ]/;

/** Text → dotted text → audio. Already-dotted text is not dotted again. */
export async function speakChatterbox(text: string, deps: ChatterboxDeps, signal?: AbortSignal): Promise<ChatterboxAudio> {
  const t = text.normalize("NFC").trim();
  if (!t) return { samples: new Float32Array(0), sampleRate: 24_000 };
  const dotted = HEBREW.test(t) && !POINTED.test(t) ? await deps.nikud(t, signal) : t;
  return deps.runtime.synthesize(dotted, { language: "he", signal });
}
