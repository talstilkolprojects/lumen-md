/**
 * Batch jobs panel (plan 5.8): live progress and an ETA for every batch
 * job, with Pause / Resume / Cancel. Lazy — mounted on demand by
 * "AI: Batch Jobs" and after a submit, never part of the startup bundle.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Layers, X } from "lucide-react";
import { t } from "../i18n";
import { batchProgress, cancelBatch, loadJobs, pauseBatch, resumeBatch, subscribeBatch, type BatchJob, type BatchProgress } from "../ai/batch";
import { uiConfirm } from "./PromptDialog";
import { showAiToast } from "./AiToast";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";
import { EmptyState, runCommand } from "./EmptyState";

const btn: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };

/** "about 3 min" / "about 40 s", in the UI language. */
export function formatEta(ms: number, locale?: string): string {
  const s = Math.max(1, Math.round(ms / 1000));
  let fmt: Intl.RelativeTimeFormat | null = null;
  try {
    fmt = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  } catch {
    /* why: old engine */
  }
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = s < 90 ? [s, "second"] : s < 5400 ? [Math.round(s / 60), "minute"] : [Math.round(s / 3600), "hour"];
  if (!fmt) return `${value} ${unit}${value === 1 ? "" : "s"}`;
  // "in 3 min" → keep only the amount: the sentence around it says "left".
  const parts = fmt.formatToParts(value, unit);
  const i = parts.findIndex((p) => p.type === "integer");
  return parts.slice(Math.max(0, i)).map((p) => p.value).join("").trim();
}

interface Row {
  job: BatchJob;
  progress: BatchProgress;
}

const active = (j: BatchJob) => j.status === "submitted" || j.status === "ended";

async function rows(): Promise<Row[]> {
  const jobs = loadJobs().filter(active);
  return Promise.all(jobs.map(async (job) => ({ job, progress: await batchProgress(job) })));
}

function JobRow({ job, progress: p, busy, act }: Row & { busy: boolean; act: (fn: () => Promise<void>) => void }) {
  const handled = p.done + p.failed;
  const local = job.provider === "local";
  const rejected = Object.entries(p.rejected);
  const status = p.cancelled ? t("batch.state.cancelled") : p.finished ? t("batch.panel.finished") : p.paused ? t("batch.panel.paused") : p.blocked ? t("batch.panel.blocked") : !local ? t("batch.panel.cloud", { provider: job.provider }) : p.etaMs !== null ? t("batch.panel.eta", { time: formatEta(p.etaMs, document.documentElement.lang || undefined) }) : "";
  return (
    <li data-testid="batch-job" data-job={job.id} data-paused={p.paused ? "1" : "0"} data-finished={p.finished ? "1" : "0"} style={{ padding: "10px 16px", borderBottom: "1px solid hsl(var(--border))", listStyle: "none" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ flex: 1, minWidth: 0 }}>{t(`batch.op.${job.op}`)}</strong>
        <span style={{ fontSize: 11.5, color: "hsl(var(--fg-muted))" }}>{job.model}</span>
      </div>
      {local && (
        <progress max={p.total} value={handled} aria-label={t("batch.panel.progress", { done: p.done, total: p.total, failed: p.failed })} style={{ width: "100%", marginTop: 6 }} />
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, marginTop: 4 }}>
        {local && <span data-testid="batch-count">{t("batch.panel.progress", { done: p.done, total: p.total, failed: p.failed })}</span>}
        <span data-testid="batch-status" style={{ flex: 1, color: "hsl(var(--fg-muted))" }}>
          {status}
        </span>
        {local && !p.finished && !p.cancelled && (p.paused || p.blocked ? (
          <button type="button" style={btn} disabled={busy} onClick={() => act(() => resumeBatch(job))}>
            {t("batch.panel.resume")}
          </button>
        ) : (
          <button type="button" style={btn} disabled={busy} onClick={() => act(() => pauseBatch(job.id))}>
            {t("batch.panel.pause")}
          </button>
        ))}
        {!p.finished && !p.cancelled && (
          <button
            type="button"
            style={btn}
            disabled={busy}
            onClick={() =>
              act(async () => {
                if (await uiConfirm({ message: t("batch.panel.confirmCancel") })) await cancelBatch(job);
              })
            }
          >
            {t("batch.panel.cancel")}
          </button>
        )}
        {p.finished && (
          <button type="button" style={btn} onClick={() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "ai.batchCheck" } }))}>
            {t("batch.panel.apply")}
          </button>
        )}
      </div>
      {rejected.length > 0 && (
        <details style={{ fontSize: 12, marginTop: 4 }}>
          <summary>{t("batch.panel.rejected", { n: rejected.length })}</summary>
          <ul style={{ margin: "4px 0", paddingInlineStart: 18 }}>
            {rejected.map(([id, why]) => (
              <li key={id}>
                <bdi>{job.items.find((i) => i.customId === id)?.path ?? id}</bdi>: {why}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function BatchPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void rows().then(setList);
  }, []);

  useEffect(() => {
    refresh();
    const off = subscribeBatch(refresh);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, onClose]);

  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch((e: unknown) => showAiToast(explainError(e), "error"))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("batch.panel.title")}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620, padding: 0, display: "flex", flexDirection: "column", maxHeight: "82vh" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Layers size={16} />
          <strong style={{ flex: 1 }}>{t("batch.panel.title")}</strong>
          <HelpButton topic="ai/batch#the-batch-jobs-panel" />
          <button type="button" style={btn} onClick={onClose} aria-label={t("batch.panel.close")}>
            <X size={14} />
          </button>
        </header>
        <div style={{ overflow: "auto", flex: 1 }}>
          {list === null ? null : list.length === 0 ? (
            <EmptyState message={t("batch.none")} action={{ label: t("cmd.ai.batch"), onClick: () => (onClose(), runCommand("ai.batch")) }} />
          ) : (
            <ul style={{ margin: 0, padding: 0 }}>
              {list.map((r) => (
                <JobRow key={r.job.id} {...r} busy={busy} act={act} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

let mounted: { root: Root; host: HTMLElement } | null = null;

/** Open the panel (once; a second call keeps the open one). */
export function openBatchPanel(): void {
  if (mounted) return;
  const host = document.createElement("div");
  host.id = "batch-panel-root";
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    if (!mounted) return;
    const m = mounted;
    mounted = null;
    m.root.unmount();
    m.host.remove();
  };
  mounted = { root, host };
  root.render(<BatchPanel onClose={close} />);
}
