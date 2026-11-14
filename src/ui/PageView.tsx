import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Preview } from "../renderer/Preview";
import { t } from "../i18n";
import { scrollBehavior } from "../lib/motion";

/**
 * Word-style paginated page view with page numbers and navigation.
 * Renders markdown as A4-like pages with page numbers.
 */

const PAGE_HEIGHT = 1056; // A4 at 96dpi ~ 1056px
const PAGE_WIDTH = 816; // A4 width at 96dpi
const PAGE_PADDING = 72; // 1-inch margins
const CONTENT_HEIGHT = PAGE_HEIGHT - PAGE_PADDING * 2; // = 912px

interface Props {
  markdownText: string;
  docKey?: string | null;
}

export function PageView({ markdownText, docKey = null }: Props) {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const measuringRef = useRef<HTMLDivElement>(null);

  // Measure content height to determine page count
  useEffect(() => {
    if (!measuringRef.current) return;
    const observer = new ResizeObserver(() => {
      const height = measuringRef.current?.scrollHeight ?? 0;
      setTotalPages(Math.max(1, Math.ceil(height / CONTENT_HEIGHT)));
    });
    observer.observe(measuringRef.current);
    return () => observer.disconnect();
  }, [markdownText]);

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(totalPages, page));
      setCurrentPage(clamped);
      if (containerRef.current) {
        containerRef.current.scrollTo({
          top: (clamped - 1) * (PAGE_HEIGHT + 40),
          behavior: scrollBehavior(),
        });
      }
    },
    [totalPages],
  );

  const pageNumbers = useMemo(() => {
    const pages: number[] = [];
    for (let i = 1; i <= totalPages; i++) pages.push(i);
    return pages;
  }, [totalPages]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Navigation bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid hsl(var(--border))",
          width: "100%",
          background: "hsl(var(--bg))",
          fontSize: 12,
          color: "hsl(var(--fg-muted))",
          flexShrink: 0,
        }}
      >
        <button
          className="icon-btn"
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label={t("pageView.prev")}
          title={t("pageView.prev")}
          style={{ padding: "2px 8px", fontSize: 11 }}
        >
          <span aria-hidden>◀</span>
        </button>
        <select
          value={currentPage}
          onChange={(e) => goToPage(Number(e.target.value))}
          aria-label={t("pageView.jump")}
          style={{
            background: "hsl(var(--bg-subtle))",
            color: "hsl(var(--fg))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 4,
            padding: "2px 6px",
            fontSize: 11,
          }}
        >
          {pageNumbers.map((p) => (
            <option key={p} value={p}>
              {t("pageView.page", { n: p })}
            </option>
          ))}
        </select>
        <span>{t("pageView.of", { total: totalPages })}</span>
        <button
          className="icon-btn"
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label={t("pageView.next")}
          title={t("pageView.next")}
          style={{ padding: "2px 8px", fontSize: 11 }}
        >
          <span aria-hidden>▶</span>
        </button>
      </div>

      {/* Hidden measuring div */}
      <div
        ref={measuringRef}
        style={{
          position: "absolute",
          visibility: "hidden",
          width: PAGE_WIDTH - PAGE_PADDING * 2,
          pointerEvents: "none",
        }}
      >
        <Preview markdownText={markdownText} docKey={docKey} />
      </div>

      {/* Page container */}
      <div
        ref={containerRef}
        onScroll={() => {
          if (!containerRef.current) return;
          const scrollTop = containerRef.current.scrollTop;
          const page = Math.floor(scrollTop / (PAGE_HEIGHT + 40)) + 1;
          const clamped = Math.max(1, Math.min(totalPages, page));
          if (clamped !== currentPage) {
            setCurrentPage(clamped);
          }
        }}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "24px 0",
          background: "hsl(var(--bg-subtle) / 0.5)",
        }}
      >
        {/* Render pages */}
        {pageNumbers.map((pageNum) => (
          <div
            key={pageNum}
            style={{
              width: PAGE_WIDTH,
              minHeight: PAGE_HEIGHT,
              margin: "0 auto 40px",
              background: "hsl(var(--bg))",
              boxShadow: "0 2px 12px hsl(0 0% 0% / 0.15), 0 0 0 1px hsl(var(--border) / 0.3)",
              borderRadius: 2,
              padding: PAGE_PADDING,
              position: "relative",
              overflow: "hidden",
            }}
          >
            {/* Page content (CSS clip) */}
            <div
              style={{
                position: "absolute",
                top: PAGE_PADDING,
                left: PAGE_PADDING,
                right: PAGE_PADDING,
                bottom: PAGE_PADDING,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  transform: `translateY(-${(pageNum - 1) * CONTENT_HEIGHT}px)`,
                }}
              >
                <Preview markdownText={markdownText} docKey={docKey} />
              </div>
            </div>

            {/* Page number footer */}
            <div
              style={{
                position: "absolute",
                bottom: 24,
                left: 0,
                right: 0,
                textAlign: "center",
                fontSize: 10,
                color: "hsl(var(--fg-muted) / 0.4)",
                fontFamily: "Georgia, serif",
              }}
            >
              {pageNum}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
