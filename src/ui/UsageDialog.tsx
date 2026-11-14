/**
 * Usage on this device (plan W4.26): the local counters as a small
 * dashboard — activation, days used, 7- and 30-day retention, the most used
 * and the unused commands — and the weekly report, shown in full.
 *
 * Nothing leaves the device from here unless the user clicks "Open on
 * GitHub" (a new github.com tab with the report in an issue form, which the
 * user still has to submit; recorded in the privacy ledger) or "Copy".
 * Counting can be turned off (which clears the counts); the weekly reminder
 * is off until turned on here.
 *
 * Loaded on demand (the palette's "Help: Usage on this device", the weekly
 * reminder's toast), so neither it nor its strings are in the startup bundle.
 */

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BarChart3, X } from "lucide-react";
import { t } from "../i18n";
import "../metrics/strings";
import { countingEnabled, dayKey, loadUsage, markReported, reportIssueUrl, setCounting, setWeekly, summarize, unusedFeatures, weeklyReport, WEEKLY_KEY } from "../metrics/usage";
import { recordUserShare } from "../ai/privacyLedger";

export interface UsageOptions {
  /** Every command id of the app, to count the unused ones. */
  commandIds?: readonly string[];
}

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const pre: React.CSSProperties = { margin: 0, padding: "8px 10px", fontSize: 11, borderRadius: 6, background: "hsl(var(--bg-subtle))", border: "1px solid hsl(var(--border))", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", textAlign: "start", direction: "ltr" };

const weeklyOn = () => {
  try {
    return localStorage.getItem(WEEKLY_KEY) === "1";
  } catch {
    return false;
  }
};

function UsageDialog({ options, onClose }: { options: UsageOptions; onClose: () => void }) {
  const [version, setVersion] = useState(0);
  const [counting, setCountingState] = useState(countingEnabled);
  const [weekly, setWeeklyState] = useState(weeklyOn);
  const [notice, setNotice] = useState("");
  const today = dayKey();
  const ids = options.commandIds ?? [];
  const { summary, report, json } = useMemo(() => {
    const store = loadUsage();
    const report = weeklyReport(store, today, ids);
    return { summary: summarize(store, today), report, json: JSON.stringify(report, null, 2) };
    // `version` re-reads the counts after "Clear counts" or a toggle.
  }, [today, ids, version]);
  const unused = unusedFeatures(summary, ids).length;
  // Only the app's own command ids are shown, as in the report.
  const shown = ids.length ? summary.features30.filter(([id]) => ids.includes(id)) : summary.features30;
  const yesNo = (v: boolean | null) => t(v === null ? "usage.unknown" : v ? "usage.yes" : "usage.no");

  const send = () => {
    const url = reportIssueUrl(report);
    window.open(url, "_blank", "noopener,noreferrer");
    recordUserShare(url, new TextEncoder().encode(json).length);
    markReported(today);
    setNotice(t("usage.opened"));
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setNotice(t("usage.copied"));
    } catch {
      // why: clipboard denied — the preview is selectable, and the notice says to copy it by hand
      setNotice(t("usage.copyFailed"));
    }
  };
  const clear = () => {
    setCounting(false);
    if (counting) setCounting(true);
    setVersion((v) => v + 1);
    setNotice(t("usage.cleared"));
  };

  return (
    <div className="cmd-palette-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="cmd-palette" role="dialog" aria-modal="true" aria-label={t("usage.title")} data-testid="usage-dialog" style={{ maxWidth: 560, padding: 0, display: "flex", flexDirection: "column", maxHeight: "88vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <BarChart3 size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("usage.title")}</h2>
          <button type="button" style={ghost} onClick={onClose} aria-label={t("usage.close")}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, fontSize: 13, overflowY: "auto" }}>
          <p style={{ ...muted, margin: 0 }}>{t("usage.intro")}</p>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={counting}
              data-testid="usage-counting"
              onChange={(e) => {
                setCounting(e.target.checked);
                setCountingState(e.target.checked);
                setVersion((v) => v + 1);
              }}
            />
            <span>{t("usage.counting")}</span>
          </label>
          {!counting && <div style={muted}>{t("usage.countingOff")}</div>}
          <div data-testid="usage-summary" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div>{summary.activatedOn ? t("usage.activated", { date: summary.activatedOn }) : t("usage.notYet")}</div>
            <div>{t("usage.days", { week: summary.daysActive7, month: summary.daysActive30 })}</div>
            <div>{t("usage.retention", { week: yesNo(summary.retained7), month: yesNo(summary.retained30) })}</div>
            <div>{t("usage.week", { opens: summary.opens7, errors: summary.errors7 })}</div>
            <div style={{ fontWeight: 600, marginTop: 4 }}>{t("usage.top")}</div>
            {shown.length ? (
              <ol style={{ margin: 0, paddingInlineStart: 20 }}>
                {shown.slice(0, 8).map(([id, n]) => (
                  <li key={id}>
                    <code dir="ltr">{id}</code> × {n}
                  </li>
                ))}
              </ol>
            ) : (
              <div style={muted}>{t("usage.none")}</div>
            )}
            {ids.length > 0 && <div style={muted}>{t("usage.unused", { count: unused })}</div>}
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={weekly}
              data-testid="usage-weekly"
              onChange={(e) => {
                setWeekly(e.target.checked);
                setWeeklyState(e.target.checked);
              }}
            />
            <span>{t("usage.weekly")}</span>
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontWeight: 600 }}>{t("usage.preview")}</span>
            <pre style={pre} data-testid="usage-preview">
              {json}
            </pre>
          </div>
          {notice && (
            <div style={muted} role="status" data-testid="usage-notice">
              {notice}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" style={ghost} onClick={clear} data-testid="usage-clear">
              {t("usage.clear")}
            </button>
            <button type="button" style={ghost} onClick={() => void copy()} data-testid="usage-copy">
              {t("usage.copy")}
            </button>
            <button type="button" style={primary} onClick={send} title={t("usage.send.hint")} data-testid="usage-send">
              {t("usage.send")}
            </button>
          </div>
          <span style={{ ...muted, textAlign: "end" }}>{t("usage.send.hint")}</span>
        </div>
      </div>
    </div>
  );
}

let openHost: { close: () => void } | null = null;

/** Open the usage dialog (one at a time). */
export function openUsage(options: UsageOptions = {}): void {
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
  root.render(<UsageDialog options={options} onClose={close} />);
}
