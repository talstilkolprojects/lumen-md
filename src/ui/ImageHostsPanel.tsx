/**
 * Allowed image hosts (plan W1.30): the hosts the user chose "Always allow"
 * for in a remote-image placeholder (plan 2.2), each with a way to revoke
 * it, and "Revoke all". Revoking blocks the host's images again at once —
 * the preview and the WYSIWYG editor show the placeholder, and nothing is
 * requested from it until the user allows it again.
 *
 * `ImageHostsList` is the list alone; `ImageHostsSettings` is it with its
 * heading, for the settings screen's Privacy tab (W10.C18);
 * `ImageHostsPanel` is the dialog the palette opens. Lazy-loaded.
 */

import { useEffect, useSyncExternalStore } from "react";
import { ImageOff, X } from "lucide-react";
import { t } from "../i18n";
import { showAiToast } from "./AiToast";
import { allowedRemoteImageHosts, forgetAllRemoteImageHosts, forgetRemoteImageHost, remoteImagesVersion, subscribeRemoteImages } from "../lib/remoteImages";
import "./imageHostsPanelStrings";
import { HelpButton } from "./HelpButton";
import { EmptyState, learnHow } from "./EmptyState";

function useAllowedHosts(): string[] {
  useSyncExternalStore(subscribeRemoteImages, remoteImagesVersion, remoteImagesVersion);
  return allowedRemoteImageHosts();
}

export function ImageHostsList() {
  const hosts = useAllowedHosts();
  if (!hosts.length) {
    return (
      <EmptyState testId="image-hosts-empty" style={{ padding: 0 }} message={t("imageHosts.empty")} action={learnHow("security/image-hosts")} />
    );
  }
  return (
    <div>
      <ul data-testid="image-hosts" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {hosts.map((h) => (
          <li key={h} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid hsl(var(--border))" }}>
            {/* Host names read left to right inside a Hebrew screen. */}
            <span dir="ltr" style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono, monospace)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>
              {h}
            </span>
            <button
              type="button"
              className="chart-block-tab"
              aria-label={t("imageHosts.revokeHost", { host: h })}
              onClick={() => {
                forgetRemoteImageHost(h);
                showAiToast(t("imageHosts.revoked", { host: h }), "info");
              }}
            >
              {t("imageHosts.revoke")}
            </button>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 10 }}>
        <button
          type="button"
          className="chart-block-tab"
          onClick={() => {
            forgetAllRemoteImageHosts();
            showAiToast(t("imageHosts.revokedAll"), "info");
          }}
        >
          {t("imageHosts.revokeAll")}
        </button>
      </div>
    </div>
  );
}

/** The settings screen's Privacy tab: the allowed image hosts, each revocable. */
export function ImageHostsSettings() {
  return (
    <section aria-labelledby="settings-image-hosts" data-testid="settings-image-hosts">
      <h3 id="settings-image-hosts" style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
        <ImageOff size={14} aria-hidden="true" />
        {t("imageHosts.title")}
        <HelpButton topic="security/image-hosts" />
      </h3>
      <ImageHostsList />
    </section>
  );
}

export function ImageHostsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="cmd-palette-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("imageHosts.title")}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, padding: 0, display: "flex", flexDirection: "column", maxHeight: "80vh" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid hsl(var(--border))" }}>
          <ImageOff size={16} style={{ opacity: 0.7 }} />
          <span style={{ fontWeight: 600, flex: 1 }}>{t("imageHosts.title")}</span>
          <HelpButton topic="security/image-hosts" />
          <button type="button" className="icon-btn" aria-label={t("imageHosts.close")} onClick={onClose} style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ padding: "12px 14px", overflow: "auto" }}>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "hsl(var(--fg-muted))" }}>{t("imageHosts.intro")}</p>
          <ImageHostsList />
        </div>
      </div>
    </div>
  );
}
