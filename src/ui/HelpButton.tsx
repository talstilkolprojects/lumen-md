/**
 * The "?" of a panel (plan W3.7): opens the in-app help at the page and
 * section that explain that panel. Tiny and eager — the help panel itself
 * and the packed docs load only when it is pressed.
 */
import { t } from "../i18n";

export const OPEN_HELP_EVENT = "lumen:open-help";

/** `page#section`: a docs slug and the English anchor of one of its sections. */
export type HelpTopic = string;

export function openHelp(topic: HelpTopic = "", query = ""): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT, { detail: { topic, query } }));
}

export function HelpButton({ topic, size = 22 }: { topic: HelpTopic; size?: number }) {
  return (
    <button
      type="button"
      className="lumen-help-btn"
      data-help-topic={topic}
      aria-label={t("help.button")}
      title={t("help.button")}
      onClick={(e) => {
        e.stopPropagation();
        openHelp(topic);
      }}
      style={{
        inlineSize: Math.max(24, size),
        blockSize: Math.max(24, size),
        borderRadius: "50%",
        border: "1px solid hsl(var(--border))",
        background: "transparent",
        color: "hsl(var(--fg-muted))",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 700,
        lineHeight: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        padding: 0,
      }}
    >
      ?
    </button>
  );
}
