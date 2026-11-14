/**
 * Live dictation panel (plan 6.1) — lazy-loaded by the dictation command.
 *
 * Hebrew streams on this device (Zipformer2 + Silero VAD in a worker):
 * interim text while the user speaks, punctuated text inserted at the
 * cursor at each pause. The first use asks before downloading (size shown);
 * the browser's own speech service is offered instead only when the AI
 * policy allows the cloud — never under local-only (1.3).
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n";
import { showAiToast } from "./AiToast";
import { useAppStore } from "../store/useStore";
import { getAiPolicy } from "../ai/policy";
import { detectHardware, vramBudgetMB } from "../ai/modelManager";
import { baseLanguage, chooseCorrection, chooseEngine, type EngineId } from "../ai/dictation/engines";
import { downloadedCorrectionModels, makeCorrector, type SegmentCorrector } from "../ai/dictation/correction";

type CorrectionEngine = ReturnType<typeof chooseCorrection>;
import { dictationDownloadBytes, formatMB } from "../ai/dictation/models";
import { isDictationModelDownloaded, loadDictationFiles } from "../ai/dictation/modelStore";
import { createDictationAudioContext, startDictationSession, type DictationSession } from "../ai/dictation/session";
import { appendSegment } from "../ai/dictation/punctuate";
import { log } from "../lib/logger";
import "./liveDictationStrings";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";

/** Plan W6.19: this device is over 15 % WER and the user's linked desktop can re-read each sentence. */
interface DesktopOffer {
  /** This device's WER, as a whole percentage, for the offer's text. */
  werPercent: number;
  correct: SegmentCorrector;
}

/**
 * Whether to offer "send to my desktop": Hebrew, a desktop linked over the
 * LAN sync and ready, and this device's WER over the target (measured, or
 * from what it runs). Lazy: the LAN and offload code load only for Hebrew.
 */
async function desktopOffer(lang: string, correction: CorrectionEngine): Promise<DesktopOffer | null> {
  if (baseLanguage(lang) !== "he") return null;
  try {
    const [{ serviceLinks }, off] = await Promise.all([import("../sync/e2ee/lan"), import("../ai/dictation/desktopOffload")]);
    // The host this device joined, or a device that joined the vault this one hosts (a phone can host).
    const links = serviceLinks();
    if (!links.length) return null;
    const estimate = off.estimateDictationWer({ correction });
    const chosen = await off.chooseDesktopLink(links, { language: lang, estimate });
    if (!chosen || estimate.wer === null) return null;
    const { link } = chosen;
    let warned = false;
    const correct = off.makeDesktopCorrector(link, {
      onMiss: () => {
        if (warned) return;
        warned = true;
        showAiToast(t("dictation.desktop.missed"), "info");
      },
    });
    return { werPercent: Math.round(estimate.wer * 100), correct };
  } catch (e) {
    log.info(`dictation: no desktop offer (${(e as Error).name})`);
    return null;
  }
}

type Phase = { kind: "ask"; browserAllowed: boolean } | { kind: "downloading"; percent: number } | { kind: "loading" } | { kind: "listening"; speaking: boolean; interim: string };

/** Insert at the editor's cursor; without an editor, append to the note. Returns what to remove on "delete that". */
function insertText(text: string): string {
  const detail: { text: string; inserted?: string } = { text };
  const handled = !window.dispatchEvent(new CustomEvent("lumen-dictation-insert", { detail, cancelable: true }));
  if (handled) return detail.inserted ?? text;
  const store = useAppStore.getState();
  const next = appendSegment(store.doc.content, text);
  store.setContent(next);
  return next.slice(store.doc.content.length);
}

function removeText(text: string): void {
  const handled = !window.dispatchEvent(new CustomEvent("lumen-dictation-undo", { detail: { text }, cancelable: true }));
  if (handled) return;
  const store = useAppStore.getState();
  if (store.doc.content.endsWith(text)) store.setContent(store.doc.content.slice(0, -text.length));
}

function Panel({ initial, onBrowser, onClose, correction = null, desktop = null }: { initial: Phase; onBrowser: () => void; onClose: () => void; correction?: CorrectionEngine; desktop?: DesktopOffer | null }) {
  const [phase, setPhase] = useState<Phase>(initial);
  const [viaDesktop, setViaDesktop] = useState(false);
  const viaDesktopRef = useRef(false);
  const session = useRef<DictationSession | null>(null);
  const abort = useRef<AbortController | null>(null);
  const inserted = useRef<string[]>([]);
  const size = formatMB(dictationDownloadBytes());

  const stop = async () => {
    abort.current?.abort();
    const s = session.current;
    session.current = null;
    if (s) await s.stop();
    onClose();
  };

  const start = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    // Made in the click, before any await: a context created after the
    // download may be left suspended by autoplay policy (no audio, ever).
    const audioContext = createDictationAudioContext();
    try {
      setPhase({ kind: "downloading", percent: 0 });
      const files = await loadDictationFiles((loaded, total) => setPhase({ kind: "downloading", percent: Math.floor((loaded / total) * 100) }), ctl.signal);
      if (ctl.signal.aborted) {
        void audioContext?.close().catch(() => undefined);
        return;
      }
      setPhase({ kind: "loading" });
      const started = await startDictationSession(files, {
        onReady: (info) => {
          log.info(`dictation ready: vad=${info.vad} load=${info.loadMs}ms`);
          setPhase({ kind: "listening", speaking: false, interim: "" });
        },
        onSpeaking: (speaking) => setPhase((p) => (p.kind === "listening" ? { ...p, speaking } : p)),
        onInterim: (interim) => setPhase((p) => (p.kind === "listening" ? { ...p, interim } : p)),
        onFinal: (text, actions) => {
          if (text) inserted.current.push(insertText(text));
          for (const a of actions) {
            if (a.type === "delete-last") {
              const last = inserted.current.pop();
              if (last) removeText(last);
            } else if (a.type === "stop") void stop();
          }
          setPhase((p) => (p.kind === "listening" ? { ...p, interim: "" } : p));
        },
        onError: (message) => {
          showAiToast(t("dictation.error", { error: message }), "error");
          void stop();
        },
      }, {
        signal: ctl.signal,
        audioContext,
        // Plan W4.13: each sentence re-read by a Whisper already on this device;
        // plan W6.19: or by the user's desktop, once they press "send to my desktop".
        correct: sentenceCorrector(
          correction ? makeCorrector(correction, async (audio, o) => (await import("../ai/transformersEngine")).transcribeAudio(audio, o)) : undefined,
          desktop,
          () => viaDesktopRef.current,
        ),
      });
      // Cancelled or closed while the model loaded: never leave a hidden session holding the microphone.
      if (ctl.signal.aborted) {
        await started.stop();
        return;
      }
      session.current = started;
      setPhase((p) => (p.kind === "loading" ? { kind: "listening", speaking: false, interim: "" } : p));
    } catch (e) {
      // A load that failed before the session took the context: close it here.
      void audioContext?.close().catch(() => undefined);
      if ((e as Error).name !== "AbortError" && !ctl.signal.aborted) showAiToast(t("dictation.error", { error: explainError(e) }), "error");
      await stop();
    }
  };

  useEffect(() => {
    if (initial.kind !== "ask") void start();
    return () => {
      abort.current?.abort();
      void session.current?.stop();
    };
  }, []);

  const button = (label: string, onClick: () => void, primary = false) => (
    <button type="button" onClick={onClick} style={{ background: primary ? "hsl(var(--primary))" : "transparent", color: primary ? "hsl(var(--primary-foreground))" : "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>
      {label}
    </button>
  );

  return (
    <div role="dialog" aria-live="polite" aria-label={t("dictation.download.title")} dir="auto" style={{ position: "fixed", bottom: 20, insetInlineEnd: 20, zIndex: 9999, maxWidth: 420, display: "flex", flexDirection: "column", gap: 8, background: "hsl(var(--bg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, padding: "12px 16px", boxShadow: "var(--shadow-md)", fontSize: 13, color: "hsl(var(--fg))" }}>
      {phase.kind === "ask" && (
        <>
          <strong>{t("dictation.download.title")}</strong>
          <HelpButton topic="ai/hebrew-dictation" />
          <span>{t("dictation.download.body", { size })}</span>
          <span style={{ opacity: 0.7, fontSize: 11 }}>{t("dictation.download.credits")}</span>
          {!phase.browserAllowed && <span style={{ opacity: 0.7, fontSize: 11 }}>{t("dictation.localOnlyNoBrowser")}</span>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {button(t("dictation.download.start", { size }), () => void start(), true)}
            {button(t("dictation.download.cancel"), onClose)}
            {phase.browserAllowed && button(t("dictation.download.browser"), onBrowser)}
          </div>
        </>
      )}
      {phase.kind === "downloading" && (
        <>
          <span>{t("dictation.downloading", { percent: phase.percent })}</span>
          <progress max={100} value={phase.percent} style={{ width: "100%" }} />
          <div>{button(t("dictation.download.cancel"), () => void stop())}</div>
        </>
      )}
      {phase.kind === "loading" && (
        <>
          <span>{t("dictation.loading")}</span>
          <div>{button(t("dictation.download.cancel"), () => void stop())}</div>
        </>
      )}
      {phase.kind === "listening" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: phase.speaking ? "hsl(var(--danger))" : "hsl(var(--fg-muted))", animation: phase.speaking ? "pulse 1s infinite" : undefined }} />
            <span>{phase.speaking ? t("dictation.speaking") : t("dictation.listening")}</span>
            <span style={{ flex: 1 }} />
            {button(t("dictation.stop"), () => void stop(), true)}
          </div>
          {phase.interim && <span style={{ opacity: 0.6, fontStyle: "italic" }}>{phase.interim}</span>}
          {desktop && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <button
                type="button"
                aria-pressed={viaDesktop}
                onClick={() => {
                  viaDesktopRef.current = !viaDesktopRef.current;
                  setViaDesktop(viaDesktopRef.current);
                }}
                style={{ alignSelf: "flex-start", background: viaDesktop ? "hsl(var(--primary))" : "transparent", color: viaDesktop ? "hsl(var(--primary-foreground))" : "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12 }}
              >
                {t("dictation.desktop.send")}
              </button>
              <span style={{ opacity: 0.7, fontSize: 11 }}>{viaDesktop ? t("dictation.desktop.sending") : t("dictation.desktop.why", { wer: desktop.werPercent })}</span>
            </div>
          )}
          <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
        </>
      )}
    </div>
  );
}

/** The session's corrector: the desktop's while the user has it on, else this device's (or none). */
function sentenceCorrector(local: SegmentCorrector | undefined, desktop: DesktopOffer | null, useDesktop: () => boolean): SegmentCorrector | undefined {
  if (!desktop) return local;
  return (audio, text) => (useDesktop() ? desktop.correct(audio, text) : local ? local(audio, text) : Promise.resolve(text));
}

let open: (() => void) | null = null;

export interface DictationFallbacks {
  /** The browser's speech service (only reached when the policy allows the cloud). */
  browser: () => void;
  /** Record, then transcribe with Whisper on this device. */
  record: () => void;
}

/** Start dictation in `lang` with the engine chooseEngine picks (plan 6.1). */
export async function openLiveDictation(lang: string, fallbacks: DictationFallbacks): Promise<void> {
  if (open) return; // already running
  const fallbackToBrowser = fallbacks.browser;
  const hw = await detectHardware();
  const downloaded = new Set<EngineId>((await isDictationModelDownloaded()) ? ["zipformer-he"] : []);
  const choice = chooseEngine({
    language: lang,
    policy: getAiPolicy(),
    mode: "live",
    webgpu: hw.webgpu,
    f16: hw.f16,
    vramMB: vramBudgetMB(hw),
    webSpeech: typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window),
    downloaded,
  });
  if (choice.candidates[0] === "web-speech") return fallbackToBrowser();
  if (choice.candidates[0] !== "zipformer-he") return fallbacks.record();
  const correction = chooseCorrection({ language: lang, webgpu: hw.webgpu, f16: hw.f16, vramMB: vramBudgetMB(hw), downloaded: await downloadedCorrectionModels() });
  const desktop = await desktopOffer(lang, correction);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    open = null;
    try {
      root.unmount();
    } catch {
      /* why: the root may already be unmounted by an earlier close */
    }
    host.remove();
  };
  open = close;
  const initial: Phase = choice.needsDownload ? { kind: "ask", browserAllowed: choice.candidates.includes("web-speech") } : { kind: "loading" };
  root.render(
    <Panel
      initial={initial}
      correction={correction}
      desktop={desktop}
      onClose={close}
      onBrowser={() => {
        close();
        fallbackToBrowser();
      }}
    />,
  );
}
