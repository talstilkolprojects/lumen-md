/**
 * A live dictation session (plan 6.1), main-thread side: the microphone
 * (resampled to 16 kHz, 64 ms blocks) → the dictation worker → interim
 * text while the user speaks, final punctuated segments at each pause.
 * Loaded lazily by the dictation command; nothing here is in the startup
 * bundle.
 */
import type { DictationFiles } from "./modelStore";
import type { DictationIn, DictationOut } from "./dictation.worker";
import { finishSegment, interimText, type DictationAction } from "./punctuate";
import { Resampler } from "./segmenter";
import { ortBaseUrl } from "../transformersEngine";

export interface DictationCallbacks {
  onReady?: (info: { vad: "silero" | "energy"; loadMs: number }) => void;
  onSpeaking?: (active: boolean) => void;
  onInterim?: (text: string) => void;
  /** A finished segment: text to insert (may be "") and commands spoken in it. */
  onFinal?: (text: string, actions: DictationAction[]) => void;
  onError?: (message: string) => void;
  onStopped?: () => void;
}

export interface DictationSession {
  stop(): Promise<void>;
}

/** 1024 samples at 16 kHz: what the eval harness feeds too (scripts/golden/evals/asr-he.mjs). */
export const BLOCK = 1024;

export interface SessionOptions {
  commands?: boolean;
  /** Cancels the start (the panel's Cancel). */
  signal?: AbortSignal;
  /**
   * An AudioContext made in the click that started dictation. Autoplay
   * policy may keep a context created later — after the download and the
   * model load — suspended; one made in the gesture starts running.
   */
  audioContext?: AudioContext;
}

/** An AudioContext for dictation, made synchronously in the user's click (see SessionOptions.audioContext). */
export function createDictationAudioContext(): AudioContext | undefined {
  try {
    return typeof AudioContext === "function" ? new AudioContext() : undefined;
  } catch {
    return undefined;
  }
}

export async function startDictationSession(files: DictationFiles, cb: DictationCallbacks, opts: SessionOptions = {}): Promise<DictationSession> {
  const aborted = () => new DOMException("aborted", "AbortError");
  if (opts.signal?.aborted) {
    void opts.audioContext?.close().catch(() => undefined);
    throw aborted();
  }
  const worker = new Worker(new URL("./dictation.worker.ts", import.meta.url), { type: "module" });
  const send = (m: DictationIn, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  let stopped: (() => void) | null = null;
  worker.onmessage = (ev: MessageEvent<DictationOut>) => {
    const m = ev.data;
    if (m.type === "ready") cb.onReady?.(m);
    else if (m.type === "speaking") cb.onSpeaking?.(m.active);
    else if (m.type === "interim") cb.onInterim?.(interimText(m.text, opts));
    else if (m.type === "final") {
      const seg = finishSegment(m.text, opts);
      cb.onFinal?.(seg.text, seg.actions);
    } else if (m.type === "error") cb.onError?.(m.message);
    else if (m.type === "stopped") stopped?.();
  };
  let failLoad: ((e: Error) => void) | null = null;
  worker.onerror = (e) => {
    const message = e.message || "dictation worker failed";
    // Before "ready" (the module or ONNX Runtime failed to start) the load fails; after it, the session.
    if (failLoad) failLoad(new Error(message));
    else cb.onError?.(message);
  };

  const ready = new Promise<void>((resolve, reject) => {
    failLoad = reject;
    const prev = worker.onmessage;
    worker.onmessage = (ev: MessageEvent<DictationOut>) => {
      if (ev.data.type !== "error") prev?.call(worker, ev);
      if (ev.data.type === "ready") {
        worker.onmessage = prev;
        failLoad = null;
        resolve();
      } else if (ev.data.type === "error") reject(new Error(ev.data.message));
    };
  });
  ready.catch(() => undefined); // awaited below, after the microphone prompt
  // Copies: the cached bytes stay usable for the next session.
  const enc = files.encoder.slice();
  const dec = files.decoder.slice();
  const join = files.joiner.slice();
  const vad = files.vad?.slice() ?? null;
  send({ type: "load", ortBase: ortBaseUrl(), encoder: enc, decoder: dec, joiner: join, tokens: files.tokens, vad }, [enc.buffer, dec.buffer, join.buffer, ...(vad ? [vad.buffer] : [])]);

  // Until the session handle is returned, a cancel (signal) or any failure
  // releases what was acquired so far: the worker, the microphone, the audio graph.
  let media: MediaStream | null = null;
  let ctx: AudioContext | null = opts.audioContext ?? null;
  const release = () => {
    media?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    worker.terminate();
  };
  let onAbort: (() => void) | null = null;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(aborted());
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  cancelled.catch(() => undefined);
  const orCancel = <T,>(p: Promise<T>) => Promise.race([p, cancelled]);

  let proc: ScriptProcessorNode;
  let source: MediaStreamAudioSourceNode;
  let gum: Promise<MediaStream> | null = null;
  try {
    gum = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    media = await orCancel(gum);
    await orCancel(ready);

    ctx ??= new AudioContext();
    source = ctx.createMediaStreamSource(media);
    // ScriptProcessorNode: no worklet module to load (CSP / Trusted Types),
    // and the work per callback is a copy. AudioWorklet is a follow-up.
    proc = ctx.createScriptProcessor(2048, 1, 1);
    const resampler = new Resampler(ctx.sampleRate, 16000);
    let pending = new Float32Array(0);
    proc.onaudioprocess = (e) => {
      const x = resampler.push(e.inputBuffer.getChannelData(0));
      const all = new Float32Array(pending.length + x.length);
      all.set(pending);
      all.set(x, pending.length);
      let at = 0;
      for (; at + BLOCK <= all.length; at += BLOCK) {
        const block = all.slice(at, at + BLOCK);
        send({ type: "audio", samples: block }, [block.buffer]);
      }
      pending = all.slice(at);
    };
    source.connect(proc);
    // Some engines only pull a processor that reaches the destination; it outputs silence.
    proc.connect(ctx.destination);
    // Autoplay policy: a suspended context delivers no audio, and the panel
    // would listen forever. Resume now (the dictation click gives the page
    // sticky activation) and refuse to start if it stays suspended.
    if (ctx.state !== "running") await orCancel(ctx.resume());
    if (ctx.state !== "running") throw new Error("audio is suspended by the browser — click the dictation button again");
    const context = ctx;
    context.onstatechange = () => {
      if (context.state === "suspended") void context.resume().catch(() => undefined);
    };
  } catch (e) {
    release();
    // Cancelled while the permission prompt was open: the stream may still arrive — stop it then.
    void gum?.then((m) => m.getTracks().forEach((t) => t.stop()), () => undefined);
    throw e;
  } finally {
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
  const mic = media;
  const audio = ctx;

  return {
    async stop() {
      proc.disconnect();
      source.disconnect();
      mic.getTracks().forEach((t) => t.stop());
      await audio.close().catch(() => undefined);
      await new Promise<void>((resolve) => {
        stopped = resolve;
        send({ type: "stop" });
        setTimeout(resolve, 8000);
      });
      worker.terminate();
      cb.onStopped?.();
    },
  };
}
