/**
 * Send feedback without a server (plan 14.2): a form that becomes a GitHub
 * issue the user opens, or text the user copies. See ../feedback/feedback.ts.
 *
 * Nothing leaves the device while the form is open. The preview shows the
 * exact text; it goes out only through the user's click on "Open on GitHub"
 * (a new github.com tab with the issue form filled in) or "Copy text". The
 * AI doctor's report and the app details are included only when ticked; a
 * screenshot is saved to disk for the user to attach by hand.
 *
 * Loaded on demand (the palette's "Help: Send feedback", the AI doctor's
 * "Report a problem"), so neither it nor its strings are in the startup
 * bundle: open it with `void import("./FeedbackDialog").then((m) => m.openFeedback())`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageSquareWarning, X } from "lucide-react";
import { t } from "../i18n";
import "../feedback/strings";
import {
  FEEDBACK_KINDS,
  collectEnvironment,
  feedbackBody,
  feedbackText,
  feedbackTitle,
  issueLink,
  screenshotFileName,
  type FeedbackInput,
  type FeedbackKind,
} from "../feedback/feedback";
import { getAiPolicy } from "../ai/policy";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";

export interface FeedbackOptions {
  /** The AI doctor's report, when opened from the doctor (still included only if ticked). */
  doctorReport?: string;
  kind?: FeedbackKind;
}

const box: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const field: React.CSSProperties = { padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const pre: React.CSSProperties = { margin: 0, padding: "8px 10px", fontSize: 11, borderRadius: 6, background: "hsl(var(--bg-subtle))", border: "1px solid hsl(var(--border))", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", textAlign: "start" };

/** Grab one frame of a screen, window or tab the user picks in the browser's own prompt. */
async function captureScreen(): Promise<Blob> {
  const media = navigator.mediaDevices;
  if (!media?.getDisplayMedia) throw new Error(t("feedback.screenshot.unsupported"));
  const stream = await media.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise<void>((resolve) => video.addEventListener("loadeddata", () => resolve(), { once: true }));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    video.pause();
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"));
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/** Save a blob to the user's disk (the browser's download), never upload it. */
function saveToDisk(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function FeedbackDialog({ options, onClose }: { options: FeedbackOptions; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>(options.kind ?? "bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [withEnv, setWithEnv] = useState(true);
  const [withDoctor, setWithDoctor] = useState(false);
  const [doctorReport, setDoctorReport] = useState<string | null>(options.doctorReport ?? null);
  const [doctorState, setDoctorState] = useState<{ running: boolean; error: string | null }>({ running: false, error: null });
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The doctor runs only after the user ticks the box (its probes stay on this device).
  useEffect(() => {
    if (!withDoctor || doctorReport !== null) return;
    let cancelled = false;
    const ac = new AbortController();
    setDoctorState({ running: true, error: null });
    void (async () => {
      try {
        await import("../agents/doctorStrings");
        const { runDoctor, formatDoctorReport } = await import("../agents/doctor");
        const report = await runDoctor({ signal: ac.signal });
        if (!cancelled) {
          setDoctorReport(formatDoctorReport(report, (k) => t(k)));
          setDoctorState({ running: false, error: null });
        }
      } catch (e) {
        if (!cancelled) setDoctorState({ running: false, error: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [withDoctor, doctorReport]);

  const environment = useMemo(() => (withEnv ? collectEnvironment(getAiPolicy()) : null), [withEnv]);
  const input: FeedbackInput = {
    kind,
    title,
    description,
    environment,
    doctorReport: withDoctor ? doctorReport : null,
    screenshot: !!screenshot,
  };
  const preview = `${feedbackTitle(input)}\n\n${feedbackBody(input)}`;
  const ready = title.trim().length > 0 && !(withDoctor && doctorState.running);

  const copyText = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(feedbackText(input));
      return true;
    } catch {
      // why: clipboard denied — the preview is selectable, and the notice says to copy it by hand
      setNotice(t("feedback.copyFailed"));
      return false;
    }
  };

  const openGithub = async () => {
    if (!ready) return setNotice(t("feedback.needTitle"));
    const link = issueLink(input);
    // Too long for a URL: open with the title, and put the body on the clipboard to paste.
    if (!link.withBody && (await copyText())) setNotice(t("feedback.tooLong"));
    window.open(link.url, "_blank", "noopener,noreferrer");
    if (link.withBody) setNotice(t("feedback.opened"));
  };

  const copy = async () => {
    if (await copyText()) setNotice(t("feedback.copied"));
  };

  const takeScreenshot = async () => {
    try {
      const blob = await captureScreen();
      const name = screenshotFileName();
      saveToDisk(blob, name);
      setScreenshot(name);
      setNotice(t("feedback.screenshot.saved", { name }));
    } catch (e) {
      setNotice(t("feedback.screenshot.failed", { error: explainError(e) }));
    }
  };

  return (
    // Closes with Escape or the × button; the backdrop has no click handler, so a
    // stray click outside never throws away what the user wrote.
    <div className="cmd-palette-backdrop">
      <div className="cmd-palette" role="dialog" aria-modal="true" aria-label={t("feedback.title")} data-testid="feedback-dialog" style={{ maxWidth: 600, padding: 0, display: "flex", flexDirection: "column", maxHeight: "88vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <MessageSquareWarning size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("feedback.title")}</h2>
          <HelpButton topic="getting-started/feedback" />
          <button type="button" style={ghost} onClick={onClose} aria-label={t("feedback.close")}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, fontSize: 13, overflowY: "auto" }}>
          <p style={{ ...muted, margin: 0 }}>{t("feedback.intro")}</p>

          <label style={box}>
            <span>{t("feedback.kind")}</span>
            <select style={field} value={kind} onChange={(e) => setKind(e.target.value as FeedbackKind)} data-testid="feedback-kind">
              {FEEDBACK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`feedback.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label style={box}>
            <span>{t("feedback.subject")}</span>
            <input ref={titleRef} dir="auto" style={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("feedback.subject.placeholder")} data-testid="feedback-title" />
          </label>
          <label style={box}>
            <span>{t("feedback.description")}</span>
            <textarea dir="auto" rows={5} style={{ ...field, resize: "vertical" }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("feedback.description.placeholder")} data-testid="feedback-description" />
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={withEnv} onChange={(e) => setWithEnv(e.target.checked)} data-testid="feedback-env" />
            <span>{t("feedback.includeEnvironment")}</span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={withDoctor} onChange={(e) => setWithDoctor(e.target.checked)} data-testid="feedback-doctor" />
            <span>
              {t("feedback.includeDoctor")}
              {withDoctor && doctorState.running && <span style={{ ...muted, display: "block" }} aria-live="polite">{t("feedback.doctorRunning")}</span>}
              {withDoctor && doctorState.error && <span style={{ ...muted, display: "block" }} role="alert">{t("feedback.doctorFailed", { error: doctorState.error })}</span>}
            </span>
          </label>
          <div style={box}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" style={ghost} onClick={() => void takeScreenshot()} data-testid="feedback-screenshot">
                {t("feedback.screenshot")}
              </button>
              {screenshot && <span style={muted}>{screenshot}</span>}
              {/* W3.7: a diagnostics file to attach (no note text, no keys). */}
              <button type="button" style={ghost} onClick={() => void import("./diagnosticsActions").then((m) => m.saveDiagnostics())} data-testid="feedback-diagnostics">
                {t("errorScreen.diagnostics")}
              </button>
            </div>
            <span style={muted}>{t("feedback.screenshot.hint")}</span>
          </div>

          <div style={box}>
            <span style={{ fontWeight: 600 }}>{t("feedback.preview")}</span>
            <pre dir="auto" style={pre} data-testid="feedback-preview">
              {preview}
            </pre>
          </div>

          {notice && (
            <div style={muted} role="status" data-testid="feedback-notice">
              {notice}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" style={ghost} onClick={() => void copy()} data-testid="feedback-copy">
              {t("feedback.copy")}
            </button>
            <button type="button" style={primary} onClick={() => void openGithub()} disabled={!ready} title={t("feedback.openGithub.hint")} data-testid="feedback-open-github">
              {t("feedback.openGithub")}
            </button>
          </div>
          <span style={{ ...muted, textAlign: "end" }}>{t("feedback.openGithub.hint")}</span>
        </div>
      </div>
    </div>
  );
}

let openHost: { close: () => void } | null = null;

/** Open the feedback dialog (one at a time). */
export function openFeedback(options: FeedbackOptions = {}): void {
  openHost?.close();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    if (openHost?.close === close) openHost = null;
    try {
      root.unmount();
    } catch {
      /* why: already unmounted by an earlier close */
    }
    host.remove();
  };
  openHost = { close };
  root.render(<FeedbackDialog options={options} onClose={close} />);
}
