/**
 * Voice → text transcription (γ.4 / F2).
 *
 * Two backends:
 *   - **Local** (the default): Whisper through transformers.js in a Web
 *     Worker (./transformersEngine.ts) — multilingual, on WebGPU when the
 *     GPU is usable and on wasm otherwise. The audio never leaves the
 *     browser. First use downloads the model (40 MB – 800 MB by device).
 *   - **Cloud**: POSTs the audio blob to OpenAI's `/v1/audio/transcriptions`
 *     (`whisper-1`). Only under the `cloud` AI policy, or under
 *     `local-first` when the local path fails.
 *
 * Both paths return the same `TranscribeResult` shape so the caller stays
 * branch-free. The summary step is in `summarizeMemo()` — it routes
 * through `chat()`, so it follows the same policy.
 */

import { chat, getAiKey, AiError } from "./llm";
import { assertCloudAllowed, getAiPolicy } from "./policy";
import { PROMPTS } from "./prompts";
import { log } from "../lib/logger";
import { fetchWithRetry } from "../lib/fetchRetry";

export interface TranscribeOptions {
  /** Override the language hint sent to Whisper (default: auto). */
  language?: string;
  /** AbortSignal for cancelling long-running Whisper jobs. */
  signal?: AbortSignal;
}

export interface TranscribeResult {
  /** Plain-text transcript. */
  text: string;
  /** "cloud" | "local" — the backend that produced the result. */
  backend: "cloud" | "local";
  /** Wall-clock duration of the transcription pass, in ms. */
  ms: number;
}

const OPENAI_TRANSCRIPTION_URL =
  "https://api.openai.com/v1/audio/transcriptions";

/**
 * Run Whisper on the supplied audio blob. Local by default; the cloud
 * only under the `cloud` policy, or as the `local-first` fallback.
 */
export async function transcribe(
  blob: Blob,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const policy = getAiPolicy();
  const start = performance.now();
  if (policy !== "cloud") {
    try {
      const text = await transcribeLocal(blob, opts);
      return { text, backend: "local", ms: performance.now() - start };
    } catch (err) {
      if (policy === "local-only" || opts.signal?.aborted) throw err;
      log.warn("local transcription failed; trying the cloud (local-first)", err);
    }
  }
  const text = await transcribeCloud(blob, opts);
  return { text, backend: "cloud", ms: performance.now() - start };
}

async function transcribeCloud(
  blob: Blob,
  opts: TranscribeOptions,
): Promise<string> {
  assertCloudAllowed("OpenAI Whisper transcription");
  const key = getAiKey(); // throws AiError("NO_KEY") if missing
  const form = new FormData();
  form.append("file", blob, "memo.webm");
  form.append("model", "whisper-1");
  if (opts.language) form.append("language", opts.language);
  form.append("response_format", "json");
  const res = await fetchWithRetry(
    OPENAI_TRANSCRIPTION_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: opts.signal,
    },
    { label: "transcribe.whisper", maxRetries: 2, baseDelayMs: 600, maxDelayMs: 2500 },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AiError(
      "API_ERROR",
      `Whisper failed (${res.status}): ${detail.slice(0, 160)}`,
    );
  }
  const json = (await res.json()) as { text?: string };
  if (typeof json.text !== "string") {
    throw new AiError("PARSE_ERROR", "Whisper response missing `text` field");
  }
  return json.text.trim();
}

/**
 * Local Whisper: decode the recording to 16 kHz mono on the main thread
 * (workers have no AudioContext), then transcribe in the transformers.js
 * worker. A Whisper language code is an ISO-639-1 code ("he"); callers may
 * pass a BCP-47 tag ("he-IL"), which is reduced here.
 */
async function transcribeLocal(blob: Blob, opts: TranscribeOptions): Promise<string> {
  const { decodeAudioTo16k, transcribeAudio } = await import("./transformersEngine");
  const samples = await decodeAudioTo16k(blob);
  if (!samples.length) throw new AiError("PARSE_ERROR", "The recording is empty.");
  const language = opts.language ? opts.language.split(/[-_]/)[0].toLowerCase() : undefined;
  const out = await transcribeAudio(samples, { language, signal: opts.signal });
  if (typeof out.text !== "string") throw new AiError("PARSE_ERROR", "Local whisper returned no text");
  return out.text.trim();
}

/**
 * Two-bullet summary of a transcript. Routes through `chat()` so it
 * honors Privacy Mode (local Llama via web-llm) automatically.
 */
export async function summarizeMemo(transcript: string, signal?: AbortSignal): Promise<string> {
  if (!transcript.trim()) return "";
  // Pays for itself when sent (ownPrompt), not attributed to a palette
  // command that may be waiting in a dialog at the same time.
  return chat(
    [
      { role: "system", content: PROMPTS.summarize },
      { role: "user", content: transcript },
    ],
    { maxTokens: 120, ownPrompt: true, signal },
  );
}

/**
 * Format a memo for insertion at the editor cursor. The summary lives
 * in a quote block; the full transcript collapses behind a `<details>`
 * so it doesn't dominate the surrounding doc.
 */
export function formatVoiceMemo(args: {
  transcript: string;
  summary: string;
  date?: Date;
  backend: "cloud" | "local";
}): string {
  const date = (args.date ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  const tagSuffix = args.backend === "local" ? " · 🛡 local" : "";
  return [
    `> 🎙 Voice memo · ${date}${tagSuffix}`,
    "",
    args.summary || "_(no summary available)_",
    "",
    "<details><summary>Full transcript</summary>",
    "",
    args.transcript,
    "",
    "</details>",
    "",
  ].join("\n");
}
