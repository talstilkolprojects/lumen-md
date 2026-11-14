/**
 * The quick-capture box (plan 4.16): one text field, Enter adds it to the
 * end of inbox.md (Shift+Enter starts a new line), Esc closes. Opened by
 * ⌥⌘N, the command palette, the installed app's "Quick capture" shortcut
 * (`/?capture=1`) and the desktop menu — two steps from anywhere: open,
 * type, Enter. Loaded lazily.
 *
 * Plan W1.13: the microphone button records a voice note on this device;
 * when it stops, the transcript fills the box (to edit before adding) and,
 * with "Keep the recording", the audio is saved under attachments/ and
 * linked from the entry. `/?capture=voice` opens the box already recording
 * (the installed app's "Voice note" shortcut, iOS Shortcuts, an Android
 * home-screen shortcut).
 */

import { useEffect, useRef, useState } from "react";
import { Inbox } from "lucide-react";
import "../capture/strings";
import { t } from "../i18n";
// The capture itself (../capture/quickCapture) loads on use, like ../capture/voiceCapture.
const captureMod = () => import("../capture/quickCapture");
import { isOPFSAvailable } from "../storage/workspace";
import { toast } from "../store/useToastStore";
import "./PromptDialog.css";
import { tapReady } from "../mobile/nativeActions";
import { log } from "../lib/logger";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Start recording as soon as the box opens (`/?capture=voice`). */
  voice?: boolean;
}

type VoiceState = { kind: "idle" } | { kind: "starting" } | { kind: "recording"; since: number } | { kind: "transcribing" };
type VoiceModule = typeof import("../capture/voiceCapture");
type Recording = import("../capture/voiceCapture").Recording;

export function QuickCapture({ open, onClose, voice: voiceOnOpen }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [voice, setVoice] = useState<VoiceState>({ kind: "idle" });
  const [keepAudio, setKeepAudio] = useState(false);
  const [now, setNow] = useState(0);
  const rec = useRef<Recording | null>(null);
  /** The last recording (kept until the capture is added), and whether its transcript failed. */
  const take = useRef<{ audio: Blob; durationMs: number; untranscribed: boolean } | null>(null);
  const mod = useRef<Promise<VoiceModule> | null>(null);
  const voiceMod = () => (mod.current ??= import("../capture/voiceCapture"));

  const startVoice = async () => {
    const pressed = performance.now();
    setVoice({ kind: "starting" });
    try {
      const m = await voiceMod();
      rec.current = await m.startRecording(pressed);
      setVoice({ kind: "recording", since: Date.now() });
    } catch {
      setVoice({ kind: "idle" });
      toast.error(t("capture.voice.noMic"));
    }
  };

  const stopVoice = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setVoice({ kind: "transcribing" });
    const { audio, durationMs } = await r.stop();
    let transcript: string | null = null;
    try {
      const m = await voiceMod();
      transcript = await m.transcribeVoice(audio, { language: document.documentElement.lang || undefined });
    } catch {
      transcript = null;
    }
    take.current = { audio, durationMs, untranscribed: !transcript };
    if (!transcript) {
      // Nothing to read back: keep the audio, or the note would be lost.
      setKeepAudio(true);
      toast.error(t("capture.voice.noTranscript"));
    }
    setText((prev) => [prev.trim(), transcript ?? ""].filter(Boolean).join("\n"));
    setVoice({ kind: "idle" });
    ref.current?.focus();
  };

  useEffect(() => {
    if (voice.kind !== "recording") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [voice.kind]);

  useEffect(() => {
    if (open && voiceOnOpen) void startVoice();
    return () => rec.current?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open, voiceOnOpen]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    // Plan W3.4: a widget tap → the cursor here; the time is kept locally for the < 1 s check.
    const ms = tapReady();
    if (ms !== null) log.info("widget tap → typing", `${ms} ms`);
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  // No closing while a save is pending: the save closes the box when it
  // lands, and must not close a box reopened meanwhile (review #268).
  const close = () => {
    if (!busy) onClose();
  };

  const save = async () => {
    const voiceTake = take.current;
    if (busy || voice.kind !== "idle" || (!text.trim() && !voiceTake)) return;
    if (!isOPFSAvailable()) {
      toast.error(t("capture.noWorkspace"));
      return;
    }
    setBusy(true);
    try {
      if (voiceTake && (keepAudio || voiceTake.untranscribed)) {
        const m = await voiceMod();
        await m.captureVoice(text.trim() || null, { placeholder: t("capture.voice.placeholderNote"), audio: voiceTake.audio, durationMs: voiceTake.durationMs });
      } else await (await captureMod()).captureToInbox(text);
      take.current = null;
      setText("");
      toast.success(t("capture.saved", { path: (await captureMod()).INBOX_PATH }));
      onClose();
    } catch (e) {
      toast.error(t("capture.failed", { error: explainError(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="prompt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-capture-title"
      data-testid="quick-capture"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="prompt-dialog" style={{ width: "min(480px, calc(100vw - 32px))" }}>
        <div id="quick-capture-title" className="prompt-title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Inbox size={16} aria-hidden="true" />
          {t("capture.title")}
        </div>
        <HelpButton topic="workspace/quick-capture" />
        <textarea
          ref={ref}
          className="prompt-input"
          dir="auto"
          rows={3}
          value={text}
          // Saving: what's typed now would be lost when the box clears (review #268).
          readOnly={busy}
          aria-busy={busy}
          aria-label={t("capture.title")}
          placeholder={t("capture.placeholder")}
          style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <div className="prompt-message" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="prompt-btn prompt-btn-cancel"
            data-testid="capture-voice"
            data-state={voice.kind}
            disabled={busy || voice.kind === "starting" || voice.kind === "transcribing"}
            aria-pressed={voice.kind === "recording"}
            aria-label={t("capture.voice.start")}
            onClick={() => void (voice.kind === "recording" ? stopVoice() : startVoice())}
            style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
          >
            <span aria-hidden="true">{voice.kind === "recording" ? "■" : "●"}</span>
            {voice.kind === "recording"
              ? t("capture.voice.recording", { time: `${Math.floor(Math.max(0, now - voice.since) / 60000)}:${String(Math.floor((Math.max(0, now - voice.since) / 1000) % 60)).padStart(2, "0")}` })
              : voice.kind === "transcribing"
                ? t("capture.voice.transcribing")
                : t("capture.voice.start")}
          </button>
          <label style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12 }}>
            <input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} data-testid="capture-keep-audio" />
            {t("capture.voice.keepAudio")}
          </label>
          <span style={{ flex: 1 }}>{t("capture.hint")}</span>
        </div>
        <div className="prompt-actions">
          <button
            type="button"
            className="prompt-btn prompt-btn-cancel"
            disabled={busy}
            onClick={() => {
              onClose();
              void captureMod()
                .then((m) => m.openInbox())
                .catch((e: unknown) => toast.error(t("capture.failed", { error: explainError(e) })));
            }}
          >
            {t("capture.openInbox")}
          </button>
          <button type="button" className="prompt-btn prompt-btn-cancel" disabled={busy} onClick={close}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="prompt-btn prompt-btn-ok" disabled={busy || voice.kind !== "idle" || (!text.trim() && !take.current)} onClick={() => void save()} data-testid="capture-save">
            {t("capture.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
