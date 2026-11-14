/**
 * Mobile keyboard accessory bar — shows a thin scrollable row of common
 * markdown shortcuts above the on-screen keyboard so users on iOS / Android
 * don't have to leave the editor to reach for "[" or "#" keys that live on
 * a secondary keyboard layer.
 *
 * Visible only when (a) we're on a touch device, (b) the editor is focused,
 * (c) the on-screen keyboard is open. We detect the keyboard via the
 * VisualViewport API — when `viewport.height` shrinks ≥ 100 px below the
 * window's height, the keyboard is up.
 *
 * Each tap dispatches a custom event the Editor listens for and applies
 * via the exposed handle, so this component stays presentational.
 */

import { useEffect, useState } from "react";
import { t } from "../i18n";

const SHORTCUTS: { label: string; insert: string; cursorOffset?: number; ariaLabel: string }[] = [
  { label: "#", insert: "# ", ariaLabel: "Insert heading" },
  { label: "**", insert: "**bold**", cursorOffset: -2, ariaLabel: "Insert bold" },
  { label: "_", insert: "_italic_", cursorOffset: -1, ariaLabel: "Insert italic" },
  { label: "`", insert: "`code`", cursorOffset: -1, ariaLabel: "Insert inline code" },
  { label: "[]", insert: "[]()", cursorOffset: -3, ariaLabel: "Insert link" },
  { label: "[[", insert: "[[]]", cursorOffset: -2, ariaLabel: "Insert wiki link" },
  { label: "•", insert: "- ", ariaLabel: "Insert list item" },
  { label: "1.", insert: "1. ", ariaLabel: "Insert numbered item" },
  { label: "✓", insert: "- [ ] ", ariaLabel: "Insert checkbox" },
  { label: ">", insert: "> ", ariaLabel: "Insert blockquote" },
  { label: "—", insert: "\n---\n", ariaLabel: "Insert horizontal rule" },
  { label: "```", insert: "```\n\n```", cursorOffset: -4, ariaLabel: "Insert code block" },
  { label: "$", insert: "$$", cursorOffset: -1, ariaLabel: "Insert math" },
  { label: "↹", insert: "  ", ariaLabel: "Insert two spaces" },
];

export function MobileKeyboardBar() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    if (!isTouch || !window.visualViewport) return;
    const vv = window.visualViewport;
    const onResize = () => {
      const heightDiff = window.innerHeight - vv.height;
      // The on-screen keyboard pushes visualViewport.height down by ≥ 100px.
      // Anything smaller is just toolbar / address-bar UI changes.
      const focusedInTextField =
        document.activeElement?.tagName === "TEXTAREA" ||
        document.activeElement?.classList.contains("cm-content") ||
        (document.activeElement as HTMLElement | null)?.isContentEditable;
      setVisible(heightDiff > 100 && !!focusedInTextField);
    };
    vv.addEventListener("resize", onResize);
    document.addEventListener("focusin", onResize);
    document.addEventListener("focusout", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      document.removeEventListener("focusin", onResize);
      document.removeEventListener("focusout", onResize);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      role="toolbar"
      aria-label={t("mobileBar.label")}
      style={{
        position: "fixed",
        insetInlineStart: 0,
        insetInlineEnd: 0,
        bottom: window.visualViewport ? window.innerHeight - window.visualViewport.height : 0,
        height: 38,
        display: "flex",
        gap: 6,
        padding: "4px 8px",
        background: "hsl(var(--bg-subtle))",
        borderTop: "1px solid hsl(var(--border))",
        overflowX: "auto",
        whiteSpace: "nowrap",
        zIndex: 50,
        // Pin to the top of the on-screen keyboard.
        WebkitOverflowScrolling: "touch",
      }}
    >
      {SHORTCUTS.map((s) => (
        <button
          key={s.label}
          type="button"
          aria-label={s.ariaLabel}
          // `mousedown` fires before the editor loses focus — that keeps the
          // keyboard up while we insert. `click` would blur first on iOS.
          onMouseDown={(e) => {
            e.preventDefault();
            window.dispatchEvent(
              new CustomEvent("lumen-mobile-insert", {
                detail: { insert: s.insert, cursorOffset: s.cursorOffset ?? 0 },
              }),
            );
          }}
          style={{
            minWidth: 36,
            padding: "0 10px",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            background: "hsl(var(--bg))",
            color: "hsl(var(--fg))",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 13,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
