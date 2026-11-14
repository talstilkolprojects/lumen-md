/**
 * Saved searches in the sidebar (plan W2.12): each one opens the search
 * dialog on its query; × removes it. Renders nothing while the list is
 * empty. Its own lazy chunk (loaded by FileTree).
 */

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { t } from "../i18n";
import { SAVED_SEARCHES_CHANGED, openSearch, removeSavedSearch, savedSearches, type SavedSearch } from "../search/savedSearches";

export default function SavedSearches() {
  const [list, setList] = useState<SavedSearch[]>(() => savedSearches());
  useEffect(() => {
    const on = () => setList(savedSearches());
    window.addEventListener(SAVED_SEARCHES_CHANGED, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(SAVED_SEARCHES_CHANGED, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  if (!list.length) return null;
  return (
    <nav aria-label={t("search.savedTitle")} data-testid="saved-searches" style={{ padding: "6px 8px", borderBottom: "1px solid hsl(var(--border))" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--fg-muted))", padding: "0 4px 4px" }}>{t("search.savedTitle")}</div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {list.map((s) => (
          <li key={s.query} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              type="button"
              onClick={() => openSearch(s.query)}
              title={s.query}
              dir="auto"
              style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", color: "hsl(var(--fg))", cursor: "pointer", padding: "3px 4px", fontSize: 12, textAlign: "start" }}
            >
              <Search size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
            </button>
            <button
              type="button"
              aria-label={t("search.removeSaved", { name: s.name })}
              onClick={() => removeSavedSearch(s.query)}
              style={{ background: "transparent", border: "none", color: "hsl(var(--fg-muted))", cursor: "pointer", padding: 2, display: "flex" }}
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
