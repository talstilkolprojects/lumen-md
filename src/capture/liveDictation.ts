/**
 * Live transcription in voice capture (plan W1.13 step 1, plan 6.1; audit
 * W10.C8): registers the Zipformer dictation (the streaming Hebrew model of
 * 6.1) as the capture's live engine (`setVoiceTranscriber`) once its model
 * is on this device. Partial text arrives while the user speaks; the
 * finished sentences are the transcript.
 *
 * Registered at startup (App) and again after the dictation model is
 * downloaded. Without the model nothing is registered, and the capture box
 * says the recording is transcribed after it stops (local Whisper). The
 * model is Hebrew only: for another language the engine refuses to start,
 * and the same after-the-recording path runs.
 *
 * On this device under every AI policy: the model and the audio stay here.
 * Loaded lazily; nothing here is in the startup bundle.
 */
import { setVoiceTranscriber, type LiveTranscript, type VoiceTranscriber } from "./voiceCapture";
import type { DictationCallbacks, DictationSession } from "../ai/dictation/session";

/** What the engine needs from the dictation stack (tests pass a scripted session). */
export interface LiveDictationDeps {
  downloaded(): Promise<boolean>;
  start(cb: DictationCallbacks, signal?: AbortSignal): Promise<DictationSession>;
}

const appDeps: LiveDictationDeps = {
  downloaded: async () => (await import("../ai/dictation/modelStore")).isDictationModelDownloaded(),
  start: async (cb, signal) => {
    const [{ loadDictationFiles }, { createDictationAudioContext, startDictationSession }] = await Promise.all([import("../ai/dictation/modelStore"), import("../ai/dictation/session")]);
    // Made before the model load, while the click's activation lasts (autoplay policy).
    const audioContext = createDictationAudioContext();
    const files = await loadDictationFiles(undefined, signal);
    return startDictationSession(files, cb, { audioContext, signal });
  },
};

/** The languages the streaming model knows (ENGINES["zipformer-he"].languages). */
const knows = (language?: string) => !language || language.split(/[-_]/)[0].toLowerCase() === "he";

/** The capture's live engine over a dictation session. */
export function liveDictationTranscriber(deps: LiveDictationDeps = appDeps): VoiceTranscriber {
  return async ({ language, onPartial, signal }) => {
    if (!knows(language)) throw new Error(`live dictation knows Hebrew only, not ${language}`);
    const finals: string[] = [];
    const joined = (interim = "") => [...finals, interim.trim()].filter(Boolean).join(" ");
    let failed: string | null = null;
    const session = await deps.start(
      {
        onInterim: (text) => onPartial(joined(text)),
        onFinal: (text) => {
          if (text.trim()) finals.push(text.trim());
          onPartial(joined());
        },
        onError: (message) => {
          failed = message;
        },
      },
      signal,
    );
    let done = false;
    const transcript: LiveTranscript = {
      async stop() {
        if (done) return null;
        done = true;
        await session.stop();
        const text = joined();
        // A failed session's text is partial at best: the recording is transcribed again after it.
        return failed !== null || !text ? null : text;
      },
      cancel() {
        if (done) return;
        done = true;
        void session.stop().catch(() => undefined);
      },
    };
    return transcript;
  };
}

/** Register the live engine when the model is on this device (true), or unregister it (false). */
export async function registerLiveVoiceTranscriber(deps: LiveDictationDeps = appDeps): Promise<boolean> {
  let ok = false;
  try {
    ok = await deps.downloaded();
  } catch {
    ok = false;
  }
  setVoiceTranscriber(ok ? liveDictationTranscriber(deps) : null);
  return ok;
}
