import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

/**
 * Floating scroll progress indicator.
 * Shows percentage + estimated page of total on hover.
 */
export function ScrollProgress() {
  const [progress, setProgress] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [hover, setHover] = useState(false);
  const rafRef = useRef(0);

  useEffect(() => {
    function update() {
      // Find the active scrollable pane
      const preview = document.querySelector("[data-preview-root]") as HTMLElement;
      const editor = document.querySelector(".cm-scroller") as HTMLElement;
      const el = preview ?? editor;
      if (!el) return;

      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable <= 0) {
        setProgress(0);
        setTotalPages(1);
        setCurrentPage(1);
        return;
      }

      const pct = el.scrollTop / scrollable;
      setProgress(Math.round(pct * 100));

      // Estimate pages (A4 ~1000px height)
      const pageHeight = 900;
      const total = Math.max(1, Math.ceil(el.scrollHeight / pageHeight));
      const current = Math.min(total, Math.floor(el.scrollTop / pageHeight) + 1);
      setTotalPages(total);
      setCurrentPage(current);
    }

    function onScroll() {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    }

    // Attach to all scrollable panes
    const els = [
      document.querySelector("[data-preview-root]"),
      document.querySelector(".cm-scroller"),
    ].filter(Boolean) as HTMLElement[];

    els.forEach((el) => el.addEventListener("scroll", onScroll, { passive: true }));
    update();

    return () => {
      els.forEach((el) => el.removeEventListener("scroll", onScroll));
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (progress === 0 && totalPages <= 1) return null;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "fixed",
        insetInlineEnd: 16,
        bottom: 36,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 6,
        background: "hsl(var(--bg) / 0.9)",
        border: "1px solid hsl(var(--border))",
        backdropFilter: "blur(8px)",
        fontSize: 11,
        color: "hsl(var(--fg-muted))",
        cursor: "default",
        transition: "all 150ms ease",
        boxShadow: hover ? "0 4px 12px hsl(0 0% 0% / 0.2)" : "none",
      }}
    >
      {/* Progress bar */}
      <div
        style={{
          width: 30,
          height: 3,
          borderRadius: 2,
          background: "hsl(var(--border))",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: "100%",
            background: "hsl(var(--accent))",
            borderRadius: 2,
            transition: "width 100ms ease",
          }}
        />
      </div>
      <span>{progress}%</span>
      {hover && (
        <span style={{ color: "hsl(var(--fg-muted) / 0.6)" }}>
          {t("scroll.page", { current: currentPage, total: totalPages })}
        </span>
      )}
    </div>
  );
}
