/**
 * The install screen of a sandboxed plugin (plan W1.20): before anything
 * runs, every permission the manifest asks for, in plain language, with the
 * plugin's own reason, and the version's safety scan. Installing grants
 * exactly what is listed; nothing else ever reaches the plugin.
 */
import { useEffect, useRef } from "react";
import { t } from "../../i18n";
import { describeCapability, describeFindings, isSensitive, reportUrl } from "./permissions";
import type { PluginManifest } from "./manifest";
import type { ScanResult } from "./scan";
import { HelpButton } from "../../ui/HelpButton";

export function InstallDialog(props: { manifest: PluginManifest; scan: ScanResult; busy?: boolean; onInstall: () => void; onCancel: () => void }) {
  const { manifest: m, scan } = props;
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props]);
  const notes = scan.findings.length ? t("pluginTrust.card.notes", { list: describeFindings(scan.findings) }) : t("pluginTrust.card.clean");
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-install-title"
      data-testid="plugin-install-dialog"
      style={{ position: "fixed", inset: 0, zIndex: 210, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border))", borderRadius: 12, maxWidth: 520, width: "100%", padding: 20, maxHeight: "90vh", overflow: "auto" }}>
        <h2 id="plugin-install-title" style={{ margin: "0 0 8px", fontSize: 18 }}>
          {t("pluginTrust.dialog.title", { name: m.name })}
        </h2>
        <HelpButton topic="plugins/permissions#the-install-screen" />
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "hsl(var(--fg-muted))" }}>{t("pluginTrust.dialog.asks", { name: m.name, version: m.version, author: m.author })}</p>
        {m.capabilities.length === 0 ? (
          // empty-allow: "asks for no permissions" is the scan's answer, not an empty state; Install / Cancel follow
          <p style={{ fontSize: 14 }}>{t("pluginTrust.dialog.none")}</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "grid", gap: 8 }}>
            {m.capabilities.map((c) => (
              <li key={c.id} data-testid="install-capability" data-capability={c.id} style={{ border: "1px solid hsl(var(--border))", borderRadius: 8, padding: "8px 10px" }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {describeCapability(c.id)}
                  {isSensitive(c.id) && (
                    <span style={{ marginInlineStart: 8, fontSize: 11, fontWeight: 500, color: "hsl(var(--warning, 30 90% 45%))" }}>{t("pluginTrust.dialog.sensitive")}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
                  <bdi>{t("pluginTrust.dialog.reason", { reason: c.reason })}</bdi>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p data-testid="install-scan" style={{ fontSize: 12, margin: "0 0 6px" }}>
          {t("pluginTrust.card.grade", { grade: scan.grade, score: scan.score })} — {notes}
        </p>
        <p style={{ fontSize: 12, color: "hsl(var(--fg-muted))", margin: "0 0 14px" }}>{t("pluginTrust.dialog.sandbox")}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
          <a href={reportUrl(m.id, m.version)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, marginInlineEnd: "auto", color: "hsl(var(--accent))" }}>
            {t("pluginTrust.report")}
          </a>
          <button ref={cancelRef} type="button" className="btn" onClick={props.onCancel}>
            {t("pluginTrust.dialog.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={props.busy || !scan.passed} onClick={props.onInstall}>
            {t("pluginTrust.dialog.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
