/**
 * Bodies of palette commands that load on use (perf, plan W4.9): the palette
 * lists the commands from the domain file; a body arrives when its command
 * runs, so none of this code is in the startup bundle.
 */
import { useAppStore } from "../../store/useStore";
import { getLocale, t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import { getAiPolicy } from "../../ai/policy";
import { uiConfirm, uiSelect, uiPrompt } from "../../ui/PromptDialog";
import { explainError } from "../../lib/userError";

/** `note.read` (moved from voice.ts, which loads this module when the command runs). */
export const noteRead = async () => {
  const store = useAppStore.getState();
  // why: the reading-aids speed (plan W5.6); a small lazy module, loaded with the reading
  const [tts, { loadAids }] = await Promise.all([import("../../ai/tts"), import("../../reading/readingAids")]);
  await tts.readAloudCommand({
    content: store.doc.content,
    doc: store.doc,
    uiLang: getLocale(),
    t,
    toast: showAiToast,
    rate: loadAids().rate,
    // No voice on this device, but the browser offers network voices: ask once (never under local-only).
    confirmNetworkVoice: () =>
      getAiPolicy() === "local-only" ? Promise.resolve(false) : uiConfirm({ title: t("tts.networkVoice.title"), message: t("tts.networkVoice.body"), okLabel: t("tts.networkVoice.ok") }),
  });
};

/** `note.readSettings` (moved from voice.ts, which loads this module when the command runs). */
export const noteReadSettings = async () => {
  const [tts, aids] = await Promise.all([import("../../ai/tts"), import("../../reading/readingAids")]);
  await tts.readAloudSettings({
    content: useAppStore.getState().doc.content,
    uiLang: getLocale(),
    t,
    toast: showAiToast,
    select: uiSelect,
    rate: aids.loadAids().rate,
    setRate: (rate) => aids.saveAids({ ...aids.loadAids(), rate }),
  });
};

/** `ai.meetingNotes` (moved from voice.ts, which loads this module when the command runs). */
export const aiMeetingNotes = async () => {
  // A transcript already in the note (or the selection): meeting notes appended.
  const st = useAppStore.getState();
  const transcript = (window.getSelection()?.toString() ?? "").trim() || st.doc.content.trim();
  if (!transcript) {
    showAiToast(t("meeting.empty"), "info");
    return;
  }
  const [{ meetingNotesFrom, offerIcs }, { aiOperation, isAbort }] = await Promise.all([import("../../meetings/meetingNotes"), import("../../ai/aiAbort")]);
  const op = aiOperation();
  showAiToast(t("toast.summarising"), "info");
  try {
    const res = await meetingNotesFrom(transcript, { signal: op.signal, local: getAiPolicy() === "local-only" });
    const current = useAppStore.getState().doc.content;
    useAppStore.getState().setContent(current + (current.endsWith("\n") ? "" : "\n") + "\n" + res.markdown);
    showAiToast(t("meeting.inserted", { n: res.notes.tasks.length }), "success");
    void offerIcs(res);
  } catch (e) {
    if (!isAbort(e)) showAiToast(explainError(e), "error");
  } finally {
    op.end();
  }
};

/** `voice.dictate` (moved from voice.ts, which loads this module when the command runs). */
export const voiceDictate = async () => {
  // Language selector
  const langMap: Record<string, string> = {
    "English": "en-US", "Hebrew (עברית)": "he-IL", "Arabic (العربية)": "ar-SA",
    "Russian (Русский)": "ru-RU", "Spanish": "es-ES", "French": "fr-FR",
    "German": "de-DE", "Chinese (中文)": "zh-CN", "Japanese (日本語)": "ja-JP",
  };
  const langChoice = await uiPrompt({
    message: t("voice.languagePrompt"),
    placeholder: "English",
  });
  const lang = langMap[langChoice ?? ""] ?? (useAppStore.getState().locale === "he" ? "he-IL" : "en-US");

  // Loaded on use, as for the voice memo: dictation (and the
  // transcription code it brings) stays out of the startup bundle.
  const { startVoiceRecording } = await import("../../ui/VoiceDictation");
  startVoiceRecording(lang);
};
