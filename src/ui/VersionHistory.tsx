import { useState, useEffect, useCallback } from "react";
import { t, getLocale } from "../i18n";

/**
 * Version history — reads the one history store (src/storage/history.ts)
 * that every save path writes to (T35).
 */

import { getHistoryVault, listSnapshots, recordSnapshot, type Snapshot } from "../storage/history";

/** Save a snapshot (kept for callers of the old API). */
export async function saveSnapshot(name: string, content: string): Promise<void> {
  await recordSnapshot(name, content, "manual");
}

/** Load all snapshots for a document, newest first. */
export async function loadSnapshots(name: string): Promise<Snapshot[]> {
  return listSnapshots(name);
}

/* ─── React component ─── */

interface Props {
  fileName: string;
  currentContent: string;
  onRestore: (content: string) => void;
  onClose: () => void;
}

export function VersionHistory({ fileName, currentContent, onRestore, onClose }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selected, setSelected] = useState<Snapshot | null>(null);

  useEffect(() => {
    loadSnapshots(fileName).then(setSnapshots).catch(() => setSnapshots([]));
  }, [fileName]);

  const handleRestore = useCallback(async () => {
    if (!selected) return;
    // Listed from another vault (the vault switched while this was open):
    // never write its text into this one (2.80).
    if (selected.vault !== undefined && selected.vault !== getHistoryVault()) {
      onClose();
      return;
    }
    // Keep what is being replaced, so a restore can itself be undone.
    await recordSnapshot(fileName, currentContent, "restore").catch(() => false);
    onRestore(selected.content);
    onClose();
  }, [selected, onRestore, onClose, fileName, currentContent]);

  const diffChars = selected
    ? Math.abs(selected.content.length - currentContent.length)
    : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("versionHistory.title")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        background: "hsl(0 0% 0% / 0.5)",
        backdropFilter: "blur(4px)",
      }}
    >
      {/* Sidebar: snapshot list */}
      <div style={{
        width: 280,
        background: "hsl(var(--bg))",
        borderRight: "1px solid hsl(var(--border))",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
          <h3 style={{ margin: 0, fontSize: 14, color: "hsl(var(--fg))" }}>{t("versionHistory.title")}</h3>
          <p style={{ margin: "4px 0 0", fontSize: 11, color: "hsl(var(--fg-muted))" }}>{t("versionHistory.savedCount", { count: String(snapshots.length) })}</p>
        </div>
        {snapshots.map((snap) => (
          <button
            key={snap.id}
            onClick={() => setSelected(snap)}
            style={{
              padding: "10px 16px",
              border: "none",
              background: selected?.id === snap.id ? "hsl(var(--accent) / 0.12)" : "transparent",
              color: "hsl(var(--fg))",
              textAlign: "start",
              cursor: "pointer",
              borderBottom: "1px solid hsl(var(--border))",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500 }}>
              {new Date(snap.timestamp).toLocaleString(getLocale())}
            </div>
            <div style={{ fontSize: 10, color: "hsl(var(--fg-muted))" }}>
              {snap.content.length} chars{snap.reason ? ` · ${t(`versionHistory.reason.${snap.reason}`)}` : ""}
            </div>
          </button>
        ))}
        {snapshots.length === 0 && (
          <div style={{ padding: 16, color: "hsl(var(--fg-muted))", fontSize: 12 }}>
            {t("versionHistory.noVersions")}
          </div>
        )}
      </div>

      {/* Preview pane */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "hsl(var(--bg))",
          borderBottom: "1px solid hsl(var(--border))",
        }}>
          <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
            {selected ? t("versionHistory.diffChars", { n: String(diffChars) }) : t("versionHistory.selectVersion")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {selected && (
              <button onClick={() => void handleRestore()} style={{
                padding: "4px 12px",
                fontSize: 12,
                border: "none",
                borderRadius: 6,
                background: "hsl(var(--accent))",
                color: "white",
                cursor: "pointer",
                fontWeight: 600,
              }}>
                {t("versionHistory.restore")}
              </button>
            )}
            <button onClick={onClose} aria-label={t("versionHistory.close")} className="icon-btn" style={{ width: "auto", padding: "4px 12px", fontSize: 12 }}>
              {t("versionHistory.close")}
            </button>
          </div>
        </div>
        <pre style={{
          flex: 1,
          margin: 0,
          padding: 16,
          fontSize: 12,
          lineHeight: 1.6,
          color: "hsl(var(--fg))",
          background: "hsl(var(--bg-subtle))",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
        }}>
          {selected?.content ?? ""}
        </pre>
      </div>
    </div>
  );
}
