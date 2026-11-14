/**
 * Plan W5.20 — the "Voice command" palette command: listen for one
 * sentence with the local dictation model (Zipformer2, 6.1), parse it with
 * the intent grammar and run it. All on the device: the model is the one
 * dictation downloaded, the grammar is a table. Loaded with a dynamic
 * import only.
 */
import "./strings";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import { uiConfirm } from "../../ui/PromptDialog";
import { parseIntent } from "./intents";
import { runIntent, type IntentDeps } from "./dispatch";

/** How long to wait for the sentence (the user starts speaking, then pauses). */
export const LISTEN_MS = 8000;

const appDeps: IntentDeps = {
  runCommand: (id) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id } })),
  confirm: () => uiConfirm({ message: t("voiceCmd.confirmDelete"), okLabel: t("voiceCmd.confirmOk") }),
  capture: async (text) => (await import("../../capture/quickCapture")).captureToInbox(text),
  insert: (text) => window.dispatchEvent(new CustomEvent("lumen-dictation-insert", { detail: { text }, cancelable: true })),
  searchFor: (query) => window.dispatchEvent(new CustomEvent("lumen-search-query", { detail: { query } })),
};

/** One sentence from the microphone, through the dictation model; "" on silence or timeout. */
async function listenOnce(): Promise<string | null> {
  const { isDictationModelDownloaded, loadDictationFiles } = await import("../dictation/modelStore");
  if (!(await isDictationModelDownloaded())) return null;
  const { createDictationAudioContext, startDictationSession } = await import("../dictation/session");
  const audioContext = createDictationAudioContext();
  const files = await loadDictationFiles();
  return new Promise<string>((resolve) => {
    let done = false;
    let session: { stop(): Promise<void> } | null = null;
    const finish = (text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void session?.stop();
      resolve(text);
    };
    const timer = setTimeout(() => finish(""), LISTEN_MS);
    void startDictationSession(files, { onFinal: (text) => text.trim() && finish(text), onError: () => finish("") }, { audioContext }).then((s) => {
      session = s;
      if (done) void s.stop();
    });
  });
}

export async function runVoiceCommand(deps: IntentDeps = appDeps): Promise<void> {
  showAiToast(t("voiceCmd.listening"), "info");
  const heard = await listenOnce();
  if (heard === null) {
    showAiToast(t("voiceCmd.needsModel"), "info");
    return;
  }
  const intent = parseIntent(heard);
  if (!intent) {
    if (heard.trim()) showAiToast(t("voiceCmd.unknown", { text: heard.trim() }), "info");
    return;
  }
  showAiToast(t("voiceCmd.heard", { command: intent.trigger }), "info");
  await runIntent(intent, deps);
}
