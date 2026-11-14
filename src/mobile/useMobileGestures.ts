/**
 * Phone gestures in the app (plan W1.25): edge swipes for the side panels,
 * long notes opening in reading view, and a tap on reading view to edit
 * there. The rules are in ./gestures.ts; this file only listens and acts.
 */

import { useEffect, useRef } from "react";
import { isNarrowScreen, useAppStore, type ViewMode } from "../store/useStore";
import { classifySwipe, isTap, lineForTap, opensInReading, type Stroke } from "./gestures";

const isTouchScreen = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
const isPhone = () => isTouchScreen() && isNarrowScreen();
const rtl = () => document.documentElement.dir === "rtl";

/** Swipe in from the start edge for the file tree, from the end edge for the outline; swipe a panel back to close it. */
export function useEdgeSwipes(): void {
  useEffect(() => {
    let start: { x: number; y: number; t: number; id: number; onPanel: "start" | "end" | null } | null = null;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !isPhone()) return;
      const target = e.target as Element | null;
      const onPanel = target?.closest?.(".file-tree") ? "start" : target?.closest?.('[data-testid="outline-sheet"]') ? "end" : null;
      start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, onPanel };
    };
    const up = (e: PointerEvent) => {
      const s = start;
      start = null;
      if (!s || e.pointerId !== s.id) return;
      const st = useAppStore.getState();
      const open = { start: st.showWorkspace && s.onPanel === "start", end: st.outlineSheet && s.onPanel === "end" };
      const stroke: Stroke = { x0: s.x, y0: s.y, x1: e.clientX, y1: e.clientY, ms: performance.now() - s.t };
      // A panel closes only by a swipe that starts on it; it opens only from the edge.
      const action = classifySwipe(stroke, window.innerWidth, rtl(), open);
      if (action === "open-start" && !st.showWorkspace) st.toggleWorkspace();
      else if (action === "close-start" && st.showWorkspace) st.toggleWorkspace();
      else if (action === "open-end" && !st.outlineSheet) st.toggleOutline();
      else if (action === "close-end" && st.outlineSheet) st.toggleOutline();
    };
    const cancel = () => {
      start = null;
    };
    window.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointerup", up, { passive: true });
    window.addEventListener("pointercancel", cancel, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);
}

/** The editing mode a tap on reading view returns to: the one the user last edited in. */
let lastEditMode: Exclude<ViewMode, "preview" | "split"> = "source";

/**
 * On a phone, a note with `readingWords` words or more opens in reading
 * view (setting: Settings → Mobile → Open long notes for reading). Keyed on
 * the note's identity, so typing into a note never flips the view.
 */
export function useLongNotesOpenForReading(noteKey: string | null, content: string): void {
  const seen = useRef<string | null>(null);
  const mode = useAppStore((s) => s.mode);
  useEffect(() => {
    if (mode === "source" || mode === "wysiwyg") lastEditMode = mode;
  }, [mode]);
  useEffect(() => {
    if (!noteKey || seen.current === noteKey) return;
    seen.current = noteKey;
    const st = useAppStore.getState();
    if (st.mode === "preview") return;
    if (opensInReading(content, { phone: isPhone(), enabled: st.readLongNotes, words: st.readingWords })) st.setMode("preview");
    // `content` is read once per note, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteKey]);
}

/** What a tap must not turn into editing: links, controls, embeds, a selection in progress. */
const INTERACTIVE = "a, button, input, select, textarea, summary, label, video, audio, iframe, [role='button'], [contenteditable='true'], .katex, .mermaid, [data-no-tap-edit]";
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption";

/**
 * Props for the reading-view container: on a phone, a tap on the text (not
 * on a link or a control) switches to editing with the cursor on that line.
 */
export function tapToEditHandlers(getSource: () => string): { onPointerDown: (e: React.PointerEvent) => void; onPointerUp: (e: React.PointerEvent) => void } {
  let down: { x: number; y: number; t: number } | null = null;
  return {
    onPointerDown: (e) => {
      down = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    },
    onPointerUp: (e) => {
      const d = down;
      down = null;
      if (!d || !isPhone() || !useAppStore.getState().readLongNotes) return;
      if (!isTap({ x0: d.x, y0: d.y, x1: e.clientX, y1: e.clientY, ms: performance.now() - d.t })) return;
      const target = e.target as Element;
      if (target.closest(INTERACTIVE) || (window.getSelection()?.toString() ?? "") !== "") return;
      const block = target.closest(BLOCK);
      const root = e.currentTarget as HTMLElement;
      if (!block || !root.contains(block)) return;
      let headingIndex = -1;
      for (const h of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
        if (h === block || h.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) headingIndex++;
        else break;
      }
      const line = lineForTap(getSource(), { headingIndex, text: block.textContent ?? "" });
      useAppStore.getState().setMode(lastEditMode);
      // The source editor loads lazily; lumen-reveal-line waits for it.
      window.dispatchEvent(new CustomEvent("lumen-reveal-line", { detail: { line, content: getSource(), select: false } }));
    },
  };
}
