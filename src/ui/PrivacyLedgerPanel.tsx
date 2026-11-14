/**
 * Privacy ledger panel (T37): every AI network request — where, how much,
 * why, under which policy — and what the policy blocked.
 */
import { useState, useSyncExternalStore, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { ShieldCheck, X } from "lucide-react";
import { t, getLocale } from "../i18n";
import { auditMode, clearLedger, leftDevice, ledgerEntries, ledgerSummary, subscribeLedger, type LedgerEntry } from "../ai/privacyLedger";
import "../privacy/strings";
import { getAiPolicy } from "../ai/policy";
import { redactionLog, redactionTotals, subscribeRedactionLog } from "../ai/piiRedactor";
import { EmptyState } from "./EmptyState";
import { HelpButton } from "./HelpButton";
import "./privacyLedgerPanelStrings";

interface Props {
  open: boolean;
  onClose: () => void;
}

const btn: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };

function bytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function PrivacyLedgerPanel({ open, onClose }: Props) {
  const list = useSyncExternalStore(subscribeLedger, ledgerEntries, ledgerEntries);
  const [onlyCloud, setOnlyCloud] = useState(false);
  const redactions = useSyncExternalStore(subscribeRedactionLog, redactionLog, redactionLog);
  const [exported, setExported] = useState<string | null>(null);

  // Plan W2.24: the session's ledger as a signed report (lazy: the signing code loads on use).
  const exportReport = () => {
    setExported(null);
    void import("../privacy/report")
      .then((m) => m.exportPrivacyReport(ledgerEntries(), { auditMode: auditMode() }))
      .then(
        (b) => {
          const r = JSON.parse(b.report) as { summary: { requests: number; leftDevice: number } };
          setExported(t("privacy.report.done", { n: r.summary.requests, left: r.summary.leftDevice }));
        },
        (e: unknown) => setExported(t("privacy.report.failed", { error: String((e as Error)?.message ?? e) })),
      );
  };

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open, onEscape: onClose });

  if (!open) return null;
  const sum = ledgerSummary(list);
  const shown = [...list].reverse().filter((e) => !onlyCloud || leftDevice(e));
  const policy = getAiPolicy();
  const catLabel = (e: LedgerEntry) => t(`privacy.cat.${e.category}`);

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} ref={trapRef} role="dialog" aria-modal="true" aria-label={t("privacy.title")}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, padding: 0, display: "flex", flexDirection: "column", maxHeight: "82vh" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <ShieldCheck size={16} />
          <strong style={{ flex: 1 }}>{t("privacy.title")}</strong>
          <HelpButton topic="ai/privacy#the-privacy-ledger" />
          <button type="button" style={btn} onClick={onClose} aria-label={t("privacy.close")}>
            <X size={14} />
          </button>
        </header>
        <div style={{ padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: "6px 16px", fontSize: 12.5, borderBottom: "1px solid hsl(var(--border))" }} data-testid="privacy-summary">
          <span>{t("privacy.policy", { policy: t(`privacy.policyName.${policy}`) })}</span>
          <span>{t("privacy.cloudRequests", { n: sum.cloudRequests, size: bytes(sum.cloudBytesOut) })}</span>
          <span>{t("privacy.localRequests", { n: sum.local })}</span>
          <span>{t("privacy.downloads", { n: sum.downloads })}</span>
          <span style={{ color: sum.blocked ? "hsl(var(--danger))" : undefined }}>{t("privacy.blocked", { n: sum.blocked })}</span>
          {sum.staticAssets > 0 && <span>{t("privacy.staticAssets", { n: sum.staticAssets })}</span>}
          <span data-testid="privacy-redacted">{t("pii.ledger.redacted", { n: redactionTotals(redactions).items, requests: redactionTotals(redactions).requests })}</span>
        </div>
        <div style={{ padding: "8px 16px", display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}>
            <input type="checkbox" checked={onlyCloud} onChange={(e) => setOnlyCloud(e.target.checked)} />
            {t("privacy.onlyLeaving")}
          </label>
          <button type="button" style={btn} onClick={exportReport} data-testid="privacy-export">
            {t("privacy.report.export")}
          </button>
          <button type="button" style={btn} onClick={clearLedger} disabled={!list.length}>
            {t("privacy.clear")}
          </button>
        </div>
        {(auditMode() || exported) && (
          <div style={{ padding: "0 16px 8px", fontSize: 12, display: "grid", gap: 4 }}>
            {auditMode() && <span data-testid="privacy-audit-mode">{t("privacy.audit.on")}</span>}
            {exported && <span role="status">{exported}</span>}
          </div>
        )}
        <div style={{ overflow: "auto", flex: 1 }}>
          {shown.length === 0 ? (
            <EmptyState
              style={{ fontSize: 13 }}
              message={t("privacy.empty")}
              action={{
                label: t("privacy.openAiSettings"),
                onClick: () => {
                  onClose();
                  window.dispatchEvent(new CustomEvent("lumen-open-ai-settings"));
                },
              }}
            />
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "hsl(var(--fg-muted))", textAlign: "start" }}>
                  {["time", "where", "why", "sent", "received", "decision"].map((h) => (
                    <th key={h} style={{ textAlign: "start", padding: "6px 10px", fontWeight: 600 }}>{t(`privacy.col.${h}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} data-testid="privacy-row" data-decision={e.decision} style={{ borderTop: "1px solid hsl(var(--border))" }}>
                    <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleTimeString(getLocale())}</td>
                    <td style={{ padding: "6px 10px" }}>
                      <bdi dir="ltr">{e.host}</bdi>
                      <div style={{ color: "hsl(var(--fg-muted))" }}>{catLabel(e)}</div>
                    </td>
                    <td style={{ padding: "6px 10px" }}>{e.reason}</td>
                    <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{bytes(e.bytesOut)}</td>
                    <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{bytes(e.bytesIn)}</td>
                    <td style={{ padding: "6px 10px", whiteSpace: "nowrap", color: e.decision === "blocked" ? "hsl(var(--danger))" : undefined }}>
                      {t(`privacy.decision.${e.decision}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <footer style={{ padding: "8px 16px", fontSize: 11.5, color: "hsl(var(--fg-muted))", borderTop: "1px solid hsl(var(--border))" }}>{t("privacy.footer")}</footer>
      </div>
    </div>
  );
}
