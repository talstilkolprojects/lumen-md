/**
 * Agent review (plan 5.11), the part that is always on: once the app has
 * started it loads agents/reviewBridge, which registers the editor as the
 * document applier, counts the changes waiting for review (returned here
 * for the status-bar badge) and announces new ones with a toast whose
 * button calls `openPanel`. The panel itself is lazy (ui/AgentReviewPanel).
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import type { EditorHandle } from "../editor/Editor";

export function useAgentReview(editorRef: RefObject<EditorHandle | null>, openPanel: () => void): number {
  const [pending, setPending] = useState(0);
  const openRef = useRef(openPanel);
  openRef.current = openPanel;
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import("../agents/reviewBridge")
      .then((m) => {
        if (!cancelled) stop = m.startAgentReview({ editorRef, onPending: setPending, openPanel: () => openRef.current() });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [editorRef]);
  return pending;
}
