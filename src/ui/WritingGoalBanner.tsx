/**
 * Writing-goal banner — a thin progress strip that appears at the top of
 * the editor when the user has set a daily word goal (`writingGoalWords`).
 *
 * Counts words in the active doc, compares against the goal, and renders
 * a 2px progress bar plus a tiny "234 / 500" counter in the corner.
 * Hits 100% → flashes a confetti-coloured complete-state. Set the goal
 * to 0 (via `⌘K → Writing goal`) to hide the banner entirely.
 */

import { useMemo } from "react";
import { useAppStore } from "../store/useStore";
import { t } from "../i18n";

function countWords(s: string): number {
  // Strip code fences first — code lines aren't "writing".
  const stripped = s
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");
  // Match runs of letters / digits / Hebrew / etc.
  const matches = stripped.match(/[\p{L}\p{N}']+/gu);
  return matches ? matches.length : 0;
}

export function WritingGoalBanner() {
  const goal = useAppStore((s) => s.writingGoalWords);
  const content = useAppStore((s) => s.doc.content);
  const words = useMemo(() => countWords(content), [content]);

  if (!goal || goal <= 0) return null;
  const pct = Math.min(100, Math.round((words / goal) * 100));
  const done = words >= goal;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "relative",
        height: 22,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "0 12px",
        fontSize: 11,
        color: done ? "white" : "hsl(var(--fg-muted))",
        background: done
          ? "var(--gradient-success)"
          : "hsl(var(--bg-subtle))",
        borderBottom: "1px solid hsl(var(--border))",
        flexShrink: 0,
      }}
    >
      <span>
        {done
          ? t("writingGoal.done", { words: String(words), goal: String(goal) })
          : t("writingGoal.progress", { words: String(words), goal: String(goal), pct: String(pct) })}
      </span>
      {!done && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            insetInlineStart: 0,
            bottom: 0,
            height: 2,
            width: "100%",
            transform: `scaleX(${pct / 100})`,
            transformOrigin: "var(--progress-origin, left)",
            background: "var(--gradient-brand)",
            transition: "transform var(--duration-base) var(--ease-out)",
          }}
        />
      )}
    </div>
  );
}
