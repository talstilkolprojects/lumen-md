/**
 * Live SVG block — renders raw `<svg>` markup safely.
 *
 * Why not `htmlpreview`: an SVG-only fence is the ergonomic equivalent
 * of a Mermaid block — a one-liner `<svg viewBox="…">…</svg>` should
 * render inline without iframe boilerplate.
 */

import { useMemo } from "react";
import { sanitizeSvgMarkup } from "../lib/markupSanitizer";
import { toTrustedHTML } from "../lib/trustedTypes";
import { t } from "../i18n";

interface Props {
  source: string;
  meta?: string;
}

export default function LiveSvgBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  // Wrap before sanitizing — DOMPurify's SVG profile expects a valid
  // <svg> root. Bare `<circle>` / `<rect>` fragments would otherwise be
  // dropped entirely, marking safe input as "blocked".
  const trimmed = source.trim();
  const preWrapped = trimmed.startsWith("<svg")
    ? trimmed
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${trimmed}</svg>`;
  const sanitized = useMemo(
    () => sanitizeSvgMarkup(preWrapped),
    [preWrapped],
  );
  const isSafe = Boolean(sanitized.trim());
  const status = isSafe ? "Rendered" : "Blocked";
  const wrapped = sanitized;
  if (!isSafe) {
    return (
      <div className="chart-block">
        <div
          style={{
            marginBottom: 6,
            fontSize: 11,
            color: "hsl(0 80% 60%)",
            padding: "0 12px 8px",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>SVG</span>
          <span>{status}</span>
        </div>
        <div style={{ padding: "1rem", color: "hsl(var(--fg-muted))" }}>
          {t("block.liveSvg.empty")}
        </div>
      </div>
    );
  }
  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <div
          style={{
            fontSize: 11,
            color: "hsl(var(--fg-muted))",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>SVG</span>
          <span>{status}</span>
        </div>
      </div>
      <div
        style={{
          padding: 12,
          background: "hsl(var(--bg-subtle))",
          maxHeight: heightMatch ? Number(heightMatch[1]) : 360,
          overflow: "auto",
          textAlign: "center",
        }}
        // Routed through the `lumen` Trusted Types policy (re-sanitizes as SVG).
        dangerouslySetInnerHTML={{ __html: toTrustedHTML(wrapped, "svg") }}
      />
    </div>
  );
}
