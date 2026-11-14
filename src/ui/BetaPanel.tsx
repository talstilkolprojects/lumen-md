/**
 * The beta programme (plan W6.31): join or leave on this device, send
 * feedback, and — a second opt-in — prepare a weekly report from the local
 * usage counters (W4.26). See ../beta/programme.ts.
 *
 * Nothing leaves the device from here unless the tester clicks "Open … on
 * GitHub" (a new github.com tab with a prefilled issue the tester still
 * submits; recorded in the privacy ledger) or "Copy report".
 *
 * Loaded on demand (the palette's "Help: Beta programme", the weekly
 * reminder's toast), so neither it nor its strings are in the startup bundle.
 */

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FlaskConical, X } from "lucide-react";
import { t } from "../i18n";
import "../beta/strings";
import { BETA_AREAS, betaFeedbackLink, betaReport, betaReportUrl, joinBeta, leaveBeta, markBetaReported, readEnrolment, setBetaWeekly, type BetaArea } from "../beta/programme";
import { FEEDBACK_KINDS, collectEnvironment, type FeedbackKind } from "../feedback/feedback";
import { dayKey, loadUsage } from "../metrics/usage";
import { setUpdateChannel, updateChannel } from "../desktop/updates";
import { getAiPolicy } from "../ai/policy";
import { recordUserShare } from "../ai/privacyLedger";
import { useToastStore } from "../store/useToastStore";
import { HelpButton } from "./HelpButton";

export interface BetaOptions {
  /** Every command id of the app: the report names only these. */
  commandIds?: readonly string[];
}

const BETA_REASON = "Beta report or feedback you sent (counts or your own text, no notes)";

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const field: React.CSSProperties = { padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const pre: React.CSSProperties = { margin: 0, padding: "8px 10px", fontSize: 11, borderRadius: 6, background: "hsl(var(--bg-subtle))", border: "1px solid hsl(var(--border))", whiteSpace: "pre-wrap", overflowWrap: "anywhere", textAlign: "start", direction: "ltr" };
// The report is not a scroll box of its own (axe: scrollable-region-focusable); the panel body scrolls.
const section: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid hsl(var(--border))", paddingTop: 10 };

function BetaPanel({ options, onClose }: { options: BetaOptions; onClose: () => void }) {
  const [enrolment, setEnrolment] = useState(() => readEnrolment());
  const [notice, setNotice] = useState("");
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [area, setArea] = useState<BetaArea>("hebrew");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [withEnv, setWithEnv] = useState(true);
  const today = dayKey();
  const ids = options.commandIds ?? [];
  const report = useMemo(() => (enrolment ? betaReport(loadUsage(), enrolment, today, ids, updateChannel()) : null), [enrolment, today, ids]);
  const json = report ? JSON.stringify(report, null, 2) : "";

  const toggle = (on: boolean) => {
    if (on) {
      setEnrolment(joinBeta({ setChannel: setUpdateChannel }));
      useToastStore.getState().push({ kind: "success", title: t("beta.joined.toast") });
    } else {
      leaveBeta({ setChannel: setUpdateChannel });
      setEnrolment(null);
      useToastStore.getState().push({ kind: "info", title: t("beta.left.toast") });
    }
  };
  const open = (url: string, bytes: number) => {
    window.open(url, "_blank", "noopener,noreferrer");
    recordUserShare(url, bytes, BETA_REASON);
    setNotice(t("beta.opened"));
  };
  const sendReport = () => {
    if (!report) return;
    open(betaReportUrl(report), new TextEncoder().encode(json).length);
    markBetaReported(today);
  };
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(json);
      markBetaReported(today);
      setNotice(t("beta.copied"));
    } catch {
      // why: clipboard denied — the preview is selectable, and the notice says to copy it by hand
      setNotice(t("beta.copyFailed"));
    }
  };
  const sendFeedback = async () => {
    const weeksInBeta = report?.weeksInBeta ?? null;
    const link = betaFeedbackLink({ kind, area, title, description: text, weeksInBeta, environment: withEnv ? collectEnvironment(getAiPolicy()) : null });
    if (!link.withBody) {
      try {
        await navigator.clipboard.writeText(link.body);
      } catch {
        // why: clipboard denied — the issue form opens with the title, and the tester types the rest
      }
    }
    open(link.url, new TextEncoder().encode(link.title + link.body).length);
    if (!link.withBody) setNotice(t("beta.feedback.tooLong"));
  };

  return (
    <div className="cmd-palette-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="cmd-palette" role="dialog" aria-modal="true" aria-label={t("beta.title")} data-testid="beta-panel" style={{ maxWidth: 560, padding: 0, display: "flex", flexDirection: "column", maxHeight: "88vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <FlaskConical size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("beta.title")}</h2>
          <HelpButton topic="project/beta-programme" />
          <button type="button" style={ghost} onClick={onClose} aria-label={t("beta.close")}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, fontSize: 13, overflowY: "auto" }}>
          <p style={{ ...muted, margin: 0 }}>{t("beta.intro")}</p>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={!!enrolment} data-testid="beta-join" onChange={(e) => toggle(e.target.checked)} />
            <span>{t("beta.join")}</span>
          </label>
          <div style={muted} data-testid="beta-status">
            {enrolment && report ? t("beta.joinedOn", { date: enrolment.joined, week: report.weeksInBeta + 1 }) : t("beta.notJoined")}
          </div>
          <div style={muted}>{t("beta.what")}</div>

          {enrolment && report && (
            <div style={section}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={enrolment.weeklyReport} data-testid="beta-weekly" onChange={(e) => setEnrolment(setBetaWeekly(e.target.checked))} />
                <span>{t("beta.weekly")}</span>
              </label>
              <span style={muted}>{t("beta.weekly.hint")}</span>
              {enrolment.weeklyReport && (
                <>
                  <span style={{ fontWeight: 600 }}>{t("beta.preview")}</span>
                  <pre style={pre} data-testid="beta-preview">
                    {json}
                  </pre>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <button type="button" style={ghost} onClick={() => void copyReport()} data-testid="beta-copy">
                      {t("beta.copy")}
                    </button>
                    <button type="button" style={primary} onClick={sendReport} data-testid="beta-send">
                      {t("beta.send")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <div style={section}>
            <span style={{ fontWeight: 600 }}>{t("beta.feedback")}</span>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={muted}>{t("beta.feedback.kind")}</span>
              <select style={field} value={kind} data-testid="beta-kind" onChange={(e) => setKind(e.target.value as FeedbackKind)}>
                {FEEDBACK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`beta.kind.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={muted}>{t("beta.feedback.area")}</span>
              <select style={field} value={area} data-testid="beta-area" onChange={(e) => setArea(e.target.value as BetaArea)}>
                {BETA_AREAS.map((a) => (
                  <option key={a} value={a}>
                    {t(`beta.area.${a}`)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={muted}>{t("beta.feedback.title")}</span>
              <input style={field} value={title} data-testid="beta-title" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={muted}>{t("beta.feedback.text")}</span>
              <textarea style={{ ...field, minHeight: 80 }} value={text} dir="auto" data-testid="beta-text" onChange={(e) => setText(e.target.value)} />
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={withEnv} onChange={(e) => setWithEnv(e.target.checked)} />
              <span>{t("beta.feedback.env")}</span>
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" style={primary} disabled={!title.trim() && !text.trim()} onClick={() => void sendFeedback()} data-testid="beta-feedback-send">
                {t("beta.feedback.send")}
              </button>
            </div>
          </div>
          {notice && (
            <div style={muted} role="status" data-testid="beta-notice">
              {notice}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

let openHost: { close: () => void } | null = null;

/** Open the beta panel (one at a time). */
export function openBeta(options: BetaOptions = {}): void {
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
  root.render(<BetaPanel options={options} onClose={close} />);
}
