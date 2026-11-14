import { useEffect, useState } from "react";
import { LARGE_DOC_CHARS } from "../renderer/previewDoc";

/**
 * `text` itself for an ordinary document; for a long one (plan 8.4) the
 * text as it was when typing last paused for `delayMs`, so whole-document
 * work (word counts, suggestion counts) runs once per pause, not once per
 * keystroke.
 */
export function useSettledText(text: string, delayMs = 300): string {
  const large = text.length >= LARGE_DOC_CHARS;
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (!large) return;
    const h = setTimeout(() => setSettled(text), delayMs);
    return () => clearTimeout(h);
  }, [text, large, delayMs]);
  return large ? settled : text;
}
