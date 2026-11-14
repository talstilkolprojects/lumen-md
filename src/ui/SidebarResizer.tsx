import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

const STORAGE_KEY = "lumen-sidebar-width";
const MIN = 160;
const MAX = 480;
/** Arrow-key step (Shift: 3×). */
const STEP = 16;

const currentWidth = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"), 10) || 240;

function setWidth(px: number): number {
  const next = Math.max(MIN, Math.min(MAX, Math.round(px)));
  document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* why: storage denied: the width still applies for this session */
  }
  return next;
}

/**
 * Vertical drag handle that resizes the workspace sidebar by mutating the
 * `--sidebar-width` CSS variable on the document root. Width is persisted.
 */
export function SidebarResizer() {
  const [dragging, setDragging] = useState(false);
  const [width, setWidthState] = useState(240);
  const startXRef = useRef(0);
  const startWidthRef = useRef(240);

  // Restore saved width on mount.
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? Number(raw) : NaN;
    if (Number.isFinite(saved) && saved >= MIN && saved <= MAX) {
      document.documentElement.style.setProperty(
        "--sidebar-width",
        `${saved}px`,
      );
    }
    setWidthState(currentWidth());
  }, []);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: PointerEvent) {
      const isRTL = document.documentElement.getAttribute("dir") === "rtl";
      const delta = (e.clientX - startXRef.current) * (isRTL ? -1 : 1);
      const next = Math.max(MIN, Math.min(MAX, startWidthRef.current + delta));
      document.documentElement.style.setProperty(
        "--sidebar-width",
        `${next}px`,
      );
    }
    function onUp() {
      setDragging(false);
      const cur = getComputedStyle(document.documentElement).getPropertyValue(
        "--sidebar-width",
      );
      const px = parseInt(cur, 10);
      if (Number.isFinite(px)) {
        localStorage.setItem(STORAGE_KEY, String(px));
        setWidthState(px);
      }
    }
    // Pointer events (plan 10.2.1): mouse, touch and pen drag the edge alike.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  return (
    <div
      className={`sidebar-resizer ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      // Keyboard (plan 10.1.2): a focusable splitter. Arrows move the edge in
      // their own direction (so in RTL, ← widens the sidebar on the right),
      // Shift moves 3×, Home / End go to the narrowest / widest.
      tabIndex={0}
      aria-label={t("a11y.sidebarResizer")}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={width}
      onKeyDown={(e) => {
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const step = e.shiftKey ? STEP * 3 : STEP;
        let next: number | null = null;
        if (e.key === "ArrowRight") next = currentWidth() + (rtl ? -step : step);
        else if (e.key === "ArrowLeft") next = currentWidth() + (rtl ? step : -step);
        else if (e.key === "Home") next = MIN;
        else if (e.key === "End") next = MAX;
        if (next === null) return;
        e.preventDefault();
        setWidthState(setWidth(next));
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        startXRef.current = e.clientX;
        const cur = getComputedStyle(
          document.documentElement,
        ).getPropertyValue("--sidebar-width");
        startWidthRef.current = parseInt(cur, 10) || 240;
        setDragging(true);
        e.preventDefault();
      }}
    />
  );
}
