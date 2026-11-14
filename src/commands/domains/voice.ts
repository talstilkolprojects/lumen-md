/** Voice: read aloud, voice memo, dictation. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, getLocale } from "../../i18n";
import { uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { getAiPolicy } from "../../ai/policy";
import { showAiToast } from "../../ui/AiToast";

/** Read the note aloud (text to speech). */
export function buildReadAloudCommands(): Command[] {
  return [
    {
      id: "note.read",
      label: t("cmd.note.read"),
      hint: t("cmd.note.read.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const tts = await import("../../ai/tts");
        if (tts.isSpeaking()) {
          tts.stopSpeaking();
          return;
        }
        if (!tts.ttsAvailable()) {
          showAiToast(t("toast.tts.unavailable"), "error");
          return;
        }
        const content = useAppStore.getState().doc.content;
        await tts.voicesReady(); // why: the list is empty until voiceschanged on a fresh page
        // No voice on this device, but the browser offers network voices: ask once (never under local-only).
        if (!tts.hasLocalVoiceFor(content, getLocale()) && tts.offersNetworkVoices() && !tts.networkVoicesAllowed() && getAiPolicy() !== "local-only") {
          const yes = await uiConfirm({ title: t("tts.networkVoice.title"), message: t("tts.networkVoice.body"), okLabel: t("tts.networkVoice.ok") });
          if (yes) tts.allowNetworkVoices();
        }
        const ok = await tts
          .speak(content, {
            uiLang: getLocale(),
            onSentence: (s) => window.dispatchEvent(new CustomEvent("lumen-speech-range", { detail: { from: s.from, to: s.to } })),
          })
          .finally(() => window.dispatchEvent(new CustomEvent("lumen-speech-range", { detail: null })));
        if (!ok) showAiToast(t(/[\u0590-\u05FF]/.test(content) ? "toast.tts.noHebrewVoice" : "toast.tts.noLocalVoice"), "info");
      },
    },
  ];
}

/** Voice memo and dictation. */
export function buildVoiceCommands(): Command[] {
  return [
    {
      id: "voice.memo",
      label: t("cmd.tools.voiceMemo"),
      hint: t("cmd.tools.voiceMemo.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { startVoiceMemo } = await import("../../ui/VoiceDictation");
        await startVoiceMemo();
      },
    },
    {
      id: "voice.dictate",
      label: t("cmd.tools.voice"),
      hint: t("cmd.tools.voice.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        // Language selector
        const langMap: Record<string, string> = {
          "English": "en-US", "Hebrew (עברית)": "he-IL", "Arabic (العربية)": "ar-SA",
          "Russian (Русский)": "ru-RU", "Spanish": "es-ES", "French": "fr-FR",
          "German": "de-DE", "Chinese (中文)": "zh-CN", "Japanese (日本語)": "ja-JP",
        };
        const langChoice = await uiPrompt({
          message: "Select language for voice recognition:",
          placeholder: "English",
        });
        const lang = langMap[langChoice ?? ""] ?? (useAppStore.getState().locale === "he" ? "he-IL" : "en-US");

        // Loaded on use, as for the voice memo: dictation (and the
        // transcription code it brings) stays out of the startup bundle.
        const { startVoiceRecording } = await import("../../ui/VoiceDictation");
        startVoiceRecording(lang);
      },
    },
  ];
}
