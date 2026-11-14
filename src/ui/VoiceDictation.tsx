/**
 * Voice capture (F2 / γ.4, plans 1.3 and 6.1).
 *
 * Two flows live behind the same UI:
 *   - **Dictation** (`startVoiceRecording`): Hebrew streams on this device
 *     (LiveDictation.tsx, engine chosen by src/ai/dictation/engines.ts, plan
 *     6.1); other languages, and Hebrew when the live engine is not used,
 *     run Whisper on this device in ~5-second segments (plan 1.3). The
 *     browser's `SpeechRecognition` sends audio to its vendor, so it is used
 *     only under the `cloud` AI policy (plan 6.17) and only after the user
 *     agrees; every use is in the privacy ledger.
 *   - **Memo mode** (when `aiKey` is set OR Privacy Mode is on):
 *     `MediaRecorder` captures the audio, on stop we Whisper-transcribe
 *     + AI-summarize and insert a `> 🎙 Voice memo` block at the cursor.
 *
 * The memo flow follows the AI policy — by default Whisper runs on this
 * device through transformers.js (src/ai/transformersEngine.ts) and the
 * summary through the local model, so no audio bytes leave the browser.
 *
 * `startVoiceMemo()` wraps the memo flow.
 */

import { createRoot } from "react-dom/client";
import { onTabIdChange, tabIdOf, useAppStore } from "../store/useStore";
import { showAiToast } from "./AiToast";
import { t } from "../i18n";
import { transcribe, summarizeMemo, formatVoiceMemo } from "../ai/transcribe";
import { aiOperation, isAbort } from "../ai/aiAbort";
import { log } from "../lib/logger";
import { getAiPolicy, onAiPolicyChange, thirdPartyServicesAllowed } from "../ai/policy";
import { recordBrowserService, recordSpeechRecognition } from "../ai/privacyLedger";
import { chooseDictationEngine, webSpeechOptedIn, WEB_SPEECH_KEY, Segmenter, SerialQueue } from "../ai/dictation";

// SpeechRecognition is poorly + inconsistently typed across DOM lib
// variants; keep the surface deliberately loose so we don't fight the
// browser-shape soup.
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    [i: number]: { transcript: string };
  }>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

/** The floating "recording" pill with a Stop button. Returns its teardown. */
function showRecordingPill(label: string, onStop: () => void): () => void {
  const host = document.createElement("div");
  host.id = "voice-recording-root";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
      <div
        style={{
          position: "fixed",
          bottom: 20,
          insetInlineEnd: 20,
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "hsl(var(--bg))",
          border: "1px solid hsl(var(--border-strong))",
          borderRadius: 12,
          padding: "10px 16px",
          boxShadow: "0 8px 32px hsl(0 0% 0%/0.3)",
          fontSize: 13,
          color: "hsl(var(--fg))",
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "#ef4444",
            animation: "pulse 1s infinite",
          }}
        />
        <span>{label}</span>
        <button
          onClick={onStop}
          style={{
            background: "#ef4444",
            color: "white",
            border: "none",
            borderRadius: 6,
            padding: "4px 12px",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {t("voice.stop")}
        </button>
        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
      </div>,
  );
  return () => {
    try {
      root.unmount();
    } catch {
      // why: already unmounted by an earlier stop
    }
    host.remove();
  };
}

type SpeechCtor = new () => SpeechRecognitionLike;
function webSpeechCtor(): SpeechCtor | null {
  const w = window as Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return ((w.SpeechRecognition ?? w.webkitSpeechRecognition) as SpeechCtor | undefined) ?? null;
}

function localDictationSupported(): boolean {
  const w = window as Window & { webkitAudioContext?: unknown };
  return !!navigator.mediaDevices?.getUserMedia && (typeof AudioContext !== "undefined" || !!w.webkitAudioContext);
}

const joinDictated = (current: string, words: string) => current + (current.endsWith("\n\n") || !current ? "" : "\n\n") + words;

/** Appends dictated text; `dispose()` when the dictation ends. */
export type DictationSink = ((text: string) => void) & { dispose: () => void };

/**
 * Where dictated text goes: the note that was open when dictation started,
 * even if the user switched tabs while Whisper was still working, or the
 * note got a new tab id (autosave adopting an ad-hoc note into the
 * workspace, a rename, a move). If that note was closed, the rest goes to a
 * new note instead of whatever is open. Exported for tests.
 */
export function dictationSink(): DictationSink {
  let origin = tabIdOf(useAppStore.getState().doc);
  let orphan: string | null = null; // name of the note that took over, once created
  const unfollow = onTabIdChange((from, to) => {
    if (origin === from) origin = to;
    if (orphan === from) orphan = to;
  });
  const append = (text: string) => {
    const words = text.trim();
    if (!words) return;
    const s = useAppStore.getState();
    if (tabIdOf(s.doc) === origin) {
      s.setContent(joinDictated(s.doc.content, words));
    } else if (s.openTabs.some((tab) => tab.id === origin)) {
      useAppStore.setState({
        openTabs: s.openTabs.map((tab) => (tab.id === origin ? { ...tab, content: joinDictated(tab.content, words), dirty: true } : tab)),
      });
    } else if (orphan && s.openTabs.some((tab) => tab.id === orphan)) {
      const id = orphan;
      if (tabIdOf(s.doc) === id) s.setContent(joinDictated(s.doc.content, words));
      else useAppStore.setState({ openTabs: s.openTabs.map((tab) => (tab.id === id ? { ...tab, content: joinDictated(tab.content, words), dirty: true } : tab)) });
    } else {
      const taken = new Set(s.openTabs.map((tab) => tab.id));
      taken.add(tabIdOf(s.doc));
      let name = `${t("dictate.newNoteName")}.md`;
      for (let i = 2; taken.has(name); i++) name = `${t("dictate.newNoteName")} ${i}.md`;
      orphan = name;
      s.openTab({ name, content: words, workspaceName: null });
      useAppStore.getState().setDoc({ dirty: true });
      showAiToast(t("toast.dictate.noteClosed", { name }), "info");
      return;
    }
    showAiToast(t("toast.addedWords", { count: words.split(/\s+/).length }), "info");
  };
  return Object.assign(append, { dispose: unfollow });
}

/**
 * Dictate into the open note (plan 1.3). Default: Whisper on this device, in
 * ~5-second segments. The browser speech service (which sends the audio to
 * the vendor) is used only when the policy is not local-only AND the user
 * agreed — never silently; each use is recorded in the privacy ledger.
 */
export function startVoiceRecording(lang: string): void {
  if (lang.split(/[-_]/)[0].toLowerCase() !== "he") {
    startDeviceDictation(lang);
    return;
  }
  // Hebrew (plan 6.1): the live streaming engine and its panel load on first
  // use. Its fallbacks are this module's: the browser service behind the same
  // consent and local-only gate, else Whisper on this device.
  void import("./LiveDictation")
    .then(({ openLiveDictation }) =>
      openLiveDictation(lang, {
        browser: () => startBrowserSpeech(lang),
        record: () => startDeviceDictation(lang),
      }),
    )
    .catch((err: unknown) => {
      log.error("dictation failed to start", err);
      showAiToast(t("dictation.error", { error: (err as Error).message }), "error");
    });
}

/**
 * The browser's speech service (audio goes to its vendor), asked for by the
 * live-dictation panel: never under local-only (1.3), and only once the user
 * agreed (the same consent as below).
 */
export function startBrowserSpeech(lang: string): void {
  if (getAiPolicy() === "local-only") {
    recordBrowserService("speech recognition (browser vendor)", "Browser speech recognition (Web Speech API)");
    showAiToast(t("dictation.localOnlyNoBrowser"), "error");
    return;
  }
  // The browser's speech recognition streams the audio to its vendor's
  // servers (Chrome: Google). Only under the explicit `cloud` policy;
  // otherwise record and transcribe on this device (plan 6.17).
  if (!thirdPartyServicesAllowed()) {
    startDeviceDictation(lang);
    return;
  }
  const Ctor = webSpeechCtor();
  if (!Ctor) {
    showAiToast(t("toast.speechRecognitionNotSupportedIn"), "error");
    return;
  }
  if (webSpeechOptedIn()) startWebSpeech(Ctor, lang);
  else void offerWebSpeech(Ctor, lang);
}

/** Dictation without the live engine: Whisper on this device, or the browser service once agreed (1.3). */
function startDeviceDictation(lang: string): void {
  const Ctor = webSpeechCtor();
  const policy = getAiPolicy();
  const engine = chooseDictationEngine(policy, !!Ctor, webSpeechOptedIn());
  if (engine === "webspeech" && Ctor) {
    startWebSpeech(Ctor, lang);
    return;
  }
  if (localDictationSupported()) {
    void startLocalDictation(lang, () => {
      // why: under local-only there is no fallback to offer; the failure toast already said what happened
      if (Ctor && getAiPolicy() !== "local-only") void offerWebSpeech(Ctor, lang);
    }).catch((err) => {
      log.warn("local dictation failed", err);
      void offerWebSpeech(Ctor, lang);
    });
    return;
  }
  if (!Ctor) {
    showAiToast(t("toast.speechRecognitionNotSupportedIn"), "error");
    return;
  }
  void offerWebSpeech(Ctor, lang);
}

/** Local dictation is impossible here: under local-only say so (and log the block); otherwise ask. */
async function offerWebSpeech(Ctor: SpeechCtor | null, lang: string): Promise<void> {
  if (!Ctor) {
    showAiToast(t("toast.speechRecognitionNotSupportedIn"), "error");
    return;
  }
  if (refuseUnderLocalOnly()) return;
  // why: outside the `cloud` policy the browser service is not offered (plan 6.17); the local failure was already reported
  if (!thirdPartyServicesAllowed()) return;
  const { uiConfirm } = await import("./PromptDialog");
  const yes = await uiConfirm({ title: t("dictate.webSpeech.title"), message: t("dictate.webSpeech.body"), okLabel: t("dictate.webSpeech.ok") });
  if (!yes) return;
  try {
    localStorage.setItem(WEB_SPEECH_KEY, "1");
  } catch {
    // why: storage blocked — the consent then lasts for this dictation only
  }
  startWebSpeech(Ctor, lang);
}

/** Read the policy now (it may have changed in another tab): under local-only, log the block and say so. */
function refuseUnderLocalOnly(): boolean {
  if (getAiPolicy() !== "local-only") return false;
  recordSpeechRecognition("blocked");
  showAiToast(t("toast.dictate.localOnlyBlocked"), "error");
  return true;
}

function startWebSpeech(Ctor: SpeechCtor, lang: string): void {
  // why: the single gate in front of the network service — re-checked after any await
  if (refuseUnderLocalOnly()) return;
  if (!thirdPartyServicesAllowed()) return; // why: only under the `cloud` policy (plan 6.17)
  const appendDictated = dictationSink();
  recordSpeechRecognition("allowed");
  showAiToast(t("toast.dictate.webSpeechActive"), "info");
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.interimResults = false;
  recognition.continuous = true;
  let hidePill = () => {};
  let ended = false;
  let unwatch = () => {};
  const cleanup = () => {
    hidePill();
    unwatch();
    if (ended) return;
    ended = true;
    appendDictated.dispose();
  };
  const stop = () => {
    recognition.stop();
    cleanup();
    showAiToast(t("toast.recordingStopped"), "info");
  };
  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) transcript += event.results[i][0].transcript + " ";
    }
    appendDictated(transcript);
  };
  recognition.onerror = () => {
    cleanup();
    showAiToast(t("toast.speechRecognitionErrorCheckMicrophone"), "error");
  };
  recognition.onend = () => cleanup();
  // why: local-only switched on mid-session (settings here or in another tab) — not one more second of audio to the vendor
  unwatch = onAiPolicyChange(() => {
    if (ended || getAiPolicy() !== "local-only") return;
    recognition.stop();
    cleanup();
    showAiToast(t("toast.dictate.stoppedLocalOnly"), "info");
  });
  hidePill = showRecordingPill(t("voice.recording", { lang }), stop);
  recognition.start();
}

/**
 * Microphone → 5-second 16 kHz segments → Whisper in the worker → the note.
 * Nothing leaves the device. `onFailure` runs once if transcription fails
 * (worker, model download or inference) or the audio context won't resume,
 * after the microphone is released. Cancellable (Esc / "AI: Cancel") from
 * the first moment, the microphone prompt included.
 */
async function startLocalDictation(lang: string, onFailure: () => void): Promise<void> {
  // why: registered before the permission prompt and the engine import, so Esc / "AI: Cancel" also stops a dictation that is still starting
  const op = aiOperation();
  const appendDictated = dictationSink();
  const release: Array<() => void> = [() => op.end(), () => appendDictated.dispose()];
  const releaseAll = () => {
    for (const r of release.splice(0).reverse()) {
      try {
        r();
      } catch {
        // why: best-effort teardown; one failure must not keep the mic open
      }
    }
  };
  op.signal.addEventListener("abort", releaseAll);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const cancelled = op.signal.aborted;
    releaseAll();
    if (cancelled) return;
    throw err;
  }
  // why: cancelled while the permission prompt was open — the microphone that arrived late is released at once
  if (op.signal.aborted) {
    stream.getTracks().forEach((tr) => tr.stop());
    return;
  }
  release.push(() => stream.getTracks().forEach((tr) => tr.stop()));
  try {
    const w = window as Window & { webkitAudioContext?: typeof AudioContext };
    const Ctx = typeof AudioContext !== "undefined" ? AudioContext : (w.webkitAudioContext as typeof AudioContext);
    const ctx = new Ctx();
    release.push(() => void ctx.close());
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor works everywhere without a worklet module (which the CSP would have to allow).
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const { transcribeAudio } = await import("../ai/transformersEngine");
    if (op.signal.aborted) return; // the abort listener already released everything
    const queue = new SerialQueue();
    const language = lang.split(/[-_]/)[0].toLowerCase();
    let failed = false;
    let stopped = false;
    let cleanup = () => {};
    const stop = (quiet = false) => {
      if (stopped) return;
      stopped = true;
      proc.disconnect();
      source.disconnect();
      stream.getTracks().forEach((tr) => tr.stop());
      segmenter.flush();
      cleanup();
      void queue.idle().finally(() => {
        releaseAll();
        if (!quiet) showAiToast(t("toast.recordingStopped"), "info");
      });
    };
    const segmenter = new Segmenter({
      rate: ctx.sampleRate,
      onSegment: (seg) => {
        void queue.add(async () => {
          if (op.signal.aborted || failed) return;
          try {
            const out = await transcribeAudio(seg, { language, signal: op.signal });
            if (typeof out.text === "string") appendDictated(out.text);
          } catch (err) {
            if (isAbort(err) || failed) return;
            // why: one failure means the worker or model is unusable — say so once, release the mic, offer the fallback
            failed = true;
            log.warn("dictation segment failed", err);
            showAiToast(t("toast.dictate.localFailed", { error: (err as Error)?.message ?? String(err) }), "error");
            stop(true);
            onFailure();
          }
        });
      },
    });
    proc.onaudioprocess = (e) => segmenter.push(e.inputBuffer.getChannelData(0));
    source.connect(proc);
    proc.connect(ctx.destination);
    // why: a context made after a slow permission prompt can start suspended (autoplay rules); then onaudioprocess never fires
    if (ctx.state !== "running") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resumed = await Promise.race([
        ctx.resume().then(() => true, () => false),
        new Promise<false>((r) => (timer = setTimeout(() => r(false), RESUME_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
      if (op.signal.aborted) return;
      if (!resumed || (ctx.state as AudioContextState) !== "running") {
        releaseAll();
        showAiToast(t("toast.dictate.localFailed", { error: t("dictate.audioSuspended") }), "error");
        onFailure();
        return;
      }
    }
    op.signal.removeEventListener("abort", releaseAll);
    op.signal.addEventListener("abort", () => stop());
    cleanup = showRecordingPill(t("voice.recording", { lang }), () => stop());
    showAiToast(t("toast.dictate.onDevice"), "info");
  } catch (err) {
    releaseAll();
    throw err;
  }
}

/** How long a suspended audio context gets to resume before dictation reports it. */
const RESUME_TIMEOUT_MS = 3000;

/** The first recording container this browser supports, or "" to let MediaRecorder choose. */
export function pickRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"]) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* why: some engines throw on unknown types */
    }
  }
  return "";
}

/**
 * Memo mode — record audio, Whisper-transcribe, AI-summarize, insert
 * a formatted block. Requires `MediaRecorder` (every modern browser
 * since 2016 has it).
 *
 * `meeting`: plan 6.16 — the transcript becomes meeting notes (decisions,
 * tasks with owner and date, open questions) instead of a short summary.
 */
export async function startVoiceMemo(opts: { language?: string; plain?: boolean; meeting?: boolean } = {}): Promise<void> {
  if (typeof MediaRecorder === "undefined") {
    showAiToast(t("toast.mediarecorderNotSupportedInThis"), "error");
    return;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    log.warn("voice memo: mic denied", err);
    showAiToast(t("toast.microphoneAccessDenied"), "error");
    return;
  }

  // Opus in webm keeps memo bytes small; Safari records mp4. Whisper (and
  // the local decoder) accept whatever the browser can produce, so the
  // first supported container wins and none is forced.
  const mimeType = pickRecordingMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    log.warn("voice memo: MediaRecorder unavailable", err);
    showAiToast(t("toast.recordingIsNotSupportedIn", { error: (err as Error).message }), "error");
    return;
  }
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });

  // Stop overlay UI mounted on document.body.
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const teardown = () => {
    try {
      root.unmount();
    } catch {
      // why: already unmounted by an earlier stop
    }
    host.remove();
    stream.getTracks().forEach((t) => t.stop());
  };

  recorder.addEventListener("stop", async () => {
    teardown();
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: mimeType || recorder.mimeType || "audio/webm" });

    showAiToast(t("toast.transcribing"), "info");
    // Esc / "AI: Cancel" (T55) stops the transcription and the summary; nothing is inserted.
    const op = aiOperation();
    let result;
    let summary = "";
    try {
      try {
        // `plain` is dictation's recorded fallback: its UI promises the audio stays on this device.
        result = await transcribe(blob, { signal: op.signal, language: opts.language, local: opts.plain });
      } catch (err) {
        if (op.signal.aborted || isAbort(err)) return;
        log.error("voice memo transcribe failed", err);
        showAiToast(t("toast.transcribeFailed", { error: (err as Error).message }), "error");
        return;
      }
      if (op.signal.aborted) return;

      if (opts.plain) {
        // Dictation without a live engine for this language: the transcript only, at the cursor.
        const text = result.text.trim();
        if (!text) return;
        const detail = { text };
        if (window.dispatchEvent(new CustomEvent("lumen-dictation-insert", { detail, cancelable: true }))) {
          const current = useAppStore.getState().doc.content;
          useAppStore.getState().setContent(current + (current && !/\s$/.test(current) ? " " : "") + text);
        }
        return;
      }

      showAiToast(t("toast.summarising"), "info");
      if (opts.meeting) {
        try {
          const m = await import("../meetings/meetingNotes");
          const res = await m.meetingNotesFrom(result.text, { signal: op.signal, local: result.backend === "local" });
          const current = useAppStore.getState().doc.content;
          useAppStore.getState().setContent(current + (current.endsWith("\n") ? "" : "\n") + "\n" + res.markdown);
          showAiToast(t("meeting.inserted", { n: res.notes.tasks.length }), "success");
          void m.offerIcs(res);
          return;
        } catch (err) {
          if (op.signal.aborted || isAbort(err)) return;
          log.warn("meeting notes failed; inserting the memo instead", err);
        }
      }
      try {
        summary = await summarizeMemo(result.text, op.signal);
      } catch (err) {
        if (op.signal.aborted || isAbort(err)) return;
        log.warn("voice memo summary failed; inserting transcript only", err);
      }
      // why: chat() resolves an aborted request to "" instead of throwing, so a cancelled summary lands here
      if (op.signal.aborted) return;
    } finally {
      op.end();
    }

    const memo = formatVoiceMemo({
      transcript: result.text,
      summary,
      backend: result.backend,
    });
    const current = useAppStore.getState().doc.content;
    useAppStore
      .getState()
      .setContent(current + (current.endsWith("\n") ? "" : "\n") + "\n" + memo);
    showAiToast(t("toast.voiceMemoInsertedMs", { backend: result.backend, ms: Math.round(result.ms) }),
      "success",
    );
  });

  root.render(
    <div
      role="dialog"
      aria-label={t("voice.recording", { lang: "auto" })}
      style={{
        position: "fixed",
        bottom: 20,
        insetInlineEnd: 20,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "hsl(var(--bg))",
        border: "1px solid hsl(var(--border-strong))",
        borderRadius: 12,
        padding: "10px 16px",
        boxShadow: "0 8px 32px hsl(0 0% 0%/0.3)",
        fontSize: 13,
        color: "hsl(var(--fg))",
      }}
    >
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "#ef4444",
          animation: "pulse 1s infinite",
        }}
      />
      <span>🎙 {opts.plain ? t("dictation.localRecording") : t("voice.memo.recording")}</span>
      <button
        type="button"
        onClick={() => recorder.stop()}
        style={{
          background: "#ef4444",
          color: "white",
          border: "none",
          borderRadius: 6,
          padding: "4px 12px",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {t("voice.memo.stop")}
      </button>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
    </div>,
  );

  recorder.start();
}
