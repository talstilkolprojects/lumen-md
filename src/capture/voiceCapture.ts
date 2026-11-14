/**
 * Voice capture into the inbox (plan W1.13): record, transcribe on this
 * device, and add the text to inbox.md like a typed capture (plan 4.16) —
 * optionally with the recording saved as an attachment and linked with its
 * time range.
 *
 * Recording is the browser's MediaRecorder; the microphone is opened when
 * the user presses the button and released when recording stops.
 * Transcription goes through a seam (`setVoiceTranscriber`, for tests and
 * other engines); by default a Hebrew recording goes through the live-
 * dictation model (ivrit.ai Zipformer2 int8, W11.H7) when it is already on
 * this device, and anything else — or a failure — through local Whisper
 * (transformers.js, on this device under every policy). If no
 * transcript can be made, the note is kept as audio with a placeholder.
 *
 * Loaded with the capture box; nothing here is in the startup bundle.
 */
import { writeWorkspaceBlob } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";

export const ATTACHMENTS_DIR = "attachments";
export const TITLE_MAX = 80;

/** Turns a recording into text (null: none could be made). `onPartial` gets live text when the engine streams. */
export type VoiceTranscriber = (audio: Blob, opts: { language?: string; signal?: AbortSignal }) => Promise<string | null>;

let transcriber: VoiceTranscriber | null = null;
/** Plan 6.1's live dictation (or a test) plugs in here. */
export function setVoiceTranscriber(fn: VoiceTranscriber | null): void {
  transcriber = fn;
}

/**
 * The default: local Whisper (transformers.js worker) after the recording
 * stops — on this device under every AI policy; a voice note is never sent
 * to a cloud service. (Not through ai/transcribe, whose cloud fallback a
 * voice capture must not take, and which the startup bundle already holds.)
 */
async function defaultTranscriber(audio: Blob, opts: { language?: string; signal?: AbortSignal }): Promise<string | null> {
  const { decodeAudioTo16k, transcribeAudio, ortBaseUrl } = await import("../ai/transformersEngine");
  const samples = await decodeAudioTo16k(audio);
  if (!samples.length) return null;
  // Hebrew with the live-dictation model already on this device (W11.H7):
  // ivrit.ai Zipformer2 int8, the same files and worker as live dictation.
  // Whisper stays the fallback (another language, no model yet, or a failure).
  const he = await import("../ai/dictation/fileTranscriber");
  if (he.isHebrew(opts.language)) {
    const store = await import("../ai/dictation/modelStore");
    if (await store.isDictationModelDownloaded().catch(() => false)) {
      try {
        const files = await store.loadDictationFiles(undefined, opts.signal);
        const worker = new Worker(new URL("../ai/dictation/dictation.worker.ts", import.meta.url), { type: "module" });
        const text = await he.transcribeSamples(samples, files, { worker, ortBase: ortBaseUrl(), signal: opts.signal });
        if (text) return text;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") throw e;
        /* why: fall through to Whisper, which can still make a transcript */
      }
    }
  }
  const language = opts.language ? opts.language.split(/[-_]/)[0].toLowerCase() : undefined;
  const out = await transcribeAudio(samples, { language, signal: opts.signal });
  return typeof out.text === "string" ? out.text.trim() || null : null;
}

export function transcribeVoice(audio: Blob, opts: { language?: string; signal?: AbortSignal } = {}): Promise<string | null> {
  return (transcriber ?? defaultTranscriber)(audio, opts);
}

/** The first `max` characters of the transcript, cut at a word, without a trailing period. */
export function titleFromTranscript(text: string, max = TITLE_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one.replace(/[.,;:!?…]+$/, "");
  const cut = one.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : one.slice(0, max)).replace(/[.,;:!?…]+$/, "")}…`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `m:ss` */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** `attachments/voice-2026-11-10-0905-first-words.webm` — the title's words, safe for any file system. */
export function attachmentPath(when: Date, title: string, ext = "webm"): string {
  const slug = title
    .normalize("NFC")
    .replace(/…$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const stamp = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}-${pad2(when.getHours())}${pad2(when.getMinutes())}`;
  return `${ATTACHMENTS_DIR}/voice-${stamp}${slug ? `-${slug}` : ""}.${ext}`;
}

/**
 * The capture's text: the title in bold (when the transcript is longer
 * than it), the transcript, and — with the audio kept — a link to the
 * recording with its time range (`#t=0,<end>`, a media fragment).
 */
export function voiceEntryText(transcript: string | null, opts: { placeholder: string; audioPath?: string; durationMs?: number }): string {
  const text = (transcript ?? "").trim();
  const title = text ? titleFromTranscript(text) : "";
  const lines: string[] = [];
  if (!text) lines.push(opts.placeholder);
  else if (title !== text) lines.push(`**${title}**`, text);
  else lines.push(text);
  if (opts.audioPath) {
    const end = Math.max(1, Math.round((opts.durationMs ?? 0) / 1000));
    lines.push(`[▶ 0:00–${clock(end * 1000)}](<${opts.audioPath}#t=0,${end}>)`);
  }
  return lines.join("\n");
}

export interface Recording {
  /** ms from the press to the recorder's start event. */
  readonly startLatencyMs: number;
  readonly mimeType: string;
  /** Stop and resolve to the recording. */
  stop(): Promise<{ audio: Blob; durationMs: number }>;
  /** Stop and drop it. */
  cancel(): void;
}

/** Open the microphone and start recording. Rejects when there is no microphone or permission. */
export async function startRecording(pressedAt = performance.now()): Promise<Recording> {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error("no-recorder");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? "";
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const started = new Promise<number>((resolve) => {
    rec.onstart = () => resolve(performance.now());
  });
  rec.start(250);
  const startedAt = await started;
  return {
    startLatencyMs: startedAt - pressedAt,
    mimeType: rec.mimeType || mimeType,
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = () => {
          release();
          resolve({ audio: new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" }), durationMs: performance.now() - startedAt });
        };
        rec.stop();
      }),
    cancel: () => {
      rec.onstop = release;
      if (rec.state !== "inactive") rec.stop();
      else release();
    },
  };
}

const extOf = (mime: string) => (/mp4/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : "webm");

/** Add a voice capture to the inbox; with `audio`, save it as an attachment first. Resolves to the inbox path. */
export async function captureVoice(transcript: string | null, opts: { placeholder: string; audio?: Blob; durationMs?: number; when?: Date }): Promise<string | null> {
  const when = opts.when ?? new Date();
  let audioPath: string | undefined;
  if (opts.audio) {
    audioPath = attachmentPath(when, titleFromTranscript(transcript ?? ""), extOf(opts.audio.type));
    await writeWorkspaceBlob(audioPath, opts.audio);
    notifyWorkspaceChanged({ kind: "structure", paths: [audioPath] });
  }
  // Loaded here, not at the top: quickCapture registers the capture strings and must only load lazily.
  const { captureToInbox } = await import("./quickCapture");
  return captureToInbox(voiceEntryText(transcript, { placeholder: opts.placeholder, audioPath, durationMs: opts.durationMs }), when);
}
