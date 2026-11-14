/**
 * Template gallery — browse, filter, install community + first-party
 * templates from `public/templates/registry.json`. Installed templates
 * land in the workspace under `templates/<id>.md` and show up in
 * `⌘K → Templates` (see `src/commands/installedTemplates.ts`, which lists
 * that folder and refreshes on the `lumen:templates-changed` event fired
 * by `installTemplate()`).
 *
 * Layout mirrors `PluginGallery.tsx` so users moving between the two
 * surfaces have a consistent affordance.
 */

import { useEffect, useMemo, useState, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Download, Search, Star, Tag, X, Loader2, Check } from "lucide-react";
import {
  fetchMarketplaceItems,
  installTemplate,
  type MarketplaceTemplate,
} from "../storage/templateMarketplace";
import { showAiToast } from "./AiToast";
import { log } from "../lib/logger";
import { t } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

type SortKey = "rating" | "downloads" | "alphabetical";

export function TemplateGallery({ open, onClose }: Props) {
  const [templates, setTemplates] = useState<MarketplaceTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("rating");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  // Load on open. Talks to the real marketplace backend when one is
  // configured (lumen.marketplace.url / VITE_MARKETPLACE_URL) and falls back
  // to the bundled static registry offline — see templateMarketplace.ts.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetchMarketplaceItems()
      .then(setTemplates)
      .catch((e) => {
        log.error("template registry fetch failed", e);
        setError((e as Error).message);
      })
      .finally(() => setLoading(false));
  }, [open]);

  // Categories derived from the loaded registry.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates) set.add(t.category);
    return [...set].sort();
  }, [templates]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = templates.filter((t) => {
      if (activeCategory && t.category !== activeCategory) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
    list = list.slice().sort((a, b) => {
      if (sort === "rating") return b.rating - a.rating;
      if (sort === "downloads") return b.downloads - a.downloads;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [templates, query, activeCategory, sort]);

  async function handleInstall(template: MarketplaceTemplate): Promise<void> {
    setInstalling((s) => new Set(s).add(template.id));
    try {
      const { path } = await installTemplate(template);
      setInstalled((s) => new Set(s).add(template.id));
      showAiToast(
        t("templates.installed", { name: template.name, path }),
        "success",
      );
    } catch (e) {
      log.error("template install failed", e);
      showAiToast(
        t("templates.installFailed", { error: (e as Error).message }),
        "error",
      );
    } finally {
      setInstalling((s) => {
        const next = new Set(s);
        next.delete(template.id);
        return next;
      });
    }
  }

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open, onEscape: onClose });

  if (!open) return null;

  return (
    <div
      className="cmd-palette-backdrop"
      onClick={onClose}
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("templates.title")}
    >
      <div
        className="cmd-palette"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 800,
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
          <span style={{ fontSize: 18 }}>📦</span>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("templates.title")}
          </h2>
          <span
            style={{
              fontSize: 11,
              color: "hsl(var(--fg-muted))",
              marginInlineStart: "auto",
            }}
          >
            {filtered.length} / {templates.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("templates.close")}
            title={t("templates.close")}
            style={{
              border: "none",
              background: "transparent",
              color: "hsl(var(--fg-muted))",
              cursor: "pointer",
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Search + sort */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            borderBottom: "1px solid hsl(var(--border))",
          }}
        >
          <Search size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("templates.searchPlaceholder")}
            aria-label={t("templates.searchPlaceholder")}
            spellCheck={false}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              color: "hsl(var(--fg))",
              fontSize: 13,
              outline: "none",
            }}
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label={t("templates.sort")}
            style={{
              fontSize: 11,
              padding: "3px 6px",
              borderRadius: 6,
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--bg-subtle))",
              color: "hsl(var(--fg))",
            }}
          >
            <option value="rating">⭐ {t("templates.sort.rating")}</option>
            <option value="downloads">⬇ {t("templates.sort.downloads")}</option>
            <option value="alphabetical">A→Z</option>
          </select>
        </div>

        {/* Category chips */}
        {categories.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: "8px 16px",
              borderBottom: "1px solid hsl(var(--border))",
            }}
            // Use `role="group"` rather than `list` — chips are pressable
            // toggle buttons (aria-pressed), not list items.
            role="group"
            aria-label={t("templates.sort")}
          >
            <CategoryChip
              label={t("templates.allCategories")}
              active={activeCategory === null}
              onClick={() => setActiveCategory(null)}
            />
            {categories.map((c) => (
              <CategoryChip
                key={c}
                label={c}
                active={activeCategory === c}
                onClick={() =>
                  setActiveCategory(activeCategory === c ? null : c)
                }
              />
            ))}
          </div>
        )}

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 4px 12px",
          }}
        >
          {loading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: 24,
                color: "hsl(var(--fg-muted))",
                fontSize: 13,
              }}
            >
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              {t("templates.loading")}
            </div>
          )}
          {error && !loading && (
            <div
              style={{
                padding: 16,
                color: "hsl(0 80% 65%)",
                fontSize: 12,
              }}
            >
              {t("templates.error", { error })}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "hsl(var(--fg-muted))",
                fontSize: 13,
              }}
            >
              {t("templates.empty")}
            </div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {filtered.map((tpl) => (
                <li key={tpl.id} data-testid="template-card">
                  <TemplateRow
                    template={tpl}
                    installing={installing.has(tpl.id)}
                    installed={installed.has(tpl.id)}
                    onInstall={() => handleInstall(tpl)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer with submission CTA */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            borderTop: "1px solid hsl(var(--border))",
            fontSize: 11,
            color: "hsl(var(--fg-muted))",
          }}
        >
          <span>{t("templates.contribute")}</span>
          <a
            href="https://github.com/lumen-md/lumen-templates-contrib"
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "hsl(var(--accent))", textDecoration: "underline" }}
          >
            {t("templates.contributeLink")}
          </a>
        </div>
      </div>
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      // No `role="listitem"` — `aria-pressed` isn't allowed on the
      // `listitem` role per axe, and a button is a more accurate
      // semantic anyway. The parent `role="list"` still groups them.
      style={{
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 11,
        border: "1px solid hsl(var(--border))",
        background: active ? "hsl(var(--accent) / 0.18)" : "hsl(var(--bg-subtle))",
        color: active ? "hsl(var(--accent))" : "hsl(var(--fg))",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function TemplateRow({
  template,
  installing,
  installed,
  onInstall,
}: {
  template: MarketplaceTemplate;
  installing: boolean;
  installed: boolean;
  onInstall: () => void;
}) {
  return (
    <article
      style={{
        display: "flex",
        gap: 12,
        padding: "10px 16px",
        borderBottom: "1px solid hsl(var(--border) / 0.4)",
        alignItems: "flex-start",
      }}
    >
      <span style={{ fontSize: 24, flexShrink: 0, marginTop: 2 }}>
        {template.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <header
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
            {template.name}
          </h3>
          <span
            style={{
              fontSize: 10,
              color: "hsl(var(--fg-muted))",
            }}
          >
            {template.category} · {t("templates.byAuthor", { author: template.author })} · v{template.version}
          </span>
          <span
            style={{
              marginInlineStart: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              fontSize: 11,
              color: "hsl(var(--fg-muted))",
            }}
            title={t("templates.rating", { rating: String(template.rating) })}
          >
            <Star size={11} style={{ color: "hsl(40 90% 60%)" }} />
            {template.rating.toFixed(1)}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              fontSize: 11,
              color: "hsl(var(--fg-muted))",
            }}
            title={t("templates.downloads", { count: String(template.downloads) })}
          >
            <Download size={11} />
            {template.downloads}
          </span>
        </header>
        <p
          style={{
            margin: "4px 0 6px",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
            lineHeight: 1.45,
          }}
        >
          {template.description}
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            alignItems: "center",
          }}
        >
          {template.tags.map((tag) => (
            <span
              key={tag}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                padding: "1px 6px",
                borderRadius: 999,
                fontSize: 10,
                background: "hsl(var(--bg-subtle))",
                color: "hsl(var(--fg-muted))",
              }}
            >
              <Tag size={9} />
              {tag}
            </span>
          ))}
          <button
            type="button"
            onClick={onInstall}
            disabled={installing || installed}
            style={{
              marginInlineStart: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 10px",
              borderRadius: 6,
              border: "1px solid hsl(var(--accent))",
              background: installed ? "hsl(var(--accent) / 0.18)" : "transparent",
              color: "hsl(var(--accent))",
              fontSize: 11,
              fontWeight: 600,
              cursor: installing || installed ? "default" : "pointer",
            }}
          >
            {installed ? (
              <>
                <Check size={11} />
                {t("templates.installed.button")}
              </>
            ) : installing ? (
              <>
                <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
                {t("templates.installing")}
              </>
            ) : (
              <>
                <Download size={11} />
                {t("templates.install")}
              </>
            )}
          </button>
        </div>
      </div>
    </article>
  );
}
