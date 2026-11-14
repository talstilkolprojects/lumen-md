import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown, renderMarkdownFast, extractFrontmatter } from "./pipeline";
import { PreviewDocKeyContext } from "./previewDoc";
import { handleWikiLinkClick } from "./wikiLinks";
import { slug as headingSlug } from "github-slugger";
import { scheduleIdle } from "../lib/idle";
import { CopyButtonHandler } from "./components";
import { Frontmatter } from "../ui/Frontmatter";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { t } from "../i18n";

interface Props {
  markdownText: string;
  /** Identity of the document `markdownText` belongs to (see ./previewDoc). */
  docKey?: string | null;
  /** Re-render is debounced by this many ms */
  debounceMs?: number;
}

/**
 * Set once the full (Shiki/KaTeX) pipeline has completed a render in this
 * page lifetime. After that the lazy chunks are cached, so later previews
 * (mode switches, new tabs) go straight to the full pass.
 */
let fullPipelineWarm = false;

/** Synchronous plain-text pass; null if it throws (the full pass reports). */
function safeFastRender(markdownText: string): React.ReactElement | null {
  try {
    return renderMarkdownFast(markdownText);
  } catch {
    return null;
  }
}

export function Preview({ markdownText, docKey = null }: Props) {
  // First paint (A7 levers 1 + 3): render the text synchronously on the
  // very first commit with the chunk-free pipeline, so the LCP element
  // (the welcome doc's headings / paragraphs) never waits on Shiki, KaTeX
  // or a vendor chunk. Heavy blocks hydrate on their own (see
  // DeferredBlock in ./components). The full pipeline runs once the
  // browser is idle and swaps in highlighted code + math.
  const [tree, setTree] = useState<React.ReactElement | null>(() =>
    fullPipelineWarm ? null : safeFastRender(markdownText),
  );
  // The document the *displayed* tree was rendered from — it lags `docKey`
  // until the async render for the new document lands.
  const [treeDocKey, setTreeDocKey] = useState<string | null>(docKey);
  const [error, setError] = useState<string | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const seqRef = useRef(0);
  const fastTextRef = useRef<string | null>(fullPipelineWarm ? null : markdownText);

  useEffect(() => {
    const seq = ++seqRef.current;
    const isDark = () => document.documentElement.classList.contains("dark");
    const renderedFor = docKey;
    const run = () => {
      renderMarkdown(markdownText, isDark)
        .then((el) => {
          if (seq !== seqRef.current) return;
          fullPipelineWarm = true;
          setTree(el);
          setTreeDocKey(renderedFor);
          setError(null);
        })
        .catch((e: Error) => {
          if (seq !== seqRef.current) return;
          setError(e.message);
        });
    };
    if (fullPipelineWarm) {
      run();
      return;
    }
    // Cold boot: until the full pipeline has rendered once, every new
    // text (e.g. the welcome doc seeded one tick after mount) gets the
    // synchronous fast pass now and the full pass when the browser idles.
    if (fastTextRef.current !== markdownText) {
      fastTextRef.current = markdownText;
      setTree(safeFastRender(markdownText));
      setTreeDocKey(renderedFor);
    }
    return scheduleIdle(run, 1500);
  }, [markdownText, themeVersion, docKey]);

  // Re-process when theme changes so Shiki picks up the right theme tokens.
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeVersion((v) => v + 1));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  const frontmatter = useMemo(
    () => extractFrontmatter(markdownText),
    [markdownText],
  );

  return (
    // `contain: layout` isolates the preview's content growth from
    // shifting siblings. Without it, the async tree state update
    // ripples into a CLS of 0.44+ (Lighthouse audit, M-perf-1).
    <div
      className="flex-1 min-h-0 overflow-y-auto"
      data-preview-root
      // The document the displayed tree belongs to (it lags behind while a
      // newly opened note renders) — lets callers wait for the right one.
      data-preview-doc={treeDocKey ?? ""}
      style={{ contain: "layout" }}
      onClick={(e) => {
        // [[Wiki links]] without a matching heading here open the note.
        handleWikiLinkClick(
          e,
          e.currentTarget,
          async () => {
            const { listWorkspace } = await import("../storage/workspace");
            return (await listWorkspace()).map((f) => f.path);
          },
          (path, heading) =>
            window.dispatchEvent(
              new CustomEvent("lumen-open-file", {
                // A PDF takes the fragment as written (`page=3&highlight=…`,
                // plan 4.14). A note: the same slugger rehype-slug gives the
                // rendered headings (Unicode-aware: Hebrew / CJK keep their text).
                detail: /\.pdf$/i.test(path)
                  ? { path, fragment: heading ?? null }
                  : heading
                    ? { path, heading: headingSlug(heading) }
                    : { path },
              }),
            ),
        );
      }}
    >
      <CopyButtonHandler />
      {error && (
        <div
          style={{
            margin: "1rem",
            padding: "1rem",
            border: "1px solid hsl(0 80% 60% / 0.4)",
            borderRadius: "0.5rem",
            background: "hsl(0 80% 60% / 0.08)",
            color: "hsl(0 80% 70%)",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          ⚠︎ Render error: {error}
        </div>
      )}
      <div className="prose-lumen">
        <Frontmatter data={frontmatter} />
        <ErrorBoundary fallback={
          <div style={{ padding: "16px", color: "hsl(0 80% 60%)", border: "1px solid currentColor", borderRadius: "8px", margin: "16px" }}>
            <strong>{t("errorBoundary.heading")}</strong>
            <p style={{ marginTop: "4px", fontSize: "12px", opacity: 0.8 }}>{t("errorBoundary.renderDetail")}</p>
          </div>
        }>
          <PreviewDocKeyContext.Provider value={treeDocKey}>{tree}</PreviewDocKeyContext.Provider>
        </ErrorBoundary>
      </div>
    </div>
  );
}
