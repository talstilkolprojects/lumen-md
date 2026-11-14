import React, { useRef, useState } from "react";
import { X, FileText } from "lucide-react";
import type { DocFile } from "../store/useStore";
import { t } from "../i18n";
import { inlineDirectionOf, rovingIndex } from "../lib/logicalKeys";
import { matchShortcut } from "../lib/keyboardLayout";
import { droppedOutside } from "../desktop/window";

export interface TabItem {
  id: string;
  name: string;
  dirty: boolean;
}

interface Props {
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Reorder a tab by drag-and-drop. Indexes are relative to the `tabs` prop. */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Desktop (plan W3.9): a tab dropped outside the window moves to the window under the pointer, or a new one. */
  onDragOut?: (id: string) => void;
}

/**
 * Document-tab strip. The X-button is always visible (50% opacity until
 * hover) so users on touch devices can close a tab without first hovering.
 *
 * Drag-and-drop reorder uses HTML5 drag events: dragstart sets the source
 * index, dragover prevents default + flags the hover index for the drop
 * indicator, drop calls `onReorder`. Pointer-only — keyboard reorder is
 * surfaced via `Cmd/Ctrl+Shift+Pageup/Pagedown` keymaps elsewhere.
 */
export const DocTabs = React.memo(function DocTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onDragOut,
}: Props) {
  const [dragSrc, setDragSrc] = useState<number | null>(null);
  const [dragHover, setDragHover] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);

  /**
   * Touch reorder (plan 10.2.1): HTML5 drag doesn't start from a finger on
   * most mobile browsers. A long press (400 ms) picks the tab up, sliding
   * moves the drop marker, lifting drops it. Moving before the press ends is
   * a scroll of the tab strip, not a drag.
   */
  const startTouchDrag = (e: React.PointerEvent, idx: number) => {
    if (!onReorder || e.pointerType === "mouse") return;
    const id = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    const timer = setTimeout(() => {
      active = true;
      hoverRef.current = idx;
      setDragSrc(idx);
      setDragHover(idx);
    }, 400);
    const blockScroll = (ev: TouchEvent) => {
      if (active) ev.preventDefault();
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (!active) {
        if (Math.abs(ev.clientX - x0) > 10 || Math.abs(ev.clientY - y0) > 10) finish(false);
        return;
      }
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-tab-index]");
      const at = under ? Number(under.dataset.tabIndex) : null;
      if (at !== null && at !== hoverRef.current) {
        hoverRef.current = at;
        setDragHover(at);
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === id) finish(ev.type === "pointerup");
    };
    function finish(drop: boolean) {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.removeEventListener("touchmove", blockScroll);
      if (active && drop && hoverRef.current !== null && hoverRef.current !== idx) onReorder?.(idx, hoverRef.current);
      if (active) {
        setDragSrc(null);
        setDragHover(null);
      }
      hoverRef.current = null;
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.addEventListener("touchmove", blockScroll, { passive: false });
  };

  if (tabs.length <= 1) return null;

  return (
    <div
      className="doc-tabs"
      // Using `role="group"` rather than `tablist` — tablist mandates that
      // every direct child be a `role="tab"` (axe `aria-required-children`).
      // Each tab includes a sibling close button that ARIA spec doesn't
      // count as a tab; `group` keeps the semantic without that constraint.
      role="group"
      aria-label={t("docTabs.label")}
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 32,
        background: "hsl(var(--bg-subtle))",
        borderBottom: "1px solid hsl(var(--border))",
        overflowX: "auto",
        scrollbarWidth: "none",
        flexShrink: 0,
      }}
    >
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeId;
        const isDragSource = dragSrc === idx;
        const isDropTarget = dragHover === idx && dragSrc !== null && dragSrc !== idx;
        // We render the tab as TWO sibling buttons (body + close) inside a
        // non-interactive wrapper. axe rejects nested interactives — putting
        // a focusable close button inside a focusable role="tab" element is
        // a "nested-interactive" WCAG violation. Splitting them keeps the
        // visual layout while making each control independently reachable
        // for screen-readers + keyboard.
        return (
          <div
            key={tab.id}
            data-tab-index={idx}
            draggable={!!onReorder}
            onPointerDown={(e) => startTouchDrag(e, idx)}
            onContextMenu={(e) => {
              // A long press shouldn't open the browser's menu over the tab being dragged.
              if (dragSrc !== null) e.preventDefault();
            }}
            onMouseDown={(e) => {
              // Middle-click anywhere in the tab row = close (browser convention).
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            onDragStart={(e) => {
              if (!onReorder) return;
              setDragSrc(idx);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(idx));
            }}
            onDragOver={(e) => {
              if (!onReorder || dragSrc === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragHover !== idx) setDragHover(idx);
            }}
            onDragLeave={() => {
              if (dragHover === idx) setDragHover(null);
            }}
            onDrop={(e) => {
              if (!onReorder || dragSrc === null) return;
              e.preventDefault();
              if (dragSrc !== idx) onReorder(dragSrc, idx);
              setDragSrc(null);
              setDragHover(null);
            }}
            onDragEnd={(e) => {
              setDragSrc(null);
              setDragHover(null);
              if (onDragOut && e.dataTransfer.dropEffect === "none" && droppedOutside(e, { w: window.innerWidth, h: window.innerHeight })) onDragOut(tab.id);
            }}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "stretch",
              borderInlineEnd: "1px solid hsl(var(--border) / 0.5)",
              borderBottom: isActive
                ? "2px solid hsl(var(--accent))"
                : "2px solid transparent",
              borderInlineStart: isDropTarget
                ? "2px solid hsl(var(--accent))"
                : "2px solid transparent",
              background: isActive ? "hsl(var(--bg))" : "transparent",
              opacity: isDragSource ? 0.45 : 1,
            }}
          >
            <button
              type="button"
              // `aria-current="page"` is the recommended way to mark the
              // active tab when not using the strict tab/tablist pattern.
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(tab.id)}
              data-doc-tab=""
              onKeyDown={(e) => {
                // Cmd/Ctrl+W → close from the keyboard while focused on the tab.
                if (matchShortcut(e, "Mod+W")) {
                  e.preventDefault();
                  onClose(tab.id);
                  return;
                }
                // ←/→ move to the tab drawn on that side (reversed in RTL), Home/End to the ends.
                const strip = e.currentTarget.closest(".doc-tabs");
                const next = rovingIndex(e.key, inlineDirectionOf(strip), idx, tabs.length);
                if (next === null || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                strip?.querySelectorAll<HTMLButtonElement>("button[data-doc-tab]")[next]?.focus();
              }}
              title={tab.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 6px 0 12px",
                fontSize: 11.5,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "hsl(var(--fg))" : "hsl(var(--fg-muted))",
                background: "transparent",
                border: "none",
                cursor: onReorder ? "grab" : "pointer",
                whiteSpace: "nowrap",
                minWidth: 0,
                maxWidth: 162,
                userSelect: "none",
                fontFamily: "inherit",
              }}
            >
              <FileText size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {tab.dirty ? "● " : ""}
                {tab.name}
              </span>
            </button>
            <button
              type="button"
              title={t("docTabs.close")}
              aria-label={t("docTabs.close")}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                margin: "auto 6px auto 0",
                borderRadius: 4,
                border: "none",
                background: "transparent",
                color: "hsl(var(--fg-muted))",
                cursor: "pointer",
                flexShrink: 0,
                opacity: isActive ? 0.7 : 0.5,
                transition: "opacity var(--duration-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLElement;
                el.style.opacity = "1";
                el.style.background = "hsl(var(--fg) / 0.08)";
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLElement;
                el.style.opacity = isActive ? "0.7" : "0.5";
                el.style.background = "transparent";
              }}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
});

/** Utility: generate a unique tab ID. Mirrored in `useStore.tabIdOf`. */
export function tabId(doc: DocFile): string {
  return doc.workspaceName ?? doc.name ?? t("doc.untitled");
}
