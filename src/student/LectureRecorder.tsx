/**
 * The lecture recorder (plan W5.13): record, tap "Important!" (or press
 * the space bar / !) at the moments that matter, stop, and the lecture note
 * is written — on this device. Lazy-loaded from the command palette.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./strings";
import { t } from "../i18n";
import { clock } from "./lectureCore";
import { HelpButton } from "../ui/HelpButton";
import { explainError } from "../lib/userError";

type Phase = "idle" | "recording" | "processing" | "done" | "error";

export interface RecorderDeps {
  start: () => Promise<{ stop(): Promise<{ audio: Blob; durationMs: number }>; cancel(): void }>;
  process: (audio: Blob, o: { durationMs: number; markers: number[]; title: string }) => Promise<{ path: string; cards: number; important: number }>;
  open: (path: string) => void;
  now: () => number;
}

async function defaultDeps(): Promise<RecorderDeps> {
  const [{ startRecording }, { processLecture }] = await Promise.all([import("../capture/voiceCapture"), import("./lecture")]);
  return {
    start: () => startRecording(),
    process: (audio, o) => processLecture(audio, o),
    open: (path) => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } })),
    now: () => performance.now(),
  };
}

export function LectureRecorder({ onClose, deps }: { onClose: () => void; deps?: RecorderDeps }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [title, setTitle] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [markers, setMarkers] = useState<number[]>([]);
  const [message, setMessage] = useState("");
  const rec = useRef<{ stop(): Promise<{ audio: Blob; durationMs: number }>; cancel(): void } | null>(null);
  const started = useRef(0);
  const d = useRef<RecorderDeps | null>(deps ?? null);

  const now = () => d.current!.now();
  const mark = () => {
    if (rec.current) setMarkers((m) => [...m, Math.round((now() - started.current) / 100) / 10]);
  };

  useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => setElapsed((now() - started.current) / 1000), 500);
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === " " || e.key === "!") && (e.target as HTMLElement)?.tagName !== "INPUT") {
        e.preventDefault();
        mark();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [phase]);

  useEffect(() => () => rec.current?.cancel(), []);

  async function start() {
    try {
      d.current ??= await defaultDeps();
      rec.current = await d.current.start();
      started.current = now();
      setMarkers([]);
      setPhase("recording");
    } catch (e) {
      setPhase("error");
      setMessage(t("student.micFailed", { error: explainError(e) }));
    }
  }

  async function stop() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setPhase("processing");
    try {
      const { audio, durationMs } = await r.stop();
      const res = await d.current!.process(audio, { durationMs, markers, title: title.trim() || t("student.untitled") });
      setPhase("done");
      setMessage(t("student.done", { cards: res.cards, important: res.important }));
      d.current!.open(res.path);
    } catch (e) {
      setPhase("error");
      setMessage(t("student.failed", { error: explainError(e) }));
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="lecture-title" data-testid="lecture-recorder" style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, padding: 20, width: "min(440px, 100%)", display: "grid", gap: 12 }}>
        <h2 id="lecture-title" style={{ margin: 0, fontSize: 17 }}>{t("student.title")}</h2>
        <HelpButton topic="workspace/student-mode#the-lecture-note" />
        <p style={{ margin: 0, fontSize: 12.5, color: "hsl(var(--fg-muted))" }}>{t("student.about")}</p>
        <label style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
          {t("student.name")}
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={phase === "processing"} dir="auto" />
        </label>
        {phase === "recording" && (
          <div style={{ display: "grid", gap: 8, justifyItems: "center" }}>
            <div aria-live="polite" data-testid="lecture-clock" style={{ fontVariantNumeric: "tabular-nums", fontSize: 22 }}>
              {clock(elapsed)}
            </div>
            <button type="button" className="btn btn-primary" data-testid="lecture-mark" onClick={mark} style={{ fontSize: 16, padding: "10px 18px" }}>
              ⭐ {t("student.mark")}
            </button>
            <span data-testid="lecture-marks" style={{ fontSize: 12 }}>{t("student.marks", { n: markers.length })}</span>
          </div>
        )}
        {phase === "processing" && <p role="status">{t("student.processing")}</p>}
        {message && (
          <p role={phase === "error" ? "alert" : "status"} data-testid="lecture-message" style={{ margin: 0 }}>
            {message}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {phase === "idle" || phase === "error" || phase === "done" ? (
            <button type="button" className="btn btn-primary" data-testid="lecture-start" onClick={() => void start()}>
              {t("student.start")}
            </button>
          ) : phase === "recording" ? (
            <button type="button" className="btn" data-testid="lecture-stop" onClick={() => void stop()}>
              {t("student.stop")}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose} disabled={phase === "processing"}>
            {t("student.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function openLectureRecorder(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    <LectureRecorder
      onClose={() => {
        root.unmount();
        host.remove();
      }}
    />,
  );
}
