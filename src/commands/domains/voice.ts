/** Voice: read aloud, voice memo, dictation. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, getLocale } from "../../i18n";
import { uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { getAiPolicy } from "../../ai/policy";
import { showAiToast } from "../../ui/AiToast";
import { explainError } from "../../lib/userError";

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
      },
    },
    {
      id: "note.readSettings",
      label: t("cmd.note.readSettings"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      // Read aloud: voice and speed (plan W2.6); the speed is the reading aids' one (W5.6).
      action: async () => {
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
      },
    },
    {
      id: "reading.aids",
      label: t("cmd.reading.aids"),
      hint: t("cmd.reading.aids.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { openReadingAids } = await import("../../ui/ReadingAids");
        openReadingAids();
      },
    },
    {
      id: "nikud.display",
      label: t("cmd.nikud.display"),
      hint: t("cmd.nikud.display.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { toggleDisplayNikud } = await import("../../ui/ReadingAids");
        await toggleDisplayNikud();
      },
    },
  ];
}

/** Voice memo and dictation. */
export function buildVoiceCommands(): Command[] {
  return [
    {
      // Plan W5.20: one spoken command, recognised and parsed on this device.
      id: "voice.command",
      label: t("cmd.voice.command"),
      hint: t("cmd.voice.command.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("../../ai/voice/run").then((m) => m.runVoiceCommand()),
    },
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
      id: "voice.transcribeFile",
      label: t("cmd.tools.transcribeFile"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => (await import("../../ui/TranscribeFile")).transcribeAudioFile(),
    },
    {
      id: "help.credits",
      label: t("cmd.help.credits"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { openCredits } = await import("../../ui/CreditsDialog");
        openCredits();
      },
    },
    {
      id: "voice.meeting",
      label: t("cmd.voice.meeting"),
      hint: t("cmd.voice.meeting.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        // Plan 6.16: record, transcribe on this device, then meeting notes.
        const { startVoiceMemo } = await import("../../ui/VoiceDictation");
        await startVoiceMemo({ meeting: true });
      },
    },
    {
      id: "voice.meetingFile",
      label: t("cmd.voice.meetingFile"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      // Plan W2.7: a recording → transcript with speakers (W1.17 + diarization) → meeting notes.
      action: async () => (await import("../../meetings/meetingTranscribe")).transcribeMeeting(),
    },
    {
      id: "speakers.rename",
      label: t("cmd.speakers.rename"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => (await import("../../meetings/meetingTranscribe")).renameSpeakerInNote(),
    },
    {
      id: "ai.meetingNotes",
      label: t("cmd.ai.meetingNotes"),
      hint: t("cmd.ai.meetingNotes.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
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
          message: t("voice.languagePrompt"),
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
