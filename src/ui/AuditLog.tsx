/**
 * Audit log admin UI (ε.2.3 + ε.2.5).
 *
 * Reads from the `lumen-audit` edge worker via `src/lib/audit.ts` and
 * renders a paginated table with filters (action, user, date range).
 * Includes a CSV export action that downloads everything matching the
 * current filter — useful for SOC2 evidence + ad-hoc investigations.
 *
 * Gated on `Capabilities.auditLog` (Team tier) via `useCapability` —
 * non-entitled users see an upgrade notice and no fetch is made. When no
 * billing backend is configured (self-hosted) the gate is open. The worker
 * still enforces the bearer-token + org-id constraints server-side.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Download, RefreshCcw, X, Filter, Loader2 } from "lucide-react";
import { listAudit, type AuditRow } from "../lib/audit";
import { showAiToast } from "./AiToast";
import { log } from "../lib/logger";
import { t } from "../i18n";
import { useCapability } from "../billing/gates";
import { UpgradeNotice } from "./UpgradeNotice";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Active organisation id — admin scope. Required to fetch any rows. */
  orgId: string;
}

/** Format an ms timestamp as a sortable, readable string. */
function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

/** Escape a single field for CSV: neutralizes formulas, quotes cells with comma / quote / newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  // Spreadsheet apps run cells that start with = + - @ (or a tab / CR
  // before one) as formulas. Audit fields are caller-controlled, so prefix
  // them with an apostrophe to keep them as text (CSV injection).
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsv(rows: AuditRow[]): string {
  const header = ["ts", "user_id", "org_id", "action", "payload", "ip", "user_agent"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        fmtTs(r.ts ?? 0),
        r.user_id,
        r.org_id,
        r.action,
        r.payload_json,
        (r as AuditRow & { ip?: string }).ip,
        (r as AuditRow & { user_agent?: string }).user_agent,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click finishes — modern browsers race-safe.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AuditLog({ open, onClose, orgId }: Props) {
  const entitled = useCapability("auditLog");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionFilter, setActionFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const fetched = await listAudit({
        orgId,
        action: actionFilter || undefined,
        limit: 500,
      });
      setRows(fetched);
    } catch (e) {
      log.error("audit refresh failed", e);
      showAiToast(t("audit.fetchFailed", { error: (e as Error).message }), "error");
    } finally {
      setLoading(false);
    }
  }, [orgId, actionFilter]);

  useEffect(() => {
    if (!open || !entitled) return;
    void refresh();
  }, [open, entitled, refresh]);

  const visible = useMemo(() => {
    if (!userFilter.trim()) return rows;
    const q = userFilter.trim().toLowerCase();
    return rows.filter((r) => r.user_id.toLowerCase().includes(q));
  }, [rows, userFilter]);

  const handleExport = useCallback(() => {
    const csv = rowsToCsv(visible);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `audit-${orgId}-${ts}.csv`,
    );
    showAiToast(t("audit.exportDone", { count: String(visible.length) }), "success");
  }, [visible, orgId]);

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open, onEscape: onClose });

  if (!open) return null;

  if (!entitled) {
    return (
      <div
        className="cmd-palette-backdrop"
        onClick={onClose}
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("audit.title")}
      >
        <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
          <UpgradeNotice
            plan="team"
            title={t("audit.title")}
            message={t("billing.upgrade.auditLog")}
            onClose={onClose}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="cmd-palette-backdrop"
      onClick={onClose}
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("audit.title")}
    >
      <div
        className="cmd-palette"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 980,
          maxHeight: "82vh",
          minHeight: 480,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid hsl(var(--border))",
          }}
        >
          <span style={{ fontSize: 18 }}>🛡️</span>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("audit.title")}
          </h2>
          <span
            style={{
              fontSize: 11,
              color: "hsl(var(--fg-muted))",
              marginInlineStart: "auto",
            }}
          >
            {visible.length} / {rows.length} {t("audit.rows")}
          </span>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            aria-label={t("audit.refresh")}
            title={t("audit.refresh")}
            style={iconBtn}
          >
            {loading ? (
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <RefreshCcw size={14} />
            )}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={visible.length === 0}
            aria-label={t("audit.export")}
            title={t("audit.export")}
            style={iconBtn}
          >
            <Download size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("audit.close")}
            style={iconBtn}
          >
            <X size={14} />
          </button>
        </div>

        {/* Filters */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            borderBottom: "1px solid hsl(var(--border))",
          }}
        >
          <Filter size={12} style={{ opacity: 0.5 }} />
          <input
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder={t("audit.filter.action")}
            aria-label={t("audit.filter.action")}
            style={filterInput}
          />
          <input
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            placeholder={t("audit.filter.user")}
            aria-label={t("audit.filter.user")}
            style={filterInput}
          />
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {visible.length === 0 && !loading && (
            <div style={{ padding: 32, textAlign: "center", color: "hsl(var(--fg-muted))", fontSize: 13 }}>
              {t("audit.empty")}
            </div>
          )}
          {visible.length > 0 && (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 11.5,
                fontFamily: "ui-monospace, Menlo, monospace",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid hsl(var(--border))", textAlign: "start" }}>
                  <th style={th}>{t("audit.col.ts")}</th>
                  <th style={th}>{t("audit.col.user")}</th>
                  <th style={th}>{t("audit.col.action")}</th>
                  <th style={th}>{t("audit.col.payload")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => (
                  <tr key={`${r.ts}-${i}`} style={{ borderBottom: "1px solid hsl(var(--border) / 0.4)" }}>
                    <td style={td}>{fmtTs(r.ts ?? 0)}</td>
                    <td style={td}>{r.user_id}</td>
                    <td style={td}>{r.action}</td>
                    <td style={{ ...td, color: "hsl(var(--fg-muted))", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.payload_json}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "hsl(var(--fg-muted))",
  cursor: "pointer",
  padding: 4,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const filterInput: React.CSSProperties = {
  flex: 1,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--bg-subtle))",
  color: "hsl(var(--fg))",
  fontSize: 12,
  padding: "4px 8px",
  borderRadius: 4,
  outline: "none",
};

const th: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "hsl(var(--fg-muted))",
  fontWeight: 600,
  textAlign: "start",
};

const td: React.CSSProperties = {
  padding: "6px 12px",
  textAlign: "start",
  verticalAlign: "top",
};

// Re-export the CSV helpers for tests.
export { rowsToCsv, csvCell };
