/**
 * Desktop Whisper (plan W1.17): ivrit.ai's Hebrew Whisper large-v3-turbo as a
 * ggml file, run by the whisper.cpp CLI (`whisper-cli`, MIT) from the Tauri
 * app (src-tauri/src/lib.rs `whisper_status` / `whisper_transcribe`, logic in
 * whisper_core.rs). The web build never uses it.
 *
 * Model seam: the ggml file is identified only by values the owner pins from
 * Hugging Face — repository, revision, file name, size and sha256
 * (`WHISPER_GGML`). While any of them is null the engine is "unpinned" and
 * never offered; nothing is guessed and nothing downloads from here. Once
 * pinned, the user installs `whisper-cli` and puts the file in the app's data
 * folder (docs: ai/whisper-desktop); the app checks size and sha256 before
 * every use. After that no network request is made: the audio goes to a
 * temporary WAV on this machine and the result comes back as timed segments.
 *
 * Lazy: imported by the file-transcription action only.
 */
import type { TimedSegment } from "../transformersEngine";

export interface GgmlModel {
  /** The source model and its licence (verified: models/registry.json). */
  sourceRepo: string;
  license: string;
  /** The Hugging Face repository that publishes the ggml file. Owner check. */
  repo: string | null;
  /** Its commit sha. Owner check. */
  revision: string | null;
  /** File name inside the repo (also the name in the app's whisper/ folder). Owner check. */
  file: string | null;
  bytes: number | null;
  sha256: string | null;
}

/**
 * TODO(owner, W1.17): pin from Hugging Face (Hugging Face is unreachable
 * where this was written): `npm run whisper:desktop -- pin` prints the
 * commands and checks the values.
 */
export const WHISPER_GGML: GgmlModel = {
  sourceRepo: "ivrit-ai/whisper-large-v3-turbo",
  license: "Apache-2.0",
  repo: null,
  revision: null,
  file: null,
  bytes: null,
  sha256: null,
};

export interface PinnedGgml extends GgmlModel {
  repo: string;
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
}

/** Every value pinned and well-formed (40-hex revision, 64-hex sha256, a plain .bin name). */
export function isPinned(m: GgmlModel): m is PinnedGgml {
  return (
    typeof m.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(m.repo) &&
    typeof m.revision === "string" && /^[0-9a-f]{40}$/.test(m.revision) &&
    typeof m.file === "string" && /^[A-Za-z0-9][\w.-]*\.bin$/.test(m.file) &&
    typeof m.bytes === "number" && m.bytes > 0 &&
    typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256)
  );
}

/** Where the user downloads the pinned file from (the pinned revision, never "main"). */
export function downloadUrl(m: PinnedGgml): string {
  return `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;
}

export type Invoke = <T>(cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => Promise<T>;

export type DesktopWhisperStatus =
  | { kind: "web" }
  | { kind: "unpinned" }
  | { kind: "no-cli"; modelPath: string | null }
  | { kind: "model"; state: "missing" | "wrong-size" | "wrong-checksum"; modelPath: string | null }
  | { kind: "ready" };

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriInvoke(): Promise<Invoke> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke as Invoke;
}

/** Can this app transcribe files with desktop Whisper right now? */
export async function desktopWhisperStatus(deps: { desktop?: boolean; invoke?: Invoke; model?: GgmlModel } = {}): Promise<DesktopWhisperStatus> {
  const model = deps.model ?? WHISPER_GGML;
  if (!(deps.desktop ?? isTauri())) return { kind: "web" };
  if (!isPinned(model)) return { kind: "unpinned" };
  const invoke = deps.invoke ?? (await tauriInvoke());
  const s = await invoke<{ cli: string | null; model: string; model_path: string | null }>("whisper_status", { file: model.file, bytes: model.bytes, sha256: model.sha256 });
  if (s.model !== "ok") return { kind: "model", state: s.model === "wrong-size" || s.model === "wrong-checksum" ? s.model : "missing", modelPath: s.model_path };
  if (!s.cli) return { kind: "no-cli", modelPath: s.model_path };
  return { kind: "ready" };
}

/** 16 kHz float samples → 16-bit little-endian PCM bytes (what whisper_transcribe takes). */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(i * 2, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
  }
  return out;
}

/** Transcribe 16 kHz mono samples with whisper-cli; the language is forced. → segments in seconds. */
export async function transcribeDesktop(samples: Float32Array, opts: { language: string; invoke?: Invoke; model?: GgmlModel }): Promise<TimedSegment[]> {
  const model = opts.model ?? WHISPER_GGML;
  if (!isPinned(model)) throw new Error("desktop Whisper model is not pinned");
  const language = opts.language.split(/[-_]/)[0].toLowerCase();
  const invoke = opts.invoke ?? (await tauriInvoke());
  const segs = await invoke<Array<{ start_ms: number; end_ms: number; text: string }>>("whisper_transcribe", toPcm16(samples), {
    headers: {
      "x-lumen-lang": language,
      "x-lumen-model-file": model.file,
      "x-lumen-model-bytes": String(model.bytes),
      "x-lumen-model-sha256": model.sha256,
    },
  });
  return segs.map((s) => ({ start: s.start_ms / 1000, end: s.end_ms / 1000, text: s.text }));
}
