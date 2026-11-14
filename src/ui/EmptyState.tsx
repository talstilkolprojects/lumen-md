/**
 * An empty state (plan W3.2): one short sentence on why there is nothing
 * here, and one action that changes it. A person meets empty panels before
 * anything else; each one should show the way out, not only the void.
 *
 * scripts/check-empty-states.mjs fails CI when an empty-state string
 * (`*.empty`, `*.none`, `*.noMatches`, …) is rendered outside <EmptyState>.
 */
import type { CSSProperties, ReactNode } from "react";
import { t } from "../i18n";
import { openHelp, type HelpTopic } from "./HelpButton";

export interface EmptyAction {
  label: string;
  onClick: () => void;
}

interface Props {
  message: ReactNode;
  /** Required: an empty state without a way out is what this component exists to prevent. */
  action: EmptyAction;
  testId?: string;
  style?: CSSProperties;
}

export function EmptyState({ message, action, testId, style }: Props) {
  return (
    <div
      role="status"
      data-testid={testId ?? "empty-state"}
      style={{ padding: 16, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: 1.5, color: "hsl(var(--fg-muted))", ...style }}
    >
      <div dir="auto">{message}</div>
      <button
        type="button"
        data-testid="empty-state-action"
        onClick={action.onClick}
        style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "hsl(var(--accent))", cursor: "pointer" }}
      >
        {action.label}
      </button>
    </div>
  );
}

/** Run a palette command by id (App listens for `lumen-run-command`). */
export function runCommand(id: string): void {
  window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id } }));
}

/**
 * The way out of an empty state that fills as you work (highlights you make,
 * cards you mark, notes you tag): the help section that says how.
 */
export function learnHow(topic: HelpTopic): EmptyAction {
  return { label: t("empty.learnHow"), onClick: () => openHelp(topic) };
}
