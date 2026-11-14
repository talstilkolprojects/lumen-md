/** Voice: read aloud, voice memo, dictation. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";

/** Read the note aloud (text to speech). */
export function buildReadAloudCommands(): Command[] {
  return [
    {
      id: "note.read",
      label: t("cmd.note.read"),
      hint: t("cmd.note.read.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./voiceActions").then((m) => m.noteRead()),
    },
    {
      id: "note.readSettings",
      label: t("cmd.note.readSettings"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      // Read aloud: voice and speed (plan W2.6); the speed is the reading aids' one (W5.6).
      action: () => import("./voiceActions").then((m) => m.noteReadSettings()),
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
      action: () => import("./voiceActions").then((m) => m.aiMeetingNotes()),
    },
    {
      id: "voice.dictate",
      label: t("cmd.tools.voice"),
      hint: t("cmd.tools.voice.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./voiceActions").then((m) => m.voiceDictate()),
    },
  ];
}
