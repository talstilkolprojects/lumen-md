import { lazy, Suspense, useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { findBacklinks, type BacklinkHit } from "../storage/workspaceIndex";
import { t } from "../i18n";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { log } from "../lib/logger";

// Unlinked mentions (4.6): its scan and Link action load with the section.
const UnlinkedMentions = lazy(() => import("./UnlinkedMentions"));
import { EmptyState } from "./EmptyState";
import { HelpButton } from "./HelpButton";

interface Props {
  /** Active workspace path. */
  filePath: string | null;
  /** Called with the source file's path when a backlink is clicked. */
  onOpen: (fromPath: string) => void;
}

export function BacklinksPanel({ filePath, onOpen }: Props) {
  const [hits, setHits] = useState<BacklinkHit[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setHits(null);
      return;
    }
    setLoading(true);
    findBacklinks(filePath)
      .then((h) => {
        if (!cancelled) {
          setHits(h);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHits([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Refresh on workspace changes.
  useEffect(() => {
    if (!filePath) return;
    function refresh() {
      findBacklinks(filePath!)
        .then((h) => setHits(h))
        .catch((e) => log.warn("backlinks: could not scan the vault", e));
    }
    return onWorkspaceChanged(refresh, { debounceMs: 500 });
  }, [filePath]);

  return (
    <aside className="backlinks-panel" aria-label={t("backlinks.title")}>
      <div className="file-tree-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Link2 size={12} />
          {t("backlinks.title")}
        </span>
        <HelpButton topic="workspace/panels#backlinks" />
      </div>
      {!filePath && (
        <div style={{ padding: "1rem", color: "hsl(var(--fg-muted))", fontSize: 12 }}>
          {t("backlinks.selectFile")}
        </div>
      )}
      {filePath && loading && (
        <div style={{ padding: "1rem", color: "hsl(var(--fg-muted))", fontSize: 12 }}>
          {t("backlinks.scanning")}
        </div>
      )}
      {filePath && !loading && hits && hits.length === 0 && (
        <EmptyState
          message={t("backlinks.empty")}
          action={{
            label: t("backlinks.copyLink"),
            // A [[link]] to this note, ready to paste into another one.
            onClick: () => void navigator.clipboard?.writeText(`[[${(filePath ?? "").replace(/^.*\//, "").replace(/\.(md|markdown)$/i, "")}]]`).catch(() => undefined),
          }}
        />
      )}
      {hits && hits.length > 0 && (
        <ul className="backlinks-list" role="list" aria-label={t("backlinks.title")}>
          {hits.map((h, i) => (
            <li key={i} role="listitem">
              <button
                type="button"
                className="backlink-item"
                onClick={() => onOpen(h.fromPath)}
                title={h.fromPath}
              >
                <span className="backlink-from">{h.fromName}</span>
                <span className="backlink-snippet">{h.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {filePath && (
        <Suspense fallback={null}>
          <UnlinkedMentions filePath={filePath} onOpen={onOpen} />
        </Suspense>
      )}
    </aside>
  );
}
