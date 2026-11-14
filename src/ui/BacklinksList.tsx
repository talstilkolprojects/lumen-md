/**
 * The backlinks, grouped by the note they come from (plan W7.3): a search
 * box, a sort (name or last modified) and a fold per note. The sort is kept
 * per device. Loaded lazily by BacklinksPanel once there are hits.
 */
import { useMemo, useState } from "react";
import { getLocale, t } from "../i18n";
import "./backlinksListStrings";
import type { BacklinkHit } from "../storage/vaultIndexCore";
import { indexedFiles } from "../storage/workspaceIndex";
import { groupBacklinks, type BacklinkSort } from "./backlinksGroup";

const SORT_KEY = "lumen.backlinks.sort";

function readSort(): BacklinkSort {
  try {
    return localStorage.getItem(SORT_KEY) === "modified" ? "modified" : "name";
  } catch {
    return "name";
  }
}

interface Props {
  hits: BacklinkHit[];
  onOpen: (fromPath: string) => void;
}

export default function BacklinksList({ hits, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BacklinkSort>(readSort);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => {
    const modified = new Map(indexedFiles().map((f) => [f.path, f.modified] as const));
    return groupBacklinks(hits, { query, sort, modified, locale: getLocale() });
  }, [hits, query, sort]);
  const changeSort = (next: BacklinkSort) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      /* private mode: this session only */
    }
  };
  const toggle = (path: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const allFolded = groups.length > 0 && groups.every((g) => folded.has(g.fromPath));
  return (
    <div className="backlinks-tools-wrap">
      <div className="backlinks-tools" style={{ display: "flex", gap: 6, padding: "6px 8px", alignItems: "center" }}>
        <input
          type="search"
          dir="auto"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("backlinksList.search")}
          aria-label={t("backlinksList.search")}
          data-testid="backlinks-search"
          style={{ flex: 1, minWidth: 0, fontSize: 12 }}
        />
        <select value={sort} onChange={(e) => changeSort(e.target.value as BacklinkSort)} aria-label={t("backlinksList.sort")} data-testid="backlinks-sort" style={{ fontSize: 12 }}>
          <option value="name">{t("backlinksList.sort.name")}</option>
          <option value="modified">{t("backlinksList.sort.modified")}</option>
        </select>
        <button
          type="button"
          className="backlink-item"
          style={{ width: "auto", fontSize: 12 }}
          onClick={() => setFolded(allFolded ? new Set() : new Set(groups.map((g) => g.fromPath)))}
        >
          {allFolded ? t("backlinksList.expandAll") : t("backlinksList.collapseAll")}
        </button>
      </div>
      {query.trim() && groups.length === 0 && (
        <div style={{ padding: "0.5rem 1rem", color: "hsl(var(--fg-muted))", fontSize: 12 }} dir="auto">
          {t("backlinksList.noMatch", { q: query.trim() })}
        </div>
      )}
      <ul className="backlinks-list" role="list" aria-label={t("backlinks.title")}>
        {groups.map((g) => {
          const open = !folded.has(g.fromPath);
          return (
            <li key={g.fromPath} role="listitem" data-testid="backlink-group">
              <button
                type="button"
                className="backlink-item"
                aria-expanded={open}
                onClick={() => toggle(g.fromPath)}
                title={g.fromPath}
                style={{ fontWeight: 600 }}
              >
                <span aria-hidden="true">{open ? "▾" : "▸"}</span> <span className="backlink-from" dir="auto">{g.fromName}</span>{" "}
                <span style={{ color: "hsl(var(--fg-muted))", fontWeight: 400 }}>{t("backlinksList.count", { n: String(g.hits.length) })}</span>
              </button>
              {open && (
                <ul role="list" style={{ listStyle: "none", margin: 0, paddingInlineStart: 12 }}>
                  {g.hits.map((h) => (
                    <li key={h.offset} role="listitem">
                      <button type="button" className="backlink-item" onClick={() => onOpen(h.fromPath)} title={h.fromPath}>
                        <span className="backlink-snippet" dir="auto">{h.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
