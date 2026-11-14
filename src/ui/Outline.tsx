import React, { useEffect, useMemo, useRef, useState } from "react";
import { extractToc } from "../renderer/pipeline";
import { LARGE_DOC_CHARS } from "../renderer/previewDoc";
import type { IncrementalToc, TocEntry } from "../renderer/incrementalToc";
import { t } from "../i18n";
import { scrollBehavior } from "../lib/motion";
import { useAppStore } from "../store/useStore";
import { EmptyState } from "./EmptyState";
import { HelpButton } from "./HelpButton";

interface Props {
  markdownText: string;
  /** Phone width (plan 10.2.4): a bottom sheet over the editor, closed by its button or by picking a heading. */
  sheet?: boolean;
}

export const Outline = React.memo(function Outline({ markdownText, sheet = false }: Props) {
  // Debounce expensive TOC extraction.
  const [debounced, setDebounced] = useState(markdownText);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(markdownText), 200);
    return () => clearTimeout(h);
  }, [markdownText]);

  // A long document re-parses only the blocks that changed (plan 8.4);
  // the result is the same as extractToc's.
  const large = debounced.length >= LARGE_DOC_CHARS;
  const smallToc = useMemo(() => (large ? null : extractToc(debounced)), [debounced, large]);
  const incrementalRef = useRef<IncrementalToc | null>(null);
  const [largeToc, setLargeToc] = useState<TocEntry[]>([]);
  useEffect(() => {
    if (!large) return;
    let cancelled = false;
    void import("../renderer/incrementalToc").then((m) => {
      if (cancelled) return;
      const inc = (incrementalRef.current ??= new m.IncrementalToc());
      setLargeToc(inc.update(debounced));
    });
    return () => {
      cancelled = true;
    };
  }, [debounced, large]);
  const toc = smallToc ?? largeToc;

  // Scroll-spy: track which heading is currently in view within the preview pane.
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (toc.length === 0) {
      setActiveId(null);
      return;
    }
    const root = document.querySelector<HTMLElement>("[data-preview-root]");
    if (!root) return;

    const ids = toc.map((h) => h.id);
    // Track which IDs are currently intersecting.
    const visible = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).id;
          if (!id) continue;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        // Pick the first heading (in document order) that is visible.
        const firstVisible = ids.find((id) => visible.has(id));
        if (firstVisible) {
          setActiveId(firstVisible);
        } else {
          // Fall back: find the last heading above the viewport top.
          let fallback: string | null = null;
          const scrollTop = root.scrollTop;
          for (const id of ids) {
            const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
            if (el && el.offsetTop <= scrollTop + 8) fallback = id;
          }
          setActiveId(fallback);
        }
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: [0, 1] },
    );

    for (const id of ids) {
      const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [toc]);

  return (
    <aside
      className={
        sheet
          ? "outline-aside outline-sheet"
          : `
        outline-aside h-full overflow-y-auto py-3 px-1 bg-bg-subtle border-s border-border
        w-[260px] shrink-0
        max-md:hidden md:block
      `
      }
      aria-label={sheet ? t("outline.title") : undefined}
      data-testid={sheet ? "outline-sheet" : undefined}
    >
      {sheet && <div className="outline-sheet-grip" aria-hidden="true" />}
      <div className="px-2 mb-2 text-[11px] uppercase tracking-wider text-fg-muted font-semibold outline-sheet-head">
        <span>{t("outline.title")}</span>
        <HelpButton topic="workspace/panels#outline" />
        {sheet && (
          <button type="button" className="icon-btn outline-sheet-close" onClick={() => useAppStore.getState().toggleOutline()} aria-label={t("outline.close")}>
            ✕
          </button>
        )}
      </div>
      {toc.length === 0 ? (
        <EmptyState
          style={{ padding: "0 8px" }}
          message={t("outline.empty")}
          action={{ label: t("outline.addHeading"), onClick: () => window.dispatchEvent(new CustomEvent("lumen-mobile-insert", { detail: { insert: "\n# ", cursorOffset: 0 } })) }}
        />
      ) : (
        <nav aria-label={t("outline.title")}>
          {toc.map((h, i) => (
            <a
              key={i}
              href={`#${h.id}`}
              className={`outline-link h${h.depth}${activeId === h.id ? " active" : ""}`}
              aria-current={activeId === h.id ? "location" : undefined}
              // A Hebrew heading in an English UI (and the reverse) keeps
              // its own direction (T45).
              dir="auto"
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(h.id);
                if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
                // The sheet covers the text: picking a heading closes it.
                if (sheet) useAppStore.getState().toggleOutline();
              }}
            >
              {h.text}
            </a>
          ))}
        </nav>
      )}
    </aside>
  );
});
