/**
 * Which speech engine dictation uses (plan 6.1), by language, hardware,
 * the AI policy and what the user has downloaded.
 *
 *   live, Hebrew   → Zipformer2 streaming (ivrit.ai, 72 MB, WASM) — real time,
 *                    each finished sentence then re-read by Whisper when its
 *                    model is on the device (plan W4.13, chooseCorrection):
 *                    ivrit.ai turbo on WebGPU, else Ozen v1 (WebGPU or wasm)
 *   live, other    → Whisper on this device after each pause (push-to-talk feel)
 *   files          → Whisper: on the desktop app, ivrit.ai turbo as ggml in
 *                    whisper.cpp when it is installed and verified (W1.17);
 *                    else ivrit.ai turbo on WebGPU for Hebrew when the
 *                    GPU can hold it (owner-measured, 15.3), else Ozen v1
 *                    (164 MB, plan W4.13), else whisper-base on WASM (77 MB);
 *                    the language is forced, never detected
 *   browser speech → only under the `cloud` policy (plan 6.17; the browser sends
 *                    the audio to its vendor) and never under local-only (1.3)
 *
 * Pure: the caller passes what it knows; nothing is probed or loaded here.
 */
import type { AiPolicy } from "../policy";

export type EngineId = "zipformer-he" | "whisper-cpp-he" | "whisper-turbo-he" | "ozen-he" | "whisper-base" | "whisper-live" | "web-speech";

export interface EngineInfo {
  id: EngineId;
  /** Runs on this device. */
  local: boolean;
  /** Text appears while the user speaks. */
  streaming: boolean;
  /** Download the first use needs, MB (0 = nothing to download). */
  downloadMB: number;
  languages: "he" | "any";
  license: string;
}

export const ENGINES: Record<EngineId, EngineInfo> = {
  "zipformer-he": { id: "zipformer-he", local: true, streaming: true, downloadMB: 72 + 2.3, languages: "he", license: "CC-BY-4.0 (ivrit.ai) + MIT (Silero VAD)" },
  // Installed by the user next to the desktop app (whisperDesktop.ts); offered only once it is there and verified.
  "whisper-cpp-he": { id: "whisper-cpp-he", local: true, streaming: false, downloadMB: 0, languages: "he", license: "Apache-2.0 (ivrit.ai) + MIT (whisper.cpp)" },
  "whisper-turbo-he": { id: "whisper-turbo-he", local: true, streaming: false, downloadMB: 563, languages: "he", license: "Apache-2.0" },
  "ozen-he": { id: "ozen-he", local: true, streaming: false, downloadMB: 164, languages: "he", license: "Apache-2.0" },
  "whisper-base": { id: "whisper-base", local: true, streaming: false, downloadMB: 77, languages: "any", license: "MIT" },
  "whisper-live": { id: "whisper-live", local: true, streaming: false, downloadMB: 77 + 2.3, languages: "any", license: "MIT" },
  "web-speech": { id: "web-speech", local: false, streaming: true, downloadMB: 0, languages: "any", license: "browser" },
};

export interface EngineContext {
  /** BCP-47 or ISO-639-1 ("he-IL", "he", "en"). */
  language: string;
  policy: AiPolicy;
  mode: "live" | "file";
  webgpu: boolean;
  f16: boolean;
  /** VRAM the app is willing to spend, MB (modelManager.vramBudgetMB). */
  vramMB: number;
  /** The browser has SpeechRecognition. */
  webSpeech: boolean;
  /** Engines whose files are already on this device. */
  downloaded: ReadonlySet<EngineId>;
  /** The desktop app has whisper-cli and the pinned ivrit.ai ggml model (W1.17). */
  desktopWhisper?: boolean;
}

export interface EngineChoice {
  /** Best first. The first one is used; a later one only if the user declines a download. */
  candidates: EngineId[];
  /** A download the best engine needs before it can run (the user starts it). */
  needsDownload: EngineId | null;
  /** Why browser speech is not offered, when it is not. */
  webSpeechBlocked?: "local-only" | "unsupported";
}

export const baseLanguage = (tag: string): string => tag.split(/[-_]/)[0].toLowerCase();

/** The turbo model's floor: 563 MB of q4f16 weights plus activations. */
export const TURBO_VRAM_MB = 1200;

export function chooseEngine(ctx: EngineContext): EngineChoice {
  const he = baseLanguage(ctx.language) === "he";
  const out: EngineId[] = [];
  if (ctx.mode === "live") {
    if (he) out.push("zipformer-he");
    out.push("whisper-live");
  } else {
    if (he && ctx.desktopWhisper) out.push("whisper-cpp-he");
    if (he && ctx.webgpu && ctx.f16 && ctx.vramMB >= TURBO_VRAM_MB) out.push("whisper-turbo-he");
    if (he) out.push("ozen-he");
    out.push("whisper-base");
  }
  let webSpeechBlocked: EngineChoice["webSpeechBlocked"];
  if (ctx.mode === "live") {
    if (ctx.policy === "local-only") webSpeechBlocked = "local-only";
    else if (!ctx.webSpeech) webSpeechBlocked = "unsupported";
    // Under `cloud` the user chose the cloud: browser speech is fine as the
    // first choice when no local engine is downloaded yet. Under
    // `local-first` it is not offered: a third-party service the user never
    // set up needs the explicit `cloud` policy (plan 6.17).
    else if (ctx.policy === "cloud" && !out.some((e) => ctx.downloaded.has(e))) out.unshift("web-speech");
    else if (ctx.policy === "cloud") out.push("web-speech");
  }
  const best = out[0];
  return { candidates: out, needsDownload: ENGINES[best].downloadMB > 0 && !ctx.downloaded.has(best) ? best : null, webSpeechBlocked };
}

/**
 * Which Whisper re-reads each finished sentence of live Hebrew dictation
 * (plan W4.13): the streaming text appears at once, and at the pause the
 * sentence's audio goes through a stronger model. Only a model already on
 * the device is used — live dictation never starts a download: ivrit.ai's
 * turbo where the GPU can hold it, else Ozen v1 (WebGPU or wasm — the
 * fallback without WebGPU), else none (the streaming text stays).
 */
export function chooseCorrection(ctx: Pick<EngineContext, "language" | "webgpu" | "f16" | "vramMB" | "downloaded">): "whisper-turbo-he" | "ozen-he" | null {
  if (baseLanguage(ctx.language) !== "he") return null;
  if (ctx.webgpu && ctx.f16 && ctx.vramMB >= TURBO_VRAM_MB && ctx.downloaded.has("whisper-turbo-he")) return "whisper-turbo-he";
  if (ctx.downloaded.has("ozen-he")) return "ozen-he";
  return null;
}
