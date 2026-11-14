import { useEffect, useRef, useState } from "react";
import { sanitizeSvgMarkup } from "../lib/markupSanitizer";
import { safeSetHtml } from "../lib/trustedTypes";
import { t } from "../i18n";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let initializedFor: "dark" | "light" | null = null;

async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidPromise;
  const dark = document.documentElement.classList.contains("dark");
  const wantTheme: "dark" | "light" = dark ? "dark" : "light";
  if (initializedFor !== wantTheme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? "dark" : "default",
      securityLevel: "strict",
      // Render labels as SVG <text>, not HTML inside <foreignObject>.
      // sanitizeSvgMarkup forbids foreignObject (an HTML-injection vector
      // inside SVG), so with Mermaid's default HTML labels every node /
      // edge label was silently stripped — boxes rendered empty.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      fontFamily:
        "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
      themeVariables: dark
        ? {
            background: "transparent",
            primaryColor: "#27314a",
            primaryTextColor: "#e7eaf3",
            primaryBorderColor: "#3b4760",
            lineColor: "#7c5cff",
            secondaryColor: "#1f2533",
            tertiaryColor: "#1a1f2c",
          }
        : {
            background: "transparent",
            primaryColor: "#eef2ff",
            primaryTextColor: "#0f172a",
            primaryBorderColor: "#c7d2fe",
            lineColor: "#7c5cff",
          },
    });
    initializedFor = wantTheme;
  }
  return mermaid;
}

function useThemeKey(): string {
  const [key, setKey] = useState(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setKey(
        document.documentElement.classList.contains("dark")
          ? "dark"
          : "light",
      ),
    );
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);
  return key;
}

let counter = 0;
const MAX_CACHE = 24;
const cache = new Map<string, string>();
type RenderState = "idle" | "rendering" | "ready" | "failed";

interface Props {
  source: string;
}

export default function MermaidBlock({ source }: Props) {
  // `ref` points at the inner SVG host. Using a separate ref for the
  // outer block prevents `innerHTML = …` from clobbering the React-
  // rendered chrome (status row, queued indicator, etc.).
  const ref = useRef<HTMLDivElement | null>(null);
  const blockRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RenderState>("idle");
  const [durationMs, setDurationMs] = useState<number | null>(null);
  // Defer the 2.7 MB Mermaid runtime download until the diagram is actually
  // about to enter the viewport. Long docs with mermaid blocks below the
  // fold no longer pay the cost up-front.
  const [inView, setInView] = useState(false);
  const themeKey = useThemeKey();

  useEffect(() => {
    if (!blockRef.current || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      // SSR / very old browsers — render eagerly so the doc still works.
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px 0px" }, // start fetching 300px before scroll arrives
    );
    io.observe(blockRef.current);
    return () => io.disconnect();
  }, [inView]);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    const cacheKey = `${themeKey}::${source}`;
    const cached = cache.get(cacheKey);
    setState("rendering");
    setDurationMs(null);
    setError(null);
    if (cached) {
      if (!cancelled && contentRef.current) {
        safeSetHtml(contentRef.current, cached, "svg");
        setState("ready");
      }
      return;
    }
    (async () => {
      try {
        const started = performance.now();
        const mermaid = await getMermaid();
        const id = `lumen-mermaid-${++counter}`;
        const { svg, bindFunctions } = await mermaid.render(id, source);
        if (cancelled || !contentRef.current) return;
        const cleanSvg = sanitizeSvgMarkup(svg);
        safeSetHtml(contentRef.current, cleanSvg, "svg");
        cache.set(cacheKey, cleanSvg);
        setDurationMs(Math.round(performance.now() - started));
        if (cache.size > MAX_CACHE) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
        bindFunctions?.(contentRef.current);
        setState("ready");
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, themeKey, inView]);

  if (error) {
    return (
      <div className="mermaid-block">
        <div className="mermaid-error">{t("block.mermaid.error")}{"\n"}{error}</div>
      </div>
    );
  }
  return (
    <div className="mermaid-block" ref={blockRef}>
      <div
        style={{
          padding: "0 10px 8px",
          fontSize: 11,
          color: "hsl(var(--fg-muted))",
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span>Mermaid</span>
        <span>
          {state === "ready"
            ? durationMs == null
              ? t("block.diagram.renderedCache")
              : t("block.diagram.renderedIn", { ms: durationMs })
            : state === "rendering"
              ? t("block.diagram.rendering")
              : t("block.diagram.queued")}
        </span>
      </div>
      <div ref={contentRef} />
      {!inView && (
        <div
          aria-busy="true"
          style={{
            padding: 18,
            color: "hsl(var(--fg-muted))",
            fontSize: 12,
            textAlign: "center",
          }}
        >
          {t("block.mermaid.placeholder")}
        </div>
      )}
      {/* SVG host — innerHTML is set imperatively, separate from chrome.
          width:100% so Mermaid's responsive SVG gets the full block
          width on first layout. minHeight prevents a flash where the
          host briefly collapses to 0px before the SVG lands. */}
      <div ref={ref} style={{ width: "100%", minHeight: 1 }} />
    </div>
  );
}
