/**
 * Fine-tune Settings panel (F3 / γ.5 UI surface).
 *
 * Drives the `useFineTunedModel` + `fineTunedModelId` flags in
 * `useStore`. Shows:
 *   - Whether a fine-tuned model is persisted
 *   - "Train on my style" CTA → triggers the F3 pipeline
 *   - Live job status with poll + progress
 *   - Toggle to route AI requests through the fine-tuned model
 *   - Clear-data action that deletes the local model id (the
 *     OpenAI side stays — user must delete it from their dashboard
 *     for full removal; this is documented in the dialog)
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Loader2, Sparkles, ShieldOff, Brain } from "lucide-react";
import { useAppStore } from "../store/useStore";
import { showAiToast } from "./AiToast";
import { startFineTune, getFineTuneJob, fineTuneJobActive, type FineTuneJob } from "../ai/fineTune";
import { uiConfirm } from "./PromptDialog";
import { log } from "../lib/logger";
import "./fineTuneStrings";
import { t } from "../i18n";
import "../ai/localLoraStrings";

// The local LoRA route (plan 6.12.4) comes first; its code loads with this dialog's first paint.
const LocalLoraSection = lazy(() => import("./LocalLoraSection").then((m) => ({ default: m.LocalLoraSection })));
import { explainError } from "../lib/userError";
import { HelpButton } from "./HelpButton";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Rendered as a tab of the settings screen: no backdrop. */
  embedded?: boolean;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * The job being trained, kept across closing the dialog (which unmounts
 * it) and reloads: a reopened dialog resumes polling and still saves the
 * resulting model id.
 */
const ACTIVE_JOB_KEY = "lumen.fineTune.activeJob";
// why: "validating_files" (and any status OpenAI adds later) is still a live, billable job
const isActive = (j: FineTuneJob | null) => !!j && fineTuneJobActive(j.status);

function loadActiveJob(): FineTuneJob | null {
  try {
    const j = JSON.parse(localStorage.getItem(ACTIVE_JOB_KEY) ?? "null") as FineTuneJob | null;
    return j && typeof j.id === "string" && isActive(j) ? j : null;
  } catch {
    return null;
  }
}

function saveActiveJob(j: FineTuneJob | null): void {
  try {
    if (isActive(j)) localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({ id: j!.id, status: j!.status, createdAt: j!.createdAt }));
    else localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* why: storage denied: polling lasts while the dialog is open */
  }
}

export function FineTuneSettings({ open, onClose, embedded = false }: Props) {
  const useFineTunedModel = useAppStore((s) => s.useFineTunedModel);
  const fineTunedModelId = useAppStore((s) => s.fineTunedModelId);
  const toggleFineTunedModel = useAppStore((s) => s.toggleFineTunedModel);
  const setFineTunedModelId = useAppStore((s) => s.setFineTunedModelId);
  const aiKey = useAppStore((s) => s.aiKey);

  const [job, setJobState] = useState<FineTuneJob | null>(loadActiveJob);
  const setJob = useCallback((j: FineTuneJob | null) => {
    saveActiveJob(j);
    setJobState(j);
  }, []);
  const [running, setRunning] = useState(false);
  const [chunks, setChunks] = useState(0);
  const [tokens, setTokens] = useState(0);
  const pollTimer = useRef<number | null>(null);

  // Poll the job until it finishes (succeeded / failed / cancelled).
  const pollJob = useCallback(
    async (jobId: string) => {
      try {
        const next = await getFineTuneJob(jobId);
        setJob(next);
        if (next.status === "succeeded" && next.fineTunedModel) {
          setFineTunedModelId(next.fineTunedModel);
          showAiToast(
            t("fineTune.toast.succeeded", { model: next.fineTunedModel }),
            "success",
          );
          if (pollTimer.current != null) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        } else if (next.status === "failed" || next.status === "cancelled") {
          showAiToast(
            t("fineTune.toast.failed", { status: next.status }),
            "error",
          );
          if (pollTimer.current != null) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        }
      } catch (e) {
        log.warn("fine-tune poll failed", e);
      }
    },
    [setFineTunedModelId, setJob],
  );

  // A job resumed from storage: check it right away, then on the interval.
  const resumed = useRef(job?.id ?? null);
  useEffect(() => {
    if (resumed.current) void pollJob(resumed.current);
    resumed.current = null;
  }, [pollJob]);

  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return;
    }
    pollTimer.current = window.setInterval(() => {
      void pollJob(job.id);
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current != null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [job, pollJob]);

  const handleTrain = useCallback(async () => {
    if (!aiKey) {
      showAiToast(t("fineTune.needKey"), "error");
      return;
    }
    const ok = await uiConfirm({
      message: t("fineTune.confirm"),
    });
    if (!ok) return;
    setRunning(true);
    try {
      const res = await startFineTune();
      setChunks(res.chunks);
      setTokens(res.estimatedTokens);
      setJob(res);
      showAiToast(
        t("fineTune.toast.queued", { chunks: String(res.chunks), tokens: String(res.estimatedTokens) }),
        "info",
      );
    } catch (e) {
      log.error("fine-tune start failed", e);
      showAiToast(t("fineTune.toast.error", { error: explainError(e) }), "error");
    } finally {
      setRunning(false);
    }
  }, [aiKey, setJob]);

  const handleForget = useCallback(async () => {
    const ok = await uiConfirm({ message: t("fineTune.forgetConfirm") });
    if (!ok) return;
    setFineTunedModelId(null);
    if (useFineTunedModel) toggleFineTunedModel();
    showAiToast(t("fineTune.toast.forgot"), "info");
  }, [setFineTunedModelId, toggleFineTunedModel, useFineTunedModel]);

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open && !embedded, onEscape: onClose });

  if (!open) return null;

  return (
    <div
      className={embedded ? undefined : "cmd-palette-backdrop"}
      onClick={embedded ? undefined : onClose}
      ref={trapRef}
      role={embedded ? "region" : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-label={t("fineTune.title")}
    >
      <div
        className={embedded ? undefined : "cmd-palette"}
        onClick={(e) => e.stopPropagation()}
        style={embedded ? { display: "flex", flexDirection: "column" } : { maxWidth: 560, padding: 0, display: "flex", flexDirection: "column", maxHeight: "88vh" }}
      >
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Brain size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("fineTune.title")}</h2>
          <HelpButton topic="ai/local-llm" />
        </header>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16, fontSize: 13, lineHeight: 1.5, overflowY: "auto" }}>
          <Suspense fallback={null}>
            <LocalLoraSection />
          </Suspense>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--fg-muted))" }}>{t("fineTune.cloudRoute")}</div>
          <p style={{ margin: 0, color: "hsl(var(--fg-muted))" }}>{t("fineTune.intro")}</p>

          {/* Current state */}
          <section
            style={{
              padding: "12px 14px",
              borderRadius: 8,
              background: "hsl(var(--bg-subtle))",
              border: "1px solid hsl(var(--border))",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--fg-muted))", marginBottom: 6 }}>
              {t("fineTune.status")}
            </div>
            {fineTunedModelId ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>✅</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{t("fineTune.modelReady")}</div>
                  <code
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "hsl(var(--fg-muted))",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fineTunedModelId}
                  </code>
                </div>
              </div>
            ) : job ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                <div>
                  <div style={{ fontWeight: 600 }}>{t("fineTune.training", { status: job.status })}</div>
                  {chunks > 0 && (
                    <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>
                      {t("fineTune.statsLine", { chunks: String(chunks), tokens: String(tokens) })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ color: "hsl(var(--fg-muted))" }}>{t("fineTune.notTrained")}</div>
            )}
          </section>

          {/* Toggle */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: fineTunedModelId ? "pointer" : "not-allowed",
              opacity: fineTunedModelId ? 1 : 0.5,
            }}
          >
            <input
              type="checkbox"
              checked={useFineTunedModel}
              disabled={!fineTunedModelId}
              onChange={() => toggleFineTunedModel()}
            />
            <span>
              <strong>{t("fineTune.useToggle")}</strong>
              <br />
              <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>
                {t("fineTune.useToggleHint")}
              </span>
            </span>
          </label>

          {/* Actions */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleTrain}
              disabled={running || (job !== null && job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 6,
                border: "1px solid hsl(var(--accent))",
                background: "hsl(var(--accent) / 0.10)",
                color: "hsl(var(--accent))",
                cursor: running ? "wait" : "pointer",
              }}
            >
              {running ? (
                <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
              ) : (
                <Sparkles size={12} />
              )}
              {fineTunedModelId ? t("fineTune.retrain") : t("fineTune.train")}
            </button>
            {fineTunedModelId && (
              <button
                type="button"
                onClick={handleForget}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid hsl(var(--danger) / 0.5)",
                  background: "transparent",
                  color: "hsl(var(--danger))",
                  cursor: "pointer",
                }}
              >
                <ShieldOff size={12} />
                {t("fineTune.forget")}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                borderRadius: 6,
                border: "1px solid hsl(var(--border))",
                background: "transparent",
                color: "hsl(var(--fg))",
                cursor: "pointer",
              }}
            >
              {t("fineTune.close")}
            </button>
          </div>

          {/* Privacy note */}
          <p style={{ margin: 0, fontSize: 11, color: "hsl(var(--fg-muted))", lineHeight: 1.6 }}>
            {t("fineTune.privacy")}
          </p>
        </div>
      </div>
    </div>
  );
}
