import { useEffect, useMemo, useState } from "react";
import { sanitizeSvgMarkup } from "../lib/markupSanitizer";
import { toTrustedHTML } from "../lib/trustedTypes";
import { t } from "../i18n";
import { KrokiBlockedError, optInKroki, renderViaKroki } from "./plantumlPolicy";
import "./plantUMLBlockStrings";

interface Props {
  source: string;
}

interface Cached {
  source: string;
  svg: string;
}

type RenderState = "idle" | "rendering" | "ready" | "failed";

const MAX_CACHE = 16;
const cache = new Map<string, Cached>();

async function renderPlantUML(source: string): Promise<string> {
  const cached = cache.get(source);
  if (cached) return cached.svg;
  // Kroki public service (POST the PlantUML text, receive SVG) — only as the
  // AI policy allows, or for a diagram the user chose to send (plan 6.17).
  const svg = await renderViaKroki(source);
  cache.set(source, { source, svg });
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return svg;
}

export default function PlantUMLBlock({ source }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RenderState>("idle");
  const [durationMs, setDurationMs] = useState<number | null>(null);
  /** The policy kept this diagram on the device (no request was made). */
  const [blocked, setBlocked] = useState(false);
  /** Bumped when the user chooses to send this diagram. */
  const [sendSeq, setSendSeq] = useState(0);
  const cleanSource = useMemo(() => source.trim(), [source]);

  const statusText = (() => {
    switch (state) {
      case "rendering":
        return "Rendering…";
      case "ready":
        return durationMs == null ? "Rendered (cache)" : `Rendered in ${durationMs} ms`;
      case "failed":
        return "Render failed";
      default:
        return "Queued";
    }
  })();

  useEffect(() => {
    let cancelled = false;
    setState("rendering");
    setDurationMs(null);
    setError(null);
    setSvg(null);
    setBlocked(false);
    const cached = cache.get(cleanSource);
    if (cached) {
      setSvg(cached.svg);
      setState("ready");
      return;
    }
    const started = performance.now();
    renderPlantUML(cleanSource)
      .then((s) => {
        if (!cancelled) setSvg(sanitizeSvgMarkup(s));
        if (!cancelled) {
          setDurationMs(Math.round(performance.now() - started));
          setState("ready");
        }
      })
      .catch((e: Error) => {
        if (!cancelled && e instanceof KrokiBlockedError) {
          setBlocked(true);
          setState("idle");
          return;
        }
        if (!cancelled) {
          // raw-error-allow: the syntax error of the person's own diagram source, with its line
          setError(e.message);
          setState("failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, sendSeq]);

  if (blocked) {
    return (
      <div className="mermaid-block" data-testid="plantuml-blocked">
        <div style={{ padding: "1rem", fontSize: 13, color: "hsl(var(--fg-muted))", display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
          <span>{t("plantuml.blocked")}</span>
          <button
            type="button"
            className="icon-btn"
            data-testid="plantuml-send"
            onClick={() => {
              optInKroki(cleanSource);
              setSendSeq((n) => n + 1);
            }}
          >
            {t("plantuml.send")}
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mermaid-block">
        <div className="mermaid-error">
          {t("block.plantuml.error")}{"\n"}{error}
        </div>
      </div>
    );
  }
  if (!svg) {
    return (
      <div
        style={{
          padding: "1rem",
          margin: "1rem 0",
          border: "1px dashed hsl(var(--border-strong))",
          borderRadius: 8,
          color: "hsl(var(--fg-muted))",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        {t("block.plantuml.rendering")}
      </div>
    );
  }
  return (
    <div className="mermaid-block">
      <div
        style={{
          padding: "0 10px 8px",
          fontSize: 11,
          color: state === "failed" ? "hsl(0 80% 65%)" : "hsl(var(--fg-muted))",
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span>PlantUML</span>
        <span>{statusText}</span>
      </div>
      <div
        className="mermaid-block"
        // SVG comes from an external service (kroki.io); it was sanitized on
        // arrival and is routed through the `lumen` Trusted Types policy.
        dangerouslySetInnerHTML={{ __html: toTrustedHTML(svg, "svg") }}
      />
    </div>
  );
}
