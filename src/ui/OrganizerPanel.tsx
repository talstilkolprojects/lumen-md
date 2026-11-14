/**
 * The vault organizer (plan W2.1): progress with Pause / Resume / Cancel
 * (like the batch jobs, plan 5.8), the suggestions with their confidence,
 * explanation and quote, and "Review the next N", which sends them to the
 * review screen (plan 5.11) — the only place anything is approved and
 * written. Lazy: mounted on demand by "AI: Organize the vault".
 */
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Network, X } from "lucide-react";
import { t } from "../i18n";
import { startOrganizer, workspaceSource, DEFAULT_BATCH, type OrganizerJob, type OrganizerState } from "../agents/organizer/job";
import { basenameOf } from "../agents/organizer/analyze";
import { formatEta } from "./BatchPanel";
import "./organizerPanelStrings";
import { HelpButton } from "./HelpButton";
import { EmptyState, learnHow } from "./EmptyState";

const btn: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...btn, background: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))", borderColor: "transparent" };
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };

function Status({ s }: { s: OrganizerState }) {
  if (s.phase === "reading") {
    const eta = s.msPerNote !== null && s.total > s.read ? ` · ${formatEta(s.msPerNote * (s.total - s.read), document.documentElement.lang || undefined)}` : "";
    return (
      <>
        <progress max={Math.max(1, s.total)} value={s.read} style={{ width: "100%" }} aria-label={t("organizer.reading", { read: s.read, total: s.total })} />
        <span style={muted}>
          {t("organizer.reading", { read: s.read, total: s.total })}
          {s.paused ? ` · ${t("organizer.paused")}` : eta}
        </span>
      </>
    );
  }
  if (s.phase === "analysing") return <span style={muted}>{s.paused ? t("organizer.paused") : t("organizer.analysing")}</span>;
  if (s.phase === "cancelled") return <span style={muted}>{t("organizer.cancelled")}</span>;
  if (s.phase === "failed") return <span style={{ ...muted, color: "hsl(var(--danger))" }}>{t("organizer.failed", { error: s.error ?? "" })}</span>;
  if (!s.suggestions.length) return <EmptyState style={{ padding: 0 }} message={t("organizer.none")} action={learnHow("ai/organizer#how-it-decides")} />;
  return (
    <span data-testid="organizer-summary" style={{ fontSize: 13 }}>
      {t("organizer.ready", { count: s.suggestions.length, ...s.counts })}
    </span>
  );
}

export function OrganizerPanel({ job, onClose }: { job: OrganizerJob; onClose: () => void }) {
  const [s, setS] = useState<OrganizerState>(job.state);
  useEffect(() => job.subscribe(setS), [job]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const running = s.phase === "reading" || s.phase === "analysing";
  const left = s.suggestions.length - s.staged;
  const shown = s.suggestions.slice(s.staged, s.staged + DEFAULT_BATCH);
  // The review screen is a dialog of its own: this one steps aside (the run is kept; the command shows it again).
  const review = () => {
    onClose();
    window.dispatchEvent(new CustomEvent("lumen-open-agent-review"));
  };

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("organizer.title")} data-testid="organizer-panel" data-phase={s.phase}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680, padding: 0, display: "flex", flexDirection: "column", maxHeight: "84vh" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Network size={16} />
          <strong style={{ flex: 1 }}>{t("organizer.title")}</strong>
          <HelpButton topic="ai/organizer" />
          <button type="button" style={btn} onClick={onClose} aria-label={t("agentReview.close")}>
            <X size={14} />
          </button>
        </header>
        <div style={{ padding: "10px 16px", display: "flex", flexDirection: "column", gap: 6, borderBottom: "1px solid hsl(var(--border))" }}>
          <p style={{ ...muted, margin: 0 }}>{t("organizer.intro")}</p>
          <Status s={s} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {running && (s.paused ? (
              <button type="button" style={btn} onClick={() => job.resume()} data-testid="organizer-resume">
                {t("organizer.resume")}
              </button>
            ) : (
              <button type="button" style={btn} onClick={() => job.pause()} data-testid="organizer-pause">
                {t("organizer.pause")}
              </button>
            ))}
            {running && (
              <button type="button" style={btn} onClick={() => job.cancel()} data-testid="organizer-cancel">
                {t("organizer.cancel")}
              </button>
            )}
            {s.phase === "ready" && left > 0 && (
              <button
                type="button"
                style={primary}
                data-testid="organizer-next"
                onClick={() => {
                  job.stageNext();
                  review();
                }}
              >
                {t("organizer.next", { n: Math.min(DEFAULT_BATCH, left) })}
              </button>
            )}
            {s.staged > 0 && (
              <>
                <span style={{ ...muted, alignSelf: "center" }} data-testid="organizer-sent">
                  {t("organizer.sent", { staged: s.staged, count: s.suggestions.length })}
                </span>
                <button type="button" style={btn} onClick={review}>
                  {t("organizer.openReview")}
                </button>
              </>
            )}
          </div>
        </div>
        <ul style={{ margin: 0, padding: 0, overflow: "auto", flex: 1 }}>
          {shown.map((x) => (
            <li key={x.id} data-testid="organizer-suggestion" data-kind={x.kind} style={{ listStyle: "none", padding: "8px 16px", borderBottom: "1px solid hsl(var(--border))", display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ ...muted, minWidth: 70 }}>{t(`organizer.kind.${x.kind}`)}</span>
                <strong dir="auto" style={{ flex: 1, fontSize: 13 }}>
                  {t(x.reason.key, x.reason.params)}
                </strong>
                <span style={muted} data-testid="organizer-confidence">
                  {Math.round(x.confidence * 100)}%
                </span>
              </div>
              {x.quote.text && (
                <blockquote dir="auto" style={{ margin: 0, paddingInlineStart: 8, borderInlineStart: "2px solid hsl(var(--border))", fontSize: 12 }}>
                  {x.quote.text} <span style={muted}>— <bdi>{basenameOf(x.quote.path)}</bdi></span>
                </blockquote>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

let mounted: { root: Root; host: HTMLElement; job: OrganizerJob } | null = null;

/**
 * Open the panel. A running or unreviewed job is shown again; otherwise a
 * new run starts on the workspace.
 */
export async function openOrganizerPanel(): Promise<void> {
  if (mounted) return;
  const host = document.createElement("div");
  host.id = "organizer-panel-root";
  document.body.appendChild(host);
  const root = createRoot(host);
  let job = lastJob;
  const reuse = job && (job.state.phase === "reading" || job.state.phase === "analysing" || (job.state.phase === "ready" && job.state.staged < job.state.suggestions.length));
  if (!reuse) {
    lastJob?.dispose();
    job = lastJob = startOrganizer(await workspaceSource());
  }
  const close = () => {
    if (!mounted) return;
    const m = mounted;
    mounted = null;
    m.root.unmount();
    m.host.remove();
  };
  mounted = { root, host, job: job! };
  root.render(<OrganizerPanel job={job!} onClose={close} />);
}

let lastJob: OrganizerJob | null = null;
