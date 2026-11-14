import { headingSlugger } from "../lib/slug";
import { countWords } from "../text/hebrew";
import { useEffect, useMemo, useState, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Search, Download, Trash2, ExternalLink, BadgeCheck } from "lucide-react";
import { getRegisteredPlugins, registerPlugin, unregisterPlugin } from "../plugins/pluginSystem";
import type { LumenPlugin } from "../plugins/pluginSystem";
import { log } from "../lib/logger";
import { t } from "../i18n";
import { fetchWithRetry } from "../lib/fetchRetry";

interface RemotePluginEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  version: string;
  icon?: string;
  url?: string;
  category?: string;
  homepage?: string;
  /** When true, the plugin is verified by the Lumen team. */
  verified?: boolean;
}

/**
 * Community Plugin Gallery — browse, install, and manage plugins.
 */

// ── Built-in Community Plugins Catalog ──────────────────────────────────

const COMMUNITY_PLUGINS: LumenPlugin[] = [
  {
    id: "community.reading-time",
    name: "Reading Time",
    version: "1.0.0",
    description: "Shows estimated reading time in the toolbar",
    author: "Lumen Community",
    activate: (api) => {
      api.registerCommand({
        id: "reading-time.show",
        label: "📖 Reading Time",
        hint: "Show estimated reading time",
        action: () => {
          const content = api.getContent();
          const words = countWords(content);
          const minutes = Math.ceil(words / 200);
          api.showToast(t("toast.minReadWords", { minutes, words }));
        },
      });
    },
  },
  {
    id: "community.emoji-picker",
    name: "Emoji Picker",
    version: "1.0.0",
    description: "Insert emoji via command palette",
    author: "Lumen Community",
    activate: (api) => {
      const emojis = ["😀", "🎉", "🚀", "✨", "💡", "🔥", "❤️", "⭐", "📝", "🎯", "💪", "🌟"];
      for (const emoji of emojis) {
        api.registerCommand({
          id: `emoji.${emoji}`,
          label: `Insert ${emoji}`,
          hint: "Emoji",
          action: () => {
            const content = api.getContent();
            api.setContent(content + emoji);
          },
        });
      }
    },
  },
  {
    id: "community.lorem-ipsum",
    name: "Lorem Ipsum Generator",
    version: "1.0.0",
    description: "Generate placeholder text for drafts",
    author: "Lumen Community",
    activate: (api) => {
      api.registerCommand({
        id: "lorem.generate",
        label: "📄 Lorem Ipsum",
        hint: "Generate placeholder text",
        action: () => {
          const lorem = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.";
          const content = api.getContent();
          api.setContent(content + "\n\n" + lorem);
          api.showToast(t("toast.loremIpsumInserted"));
        },
      });
    },
  },
  {
    id: "community.markdown-lint",
    name: "Markdown Linter",
    version: "1.0.0",
    description: "Basic markdown style checks",
    author: "Lumen Community",
    activate: (api) => {
      api.registerCommand({
        id: "lint.check",
        label: "🔍 Lint Markdown",
        hint: "Check for common issues",
        action: () => {
          const content = api.getContent();
          const issues: string[] = [];
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > 120) issues.push(`Line ${i + 1}: exceeds 120 chars`);
            if (lines[i].match(/^#+[^ ]/)) issues.push(`Line ${i + 1}: missing space after #`);
            if (lines[i].match(/  $/)) issues.push(`Line ${i + 1}: trailing whitespace`);
          }
          if (issues.length === 0) {
            api.showToast(t("toast.noIssuesFound"));
          } else {
            api.showToast(t("toast.issues", { count: issues.length, list: issues.slice(0, 3).join(", ") }));
          }
        },
      });
    },
  },
  {
    id: "community.focus-mode",
    name: "Focus Mode",
    version: "1.0.0",
    description: "Distraction-free writing with dimmed UI",
    author: "Lumen Community",
    activate: (api) => {
      let active = false;
      api.registerCommand({
        id: "focus.toggle",
        label: "🧘 Focus Mode",
        hint: "Toggle distraction-free writing",
        action: () => {
          active = !active;
          document.body.classList.toggle("focus-mode", active);
          api.showToast(active ? "🧘 Focus mode ON" : "Focus mode OFF");
        },
      });
    },
  },
  {
    id: "community.toc-generator",
    name: "Table of Contents",
    version: "1.0.0",
    description: "Generate a table of contents from headings",
    author: "Lumen Community",
    activate: (api) => {
      api.registerCommand({
        id: "toc.generate",
        label: "📋 Generate Table of Contents",
        hint: "From headings",
        action: () => {
          const content = api.getContent();
          const headings = content.match(/^#{1,6}\s+.+$/gm) || [];
          if (headings.length === 0) {
            api.showToast(t("toast.noHeadingsFound"));
            return;
          }
          const slugger = headingSlugger();
          const toc = headings.map((h) => {
            const level = h.match(/^#+/)![0].length;
            const text = h.replace(/^#+\s+/, "");
            const slug = slugger.slug(text);
            return `${"  ".repeat(level - 1)}- [${text}](#${slug})`;
          }).join("\n");
          api.setContent("## Table of Contents\n\n" + toc + "\n\n---\n\n" + content);
          api.showToast(t("toast.tocInsertedAtTop"));
        },
      });
    },
  },
];

// ── Gallery Component ───────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

export function PluginGallery({ open, onClose }: Props) {
  const [installed, setInstalled] = useState<Set<string>>(
    () => new Set(getRegisteredPlugins().map((p) => p.id)),
  );
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [remotePlugins, setRemotePlugins] = useState<LumenPlugin[]>([]);
  const [remoteRaw, setRemoteRaw] = useState<RemotePluginEntry[]>([]);

  // Lazy-load the registry.json once when the gallery first opens. Hooks must
  // live at the top level — the previous `import("react").then(useEffect)`
  // call was a runtime trap that React tolerated by accident.
  useEffect(() => {
    if (!open) return;
    // AbortController + cancelled guard — closing the gallery mid-fetch
    // both stops the network request and short-circuits the .then chain
    // so we never `setState` on an unmounted component.
    const ac = new AbortController();
    let cancelled = false;
    fetchWithRetry(
      "/plugins/registry.json",
      { signal: ac.signal },
      { label: "plugins.registry", maxRetries: 2, baseDelayMs: 500, maxDelayMs: 2000 },
    )
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.plugins) return;
        const entries = data.plugins as RemotePluginEntry[];
        setRemoteRaw(entries);
        const mapped: LumenPlugin[] = entries.map((p) => ({
          id: p.id,
          name: `${p.icon ?? "🔌"} ${p.name}`,
          version: p.version,
          description: p.description,
          author: p.author,
          activate: async (api) => {
            // Sandbox + script injection comes in a follow-up — for now we
            // simulate the install/activation flow so the UX exists.
            await new Promise((resolve) => setTimeout(resolve, 400));
            api.showToast(t("toast.loadedFromRemoteModule", { name: p.name }));
          },
        }));
        setRemotePlugins(mapped);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        log.warn("plugin remote load failed", err);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [open]);

  const allAvailable = useMemo(() => [...COMMUNITY_PLUGINS, ...remotePlugins], [remotePlugins]);

  // Index categories for the side rail. Built-ins live in "Community";
  // remote-registry plugins surface their declared category (or "Featured").
  //
  // This hook must run on every render, including the closed one: the
  // gallery is mounted with `open={false}` from App and flipped open
  // later, and a hook that only ran once open made React throw
  // "Rendered more hooks than during the previous render" the first
  // time the gallery was opened. Every hook stays above the early return.
  const categoryIndex = useMemo(() => {
    const map = new Map<string, number>();
    map.set("all", allAvailable.length);
    map.set("community", COMMUNITY_PLUGINS.length);
    for (const r of remoteRaw) {
      const c = r.category ?? "featured";
      map.set(c, (map.get(c) ?? 0) + 1);
    }
    return map;
  }, [allAvailable.length, remoteRaw]);

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open, onEscape: onClose });

  if (!open) return null;

  const matchesCategory = (id: string): boolean => {
    if (activeCategory === "all") return true;
    if (activeCategory === "community") return id.startsWith("community.");
    const remote = remoteRaw.find((r) => r.id === id);
    return (remote?.category ?? "featured") === activeCategory;
  };

  const verifiedById = new Map(remoteRaw.map((r) => [r.id, r.verified ?? true]));

  const filtered = allAvailable.filter((p) => {
    if (!matchesCategory(p.id)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      (p.description ?? "").toLowerCase().includes(q) ||
      (p.author ?? "").toLowerCase().includes(q)
    );
  });

  const handleInstall = async (plugin: LumenPlugin) => {
    await registerPlugin(plugin);
    setInstalled(new Set([...installed, plugin.id]));
  };

  const handleUninstall = (pluginId: string) => {
    unregisterPlugin(pluginId);
    const next = new Set(installed);
    next.delete(pluginId);
    setInstalled(next);
  };

  const categories: { id: string; label: string }[] = [
    { id: "all", label: "All plugins" },
    { id: "community", label: "Community" },
    { id: "featured", label: "Featured" },
    ...Array.from(categoryIndex.keys())
      .filter((c) => c !== "all" && c !== "community" && c !== "featured")
      .map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
  ];

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-gallery-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(8px)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "hsl(var(--bg))",
          border: "1px solid hsl(var(--border))",
          borderRadius: 16,
          width: 880,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "min(820px, calc(100vh - 32px))",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid hsl(var(--border))",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 22 }} aria-hidden>🔌</span>
          <div>
            <div id="plugin-gallery-title" style={{ fontWeight: 700, fontSize: 16 }}>
              {t("pluginGallery.title")}
            </div>
            <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
              {t("pluginGallery.counts", { installed: installed.size, available: allAvailable.length })}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <Search
              size={14}
              aria-hidden
              style={{
                position: "absolute",
                insetInlineStart: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "hsl(var(--fg-muted))",
              }}
            />
            <input
              type="text"
              placeholder={t("pluginGallery.search")}
              aria-label={t("pluginGallery.search")}
              data-testid="plugin-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                background: "hsl(var(--bg-subtle))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                // Room for the search icon on the inline-start side (mirrors in RTL).
                padding: "7px 12px",
                paddingInlineStart: 30,
                fontSize: 13,
                color: "hsl(var(--fg))",
                width: 240,
                outline: "none",
              }}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("pluginGallery.close")}
            style={{
              background: "transparent",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              color: "hsl(var(--fg))",
              padding: "5px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Esc
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* Side rail — categories */}
          <nav
            aria-label={t("pluginGallery.categoriesLabel")}
            style={{
              width: 200,
              borderInlineEnd: "1px solid hsl(var(--border))",
              padding: "12px 8px",
              overflow: "auto",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "hsl(var(--fg-muted))",
                padding: "4px 10px 6px",
              }}
            >
              {t("pluginGallery.categories")}
            </div>
            {categories.map((c) => {
              const isActive = activeCategory === c.id;
              const count = categoryIndex.get(c.id) ?? 0;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveCategory(c.id)}
                  aria-pressed={isActive}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "7px 10px",
                    borderRadius: 6,
                    border: "none",
                    background: isActive ? "hsl(var(--accent) / 0.12)" : "transparent",
                    color: isActive ? "hsl(var(--accent))" : "hsl(var(--fg))",
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "start",
                    marginBottom: 2,
                  }}
                >
                  <span>{c.label}</span>
                  <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{count}</span>
                </button>
              );
            })}
          </nav>

          {/* Plugin grid */}
          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: 16,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
              alignContent: "start",
            }}
          >
            {filtered.length === 0 ? (
              <div
                style={{
                  gridColumn: "1 / -1",
                  textAlign: "center",
                  padding: "40px 20px",
                  color: "hsl(var(--fg-muted))",
                  fontSize: 13,
                }}
              >
                {t("pluginGallery.noMatch")}
              </div>
            ) : (
              filtered.map((plugin) => {
                const isInstalled = installed.has(plugin.id);
                const verified = verifiedById.get(plugin.id) ?? plugin.id.startsWith("community.");
                return (
                  <div
                    key={plugin.id}
                    data-testid="plugin-card"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      padding: 14,
                      borderRadius: 12,
                      background: "hsl(var(--bg-subtle) / 0.5)",
                      border: "1px solid hsl(var(--border))",
                      transition: "all 150ms ease",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <div
                        aria-hidden
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: 8,
                          background: "linear-gradient(135deg, #7c5cfc, #c084fc)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 18,
                          flexShrink: 0,
                        }}
                      >
                        🔌
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontWeight: 600,
                            fontSize: 14,
                          }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {plugin.name}
                          </span>
                          {verified && (
                            <BadgeCheck
                              size={14}
                              aria-label={t("pluginGallery.verified")}
                              style={{ color: "hsl(var(--accent))", flexShrink: 0 }}
                            />
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>
                          v{plugin.version} · {plugin.author}
                        </div>
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "hsl(var(--fg-muted))",
                        lineHeight: 1.45,
                        minHeight: 32,
                      }}
                    >
                      {plugin.description}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() =>
                          isInstalled ? handleUninstall(plugin.id) : handleInstall(plugin)
                        }
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          padding: "7px 10px",
                          borderRadius: 8,
                          border: "none",
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 600,
                          background: isInstalled
                            ? "hsl(var(--border))"
                            : "linear-gradient(135deg, #7c5cfc, #c084fc)",
                          color: isInstalled ? "hsl(var(--fg))" : "white",
                          transition: "all 150ms ease",
                        }}
                      >
                        {isInstalled ? <Trash2 size={12} /> : <Download size={12} />}
                        {isInstalled ? t("pluginGallery.uninstall") : t("pluginGallery.install")}
                      </button>
                      {(() => {
                        const remote = remoteRaw.find((r) => r.id === plugin.id);
                        const homepage = remote?.homepage;
                        if (!homepage) return null;
                        return (
                          <a
                            href={homepage}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t("pluginGallery.homepage", { name: plugin.name })}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              padding: "7px 10px",
                              borderRadius: 8,
                              border: "1px solid hsl(var(--border))",
                              color: "hsl(var(--fg))",
                              fontSize: 12,
                              textDecoration: "none",
                            }}
                          >
                            <ExternalLink size={12} />
                          </a>
                        );
                      })()}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "10px 20px",
            borderTop: "1px solid hsl(var(--border))",
            textAlign: "center",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
          }}
        >
          {t("pluginGallery.comingSoon")}{" "}
          <a
            href="https://github.com/talstilkol/lumen-md"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "hsl(var(--accent))" }}
          >
            {t("pluginGallery.submit")}
          </a>
        </div>
      </div>
    </div>
  );
}
