/**
 * A finished recording through the live-dictation engine (plan W11.H7):
 * ivrit-ai/zipformer2-66m-streaming-he, int8, on onnxruntime-web WASM — the
 * same worker and files as live dictation (./dictation.worker.ts,
 * ./models.ts), fed the recording at 16 kHz instead of the microphone. The
 * voice capture (src/capture/voiceCapture.ts) uses it for Hebrew when the
 * model is already on the device; Whisper stays the fallback.
 *
 * Nothing downloads here: the caller passes files it already has.
 */
import type { DictationIn, DictationOut } from "./dictation.worker";
import type { DictationFiles } from "./modelStore";

export interface WorkerLike {
  postMessage(m: DictationIn, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<DictationOut>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  terminate(): void;
}

/** Samples per message: the 1024-sample block live dictation sends (64 ms at 16 kHz). */
export const SLICE = 1024;

export async function transcribeSamples(samples: Float32Array, files: DictationFiles, deps: { worker: WorkerLike; ortBase: string; signal?: AbortSignal }): Promise<string | null> {
  const w = deps.worker;
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const finals: string[] = [];
      const onAbort = () => reject(new DOMException("aborted", "AbortError"));
      if (deps.signal?.aborted) return onAbort();
      deps.signal?.addEventListener("abort", onAbort, { once: true });
      w.onerror = (e) => reject(new Error(e.message || "dictation worker failed"));
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "error") reject(new Error(m.message));
        else if (m.type === "final" && m.text.trim()) finals.push(m.text.trim());
        else if (m.type === "ready") {
          for (let i = 0; i < samples.length; i += SLICE) w.postMessage({ type: "audio", samples: samples.slice(i, i + SLICE) });
          w.postMessage({ type: "stop" });
        } else if (m.type === "stopped") resolve(finals.join(" ").trim() || null);
      };
      const enc = files.encoder.slice();
      const dec = files.decoder.slice();
      const join = files.joiner.slice();
      const vad = files.vad?.slice() ?? null;
      w.postMessage({ type: "load", ortBase: deps.ortBase, encoder: enc, decoder: dec, joiner: join, tokens: files.tokens, vad }, [enc.buffer, dec.buffer, join.buffer, ...(vad ? [vad.buffer] : [])]);
    });
  } finally {
    w.terminate();
  }
}

/** Hebrew only: the model is Hebrew-only (ENGINES["zipformer-he"].languages). An unknown language counts as not Hebrew. */
export const isHebrew = (language: string | undefined): boolean => (language ?? "").split(/[-_]/)[0].toLowerCase() === "he";
