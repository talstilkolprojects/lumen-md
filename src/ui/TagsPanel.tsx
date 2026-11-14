/**
 * Right-side panel that shows every `tags:` value across the workspace
 * and lets you click to filter the file tree by tag. Mirrors the
 * Backlinks panel layout so the side bar stays consistent.
 *
 * Hovering a tag preview's the matching note paths inline. Clicking a
 * note opens it via the existing `lumen-open-file` event so the rest of
 * the app (Recents, dirty-prompt, etc.) keeps working.
 */

import { useCallback, useEffect, useState } from "react";
import { Hash, X } from "lucide-react";
import { buildTagsIndex, type TagsIndex } from "../views/tagsIndex";
import { t } from "../i18n";
import { useAppStore } from "../store/useStore";
import { onWorkspaceChanged } from "../storage/workspaceEvents";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TagsPanel({ open, onClose }: Props) {
  const [index, setIndex] = useState<TagsIndex | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setTagFilter = useAppStore((s) => s.setTagFilter);

  // Publish the tag's path-set into useStore so the FileTree can scope itself
  // to it. Toggling a tag off clears the filter (the FileTree then shows
  // everything again). The panel itself remains the source of truth for the
  // visible "active tag" UI; the store mirrors it for the tree.
  useEffect(() => {
    if (!activeTag || !index) {
      setTagFilter(null);
      return;
    }
    const bucket = index.buckets.find((b) => b.tag === activeTag);
    if (!bucket) {
      setTagFilter(null);
      return;
    }
    setTagFilter({ tag: activeTag, paths: bucket.paths });
  }, [activeTag, index, setTagFilter]);

  // Clear the filter on unmount so closing the panel doesn't leave the tree
  // in a stuck-filtered state.
  useEffect(() => {
    return () => setTagFilter(null);
  }, [setTagFilter]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setIndex(await buildTagsIndex());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    return onWorkspaceChanged(() => void refresh(), { debounceMs: 500 });
  }, [open, refresh]);

  if (!open) return null;

  const buckets = index?.buckets ?? [];
  const focusBucket = activeTag
    ? buckets.find((b) => b.tag === activeTag)
    : null;

  return (
    <aside
      role="complementary"
      aria-label={t("tagsPanel.title")}
      style={{
        position: "fixed",
        insetInlineEnd: 0,
        top: 48,
        bottom: 0,
        width: 280,
        background: "hsl(var(--bg))",
        borderInlineStart: "1px solid hsl(var(--border))",
        zIndex: 70,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid hsl(var(--border))",
        }}
      >
        <Hash size={14} aria-hidden />
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {t("tagsPanel.title")}
        </span>
        <span
          style={{
            marginInlineStart: "auto",
            fontSize: 11,
            color: "hsl(var(--fg-muted))",
          }}
        >
          {index
            ? t("tagsPanel.summary", {
                tags: String(buckets.length),
                total: String(index.totalNotes),
              })
            : ""}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("tagsPanel.close")}
          title={t("tagsPanel.close")}
          style={{
            border: "none",
            background: "transparent",
            color: "hsl(var(--fg-muted))",
            cursor: "pointer",
            padding: 4,
            borderRadius: 6,
          }}
        >
          <X size={14} />
        </button>
      </header>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && !index && (
          <div
            style={{
              padding: 16,
              fontSize: 12,
              color: "hsl(var(--fg-muted))",
            }}
          >
            {t("tagsPanel.loading")}
          </div>
        )}

        {index && buckets.length === 0 && (
          <div
            style={{
              padding: 16,
              fontSize: 12,
              color: "hsl(var(--fg-muted))",
              lineHeight: 1.5,
            }}
          >
            {t("tagsPanel.emptyHint")}
          </div>
        )}

        {/* Tag chips */}
        {buckets.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: 12,
              borderBottom: "1px solid hsl(var(--border))",
            }}
            role="list"
          >
            {buckets.map((b) => (
              <button
                key={b.tag}
                type="button"
                onClick={() =>
                  setActiveTag(activeTag === b.tag ? null : b.tag)
                }
                role="listitem"
                aria-pressed={activeTag === b.tag}
                style={{
                  padding: "3px 9px",
                  borderRadius: 999,
                  fontSize: 11,
                  border: "1px solid hsl(var(--border))",
                  background:
                    activeTag === b.tag
                      ? "hsl(var(--accent) / 0.18)"
                      : "hsl(var(--bg-subtle))",
                  color:
                    activeTag === b.tag
                      ? "hsl(var(--accent))"
                      : "hsl(var(--fg))",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span>{b.tag}</span>
                <span style={{ opacity: 0.6 }}>{b.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Focused bucket — list of notes with the active tag */}
        {focusBucket && (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: "8px 0",
            }}
          >
            {focusBucket.paths.map((p) => {
              const name = p.split("/").pop()?.replace(/\.(md|markdown)$/i, "") ?? p;
              return (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent("lumen-open-file", {
                          detail: { path: p },
                        }),
                      );
                    }}
                    style={{
                      width: "100%",
                      textAlign: "start",
                      padding: "5px 14px",
                      border: "none",
                      background: "transparent",
                      color: "hsl(var(--fg))",
                      cursor: "pointer",
                      fontSize: 12.5,
                      lineHeight: 1.4,
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "hsl(var(--accent) / 0.06)")
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "transparent")
                    }
                    title={p}
                  >
                    <div style={{ fontWeight: 500 }}>{name}</div>
                    {p !== name && (
                      <div
                        style={{
                          fontSize: 10.5,
                          color: "hsl(var(--fg-muted))",
                        }}
                      >
                        {p}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Untagged notes — collapsed by default */}
        {index && index.untaggedPaths.length > 0 && !focusBucket && (
          <div style={{ padding: "10px 14px", fontSize: 11, color: "hsl(var(--fg-muted))" }}>
            {t("tagsPanel.untaggedCount", {
              count: String(index.untaggedPaths.length),
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
