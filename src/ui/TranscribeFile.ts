/**
 * Transcribe an audio file into the note, one sentence per line with its
 * time linked to the audio (plan W1.17). Lazy: the palette command imports
 * it on use.
 *
 * Engine (chooseEngine, mode "file"): on the desktop app, ivrit.ai's Hebrew
 * Whisper in whisper.cpp when it is installed and verified; otherwise
 * Whisper in the browser (ivrit.ai turbo on a capable GPU, whisper-base on
 * WASM). Everything runs on this device; the language is forced for Hebrew.
 * Live dictation keeps the streaming Zipformer (6.1).
 */
import "../ai/dictation/strings";
import { t } from "../i18n";
import { showAiToast } from "./AiToast";
import { useAppStore } from "../store/useStore";
import { getAiPolicy } from "../ai/policy";
import { prefersHebrew } from "../ai/modelCatalog";
import { detectHardware, vramBudgetMB } from "../ai/modelManager";
import { chooseEngine, type EngineId } from "../ai/dictation/engines";
import { clock, sentencesOf, transcriptMarkdown } from "../ai/dictation/longform";
import type { TimedSegment } from "../ai/transformersEngine";
import { appendSegment } from "../ai/dictation/punctuate";
import { isOPFSAvailable, writeWorkspaceBlob } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { log } from "../lib/logger";
import { explainError } from "../lib/userError";

const ENGINE_NAMES: Partial<Record<EngineId, string>> = {
  "whisper-cpp-he": "ivrit.ai Whisper (whisper.cpp)",
  "whisper-turbo-he": "ivrit.ai Whisper (WebGPU)",
  "whisper-base": "Whisper base",
};

export function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,video/*";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** A vault-safe name under attachments/: letters (Hebrew kept), digits, _ and -, no folders; a short extension kept. */
export function attachmentName(name: string, when = new Date()): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const m = /^(.*?)(?:\.([A-Za-z0-9]{1,5}))?$/.exec(base);
  const stem = (m?.[1] ?? "").normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "audio";
  const ext = m?.[2]?.toLowerCase();
  return `attachments/${when.toISOString().slice(0, 10)}-${stem}${ext ? "." + ext : ""}`;
}

/** Insert at the editor's cursor (the dictation insert event); without an editor, append to the note. */
export function insert(text: string): void {
  const detail: { text: string; inserted?: string } = { text };
  if (!window.dispatchEvent(new CustomEvent("lumen-dictation-insert", { detail, cancelable: true }))) return;
  const store = useAppStore.getState();
  store.setContent(appendSegment(store.doc.content, text));
}

export interface FileTranscript {
  /** A copy of the 16 kHz audio when asked for (`keepSamples`), else null. */
  samples: Float32Array | null;
  duration: number;
  segments: TimedSegment[];
  engine: EngineId;
  language: string | undefined;
}

/**
 * Decode and transcribe a file with the engine chooseEngine picks (W1.17).
 * With `keepSamples`, `samples` is a copy of the 16 kHz audio (the engine's
 * own goes to its worker), for whatever else needs it (W2.7's speakers). Toasts say
 * which engine runs, and why desktop Whisper wasn't used.
 */
export async function transcribeFileAudio(picked: Blob & { name?: string }, opts: { keepSamples?: boolean } = {}): Promise<FileTranscript> {
  const store = useAppStore.getState();
  const he = prefersHebrew(store.locale, store.doc.content);
  const language = he ? "he" : undefined;
  const [{ decodeAudioTo16k, transcribeAudio, WHISPER_MODELS }, desktop] = await Promise.all([import("../ai/transformersEngine"), import("../ai/dictation/whisperDesktop")]);
  const samples = await decodeAudioTo16k(picked);
  const keep = opts.keepSamples ? samples.slice() : null;
  const duration = samples.length / 16_000;
  const status = he ? await desktopStatus(desktop) : { kind: "web" as const };
  const hw = await detectHardware();
  const engine = chooseEngine({
    language: language ?? "und",
    policy: getAiPolicy(),
    mode: "file",
    webgpu: hw.webgpu,
    f16: hw.f16,
    vramMB: vramBudgetMB(hw),
    webSpeech: false,
    downloaded: new Set<EngineId>(),
    desktopWhisper: status.kind === "ready",
  }).candidates[0];
  if (status.kind === "model") showAiToast(t(status.state === "missing" ? "transcribeFile.desktop.missing" : "transcribeFile.desktop.checksum"), "info");
  else if (status.kind === "no-cli") showAiToast(t("transcribeFile.desktop.noCli"), "info");
  showAiToast(t("transcribeFile.working", { name: picked.name ?? "", duration: clock(duration), engine: ENGINE_NAMES[engine] ?? engine }), "info");
  const segments =
    engine === "whisper-cpp-he"
      ? await desktop.transcribeDesktop(samples, { language: "he" })
      : await (async () => {
          const model = engine === "whisper-turbo-he" ? WHISPER_MODELS.turboHe : engine === "whisper-base" ? WHISPER_MODELS.base : undefined;
          const out = await transcribeAudio(samples, { language, model, timestamps: true });
          return out.segments?.length ? out.segments : out.text.trim() ? [{ start: 0, end: duration, text: out.text }] : [];
        })();
  return { samples: keep, duration, segments, engine, language };
}

/** Keep the audio in attachments/ (the transcript's times link to it), or null when the vault can't. */
export async function keepAudio(picked: Blob & { name?: string }): Promise<string | null> {
  if (!isOPFSAvailable()) return null;
  try {
    const path = attachmentName(picked.name ?? "audio");
    await writeWorkspaceBlob(path, picked);
    notifyWorkspaceChanged();
    return path;
  } catch (e) {
    log.warn("transcribe file: could not keep the audio", e);
    return null;
  }
}

export async function transcribeAudioFile(file?: File | null): Promise<void> {
  const picked = file ?? (await pickFile());
  if (!picked) return;
  const started = performance.now();
  try {
    const { segments } = await transcribeFileAudio(picked);
    const sentences = sentencesOf(segments);
    if (!sentences.length) {
      showAiToast(t("transcribeFile.empty"), "info");
      return;
    }
    const audioPath = await keepAudio(picked);
    insert(`\n\n### ${picked.name}\n\n${transcriptMarkdown(sentences, audioPath)}\n`);
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    showAiToast(t("transcribeFile.done", { n: sentences.length, seconds }), "success");
    if (audioPath) showAiToast(t("transcribeFile.audioSaved", { path: audioPath }), "info");
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    showAiToast(t("transcribeFile.failed", { error: explainError(e) }), "error");
  }
}

async function desktopStatus(desktop: typeof import("../ai/dictation/whisperDesktop")) {
  try {
    return await desktop.desktopWhisperStatus();
  } catch (e) {
    log.warn("desktop whisper status", e);
    return { kind: "web" as const };
  }
}
