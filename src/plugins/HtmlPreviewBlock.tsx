import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Code2 } from "lucide-react";
import { t } from "../i18n";
import { sanitizeHtmlMarkup } from "../lib/markupSanitizer";
import { setSandboxedSrcdoc } from "../lib/trustedTypes";
import "./htmlPreviewBlockStrings";

interface Props {
  source: string;
  meta?: string;
}

/**
 * Live HTML/CSS/JS preview rendered inside a sandboxed iframe.
 *
 * The fence body is dropped into the iframe's `srcdoc` as-is. If the body
 * doesn't already include `<html>`, we wrap it with a minimal document so the
 * user can write just a snippet (e.g. a `<style>` + body markup) without
 * worrying about boilerplate.
 *
 * Sandboxing: scripts are disabled by default; an opt-in control is shown for
 * potentially unsafe snippets and can enable `allow-scripts` for the current
 * block when the user explicitly chooses it.
 */
export default function HtmlPreviewBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 360;
  const titleMatch = meta?.match(/title=["']([^"']+)["']/);

  const [showSource, setShowSource] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [allowScripts, setAllowScripts] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const rawHtml = useMemo(() => wrapHtml(source), [source]);
  const html = useMemo(() => sanitizeHtmlMarkup(rawHtml), [rawHtml]);
  const wasSanitized = html !== rawHtml;
  const hasUnsafePatterns = /<\s*script\b|on\w+\s*=|javascript:\s*|<\s*iframe\b|<\s*object\b|<\s*embed\b/i.test(source);
  const sandboxMode = allowScripts ? "allow-scripts" : "";

  // srcdoc is a Trusted Types sink. Assign it imperatively through the
  // `lumen` policy's sandboxed path (the frame never gets
  // allow-same-origin) instead of React's string attribute write.
  useEffect(() => {
    if (showSource || !frameRef.current) return;
    setSandboxedSrcdoc(frameRef.current, html);
  }, [html, sandboxMode, showSource]);

  // Toggle native fullscreen on the host container so the iframe still works.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = () => {
      if (!document.fullscreenElement) setFullScreen(false);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { /* why: not in fullscreen any more (the user pressed Esc first) */ });
      setFullScreen(false);
    } else {
      el.requestFullscreen().then(() => setFullScreen(true)).catch(() => { /* why: fullscreen refused (iframe policy or no user gesture): the block stays inline */ });
    }
  }

  return (
    <div className="chart-block" ref={containerRef}>
      <div className="chart-block-header">
        <span>{titleMatch?.[1] ?? t("block.htmlPreview.title")}</span>
        <div className="chart-block-tabs">
          {hasUnsafePatterns ? (
            <button
              type="button"
              className={`chart-block-tab ${allowScripts ? "active" : ""}`}
              onClick={() => setAllowScripts((v) => !v)}
              title={t("block.htmlPreview.toggleScripts")}
              aria-pressed={allowScripts}
            >
              {allowScripts ? t("block.htmlPreview.scriptsOff") : t("block.htmlPreview.scriptsOn")}
            </button>
          ) : null}
          <button
            type="button"
            className={`chart-block-tab ${showSource ? "active" : ""}`}
            onClick={() => setShowSource((v) => !v)}
            title={t("block.htmlPreview.toggleSource")}
            aria-pressed={showSource}
          >
            <Code2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.htmlPreview.source")}
          </button>
          <button
            type="button"
            className="chart-block-tab"
            onClick={toggleFullscreen}
            title={fullScreen ? t("block.htmlPreview.exitFullscreen") : t("block.htmlPreview.openFullscreen")}
          >
            <Maximize2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.htmlPreview.fullscreen")}
          </button>
        </div>
      </div>
      {showSource ? (
        <pre
          style={{
            margin: 0,
            padding: "0.75rem 1rem",
            background: "hsl(var(--bg-muted))",
            color: "hsl(var(--fg))",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 12,
            lineHeight: 1.55,
            overflow: "auto",
            maxHeight: height + 40,
            whiteSpace: "pre",
          }}
        >
          <code>{source}</code>
        </pre>
      ) : (
        wasSanitized && (
          <div
            style={{
              padding: "8px 12px",
              background: "hsl(36 90% 15% / 0.25)",
              color: "hsl(36 90% 72%)",
              borderBottom: "1px solid hsl(var(--border))",
              fontSize: 12,
            }}
          >
            {t("block.htmlPreview.sanitized")}
          </div>
        )
      )}
      {!showSource && (
        <iframe
          ref={frameRef}
          sandbox={sandboxMode}
          referrerPolicy="no-referrer"
          loading="lazy"
          title={titleMatch?.[1] ?? t("block.htmlPreview.title")}
          style={{
            width: "100%",
            height: fullScreen ? "100vh" : height,
            border: 0,
            background: "white",
            display: "block",
          }}
          />
      )}
    </div>
  );
}

const FULL_DOC_RE = /<\s*html[\s>]/i;

function wrapHtml(source: string): string {
  if (FULL_DOC_RE.test(source)) return source;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none';" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 1rem; }
</style>
</head>
<body>
${source}
</body>
</html>`;
}
