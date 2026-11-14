/**
 * What an error screen offers (plan W3.7): report the problem (the feedback
 * form, kind "bug") and save the diagnostics bundle to attach — the version,
 * settings and recent errors, with no note text and no keys.
 */
import { t } from "../i18n";

const btn = { padding: "6px 14px", borderRadius: 8, border: "1px solid currentcolor", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13, fontWeight: 500 } as const;

export function ErrorActions({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBlockStart: compact ? 8 : 0 }} data-testid="error-actions">
      <button type="button" style={btn} onClick={() => void import("./FeedbackDialog").then((m) => m.openFeedback({ kind: "bug" }))}>
        {t("errorScreen.report")}
      </button>
      <button type="button" style={btn} onClick={() => void import("./diagnosticsActions").then((m) => m.saveDiagnostics())}>
        {t("errorScreen.diagnostics")}
      </button>
      {!compact && <p style={{ flexBasis: "100%", margin: 0, fontSize: 12, opacity: 0.75 }}>{t("errorScreen.diagnosticsHint")}</p>}
    </div>
  );
}
