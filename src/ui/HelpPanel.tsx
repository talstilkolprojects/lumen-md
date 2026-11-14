/**
 * In-app help (plan W3.7): the docs, packed into the app, searched and read
 * on the device — offline. Opened by a panel's "?" (at that panel's page and
 * section), the palette's "Help", or the error screen. Links between docs
 * pages stay inside the panel; "Open on the web" goes to the docs site.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { X, Search, ExternalLink, ArrowLeft } from "lucide-react";
import { t, getLocale } from "../i18n";
import { renderMarkdownFast } from "../renderer/pipeline";
import { loadHelp, type HelpIndex, type HelpPage } from "../help/helpSearch";
import { docsBaseUrl } from "../lib/docsLinks";
import "./helpPanelStrings";

export function HelpPanel({ topic, initialQuery = "", onClose }: { topic: string; initialQuery?: string; onClose: () => void }) {
  const lang = getLocale() === "he" ? "he" : "en";
  const [index, setIndex] = useState<HelpIndex | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState<HelpPage | null>(null);
  const [anchor, setAnchor] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);

  useEffect(() => {
    let cancelled = false;
    void loadHelp(lang).then((ix) => {
      if (cancelled) return;
      setIndex(ix);
      const [slug, key] = topic.split("#");
      const p = slug !== undefined && topic ? ix.page(slug) : undefined;
      if (p) {
        setPage(p);
        setAnchor(ix.anchorFor(p.slug, key));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang, topic]);

  // Escape closes; focus goes back to what opened the help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const back = opener.current;
    if (!topic) searchRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (back instanceof HTMLElement) back.focus();
    };
  }, [onClose, topic]);

  const results = useMemo(() => (index && query.trim() ? index.search(query, 12) : []), [index, query]);
  const rendered = useMemo(() => (page ? renderPage(page) : null), [page]);

  // Scroll to the section, and move focus to the page so a screen reader reads it.
  useEffect(() => {
    if (!page || !body.current) return;
    const el = anchor ? body.current.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`) : null;
    (el ?? body.current).scrollIntoView?.({ block: "start" });
    body.current.focus();
  }, [page, anchor]);

  const open = (p: HelpPage, a = "") => {
    setPage(p);
    setAnchor(a);
    setQuery("");
  };

  // Links inside a page: other docs pages open here.
  const onBodyClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || !index) return;
    const href = a.getAttribute("href") ?? "";
    const m = /^\/(?:he\/)?([^#?]*?)\/?(?:#(.*))?$/.exec(href);
    if (!m) return;
    const target = index.page(m[1]);
    if (!target) return;
    e.preventDefault();
    open(target, m[2] ?? "");
  };

  const webUrl = page ? `${docsBaseUrl()}/${lang === "he" ? "he/" : ""}${page.slug}${page.slug ? "/" : ""}${anchor ? `#${anchor}` : ""}` : docsBaseUrl();

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} data-testid="help-panel">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
        style={{ inlineSize: "min(860px, 96vw)", blockSize: "min(82vh, 760px)", background: "hsl(var(--bg))", border: "1px solid hsl(var(--border))", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBlockEnd: "1px solid hsl(var(--border))" }}>
          {page && (
            <button type="button" onClick={() => setPage(null)} aria-label={t("help.back")} title={t("help.back")} style={iconBtn}>
              <ArrowLeft size={15} aria-hidden="true" style={{ transform: lang === "he" ? "scaleX(-1)" : undefined }} />
            </button>
          )}
          <h2 id="help-title" style={{ margin: 0, fontSize: 15, flex: 1 }} dir="auto">
            {page ? page.title : t("help.title")}
          </h2>
          <a href={webUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "hsl(var(--accent))", display: "inline-flex", gap: 4, alignItems: "center" }}>
            <ExternalLink size={12} aria-hidden="true" /> {t("help.web")}
          </a>
          <button type="button" onClick={onClose} aria-label={t("help.close")} title={t("help.close")} style={iconBtn}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div style={{ padding: "8px 14px", borderBlockEnd: "1px solid hsl(var(--border))", display: "flex", gap: 6, alignItems: "center" }}>
          <Search size={14} aria-hidden="true" style={{ color: "hsl(var(--fg-muted))" }} />
          <input
            ref={searchRef}
            type="search"
            dir="auto"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("help.search")}
            aria-label={t("help.search")}
            aria-controls="help-results"
            data-testid="help-search"
            style={{ flex: 1, fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "1px solid hsl(var(--border-strong, var(--border)))", background: "hsl(var(--bg))", color: "hsl(var(--fg))" }}
          />
          {!index && <span style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("help.loading")}</span>}
        </div>
        {query.trim() ? (
          <ul id="help-results" aria-label={t("help.results", { count: results.length })} data-testid="help-results" style={{ listStyle: "none", margin: 0, padding: 8, overflow: "auto", flex: 1 }}>
            {results.length === 0 && index && <li style={{ padding: 12, color: "hsl(var(--fg-muted))", fontSize: 13 }}>{t("help.noResults")}</li>}
            {results.map((r) => (
              <li key={r.page.slug}>
                <button type="button" onClick={() => open(r.page, r.anchor)} dir="auto" style={{ all: "unset", cursor: "pointer", display: "block", padding: "8px 10px", borderRadius: 6, inlineSize: "calc(100% - 20px)" }} data-slug={r.page.slug}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.page.title}</div>
                  <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>{r.heading !== r.page.title ? `${r.heading} · ` : ""}{r.page.description}</div>
                </button>
              </li>
            ))}
          </ul>
        ) : page ? (
          <div ref={body} tabIndex={-1} className="prose-lumen" dir={lang === "he" ? "rtl" : "ltr"} lang={lang} onClick={onBodyClick} data-testid="help-page" data-slug={page.slug} style={{ overflow: "auto", flex: 1, padding: "8px 24px 40px", maxInlineSize: "none", outline: "none" }}>
            {rendered}
          </div>
        ) : (
          <ul aria-label={t("help.contents")} style={{ listStyle: "none", margin: 0, padding: 8, overflow: "auto", flex: 1, columns: 2 }}>
            {(index?.bundle.pages ?? []).map((p) => (
              <li key={p.slug}>
                <button type="button" onClick={() => open(p)} dir="auto" style={{ all: "unset", cursor: "pointer", display: "block", padding: "4px 8px", fontSize: 13 }}>
                  {p.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The page through the app's Markdown renderer; if that fails, its sections as plain text — help must never crash. */
function renderPage(page: HelpPage) {
  try {
    return renderMarkdownFast(page.md);
  } catch {
    return (
      <>
        {page.sections.map((s, i) => (
          <section key={i}>
            {s.anchor ? <h2 id={s.anchor}>{s.heading}</h2> : null}
            <p>{s.text}</p>
          </section>
        ))}
      </>
    );
  }
}

const iconBtn = { border: "none", background: "transparent", color: "hsl(var(--fg-muted))", cursor: "pointer", padding: 4, display: "inline-flex", minInlineSize: 24, minBlockSize: 24, alignItems: "center", justifyContent: "center" } as const;

export default HelpPanel;
