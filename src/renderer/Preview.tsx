import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown, renderMarkdownFast, extractFrontmatter } from "./pipeline";
import { subscribePluginLangs } from "../plugins/runtime/rendererRegistry";
import { LARGE_DOC_CHARS, PreviewDocKeyContext } from "./previewDoc";
import type { IncrementalPreview } from "./incrementalPreview";
import { handleWikiLinkClick } from "./wikiLinks";
import { wikiHoverHandlers } from "./hoverTrigger";
import { hasEmbeds } from "./remarkEmbeds";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { wikiFragmentId } from "../lib/slug";
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
  // A long document skips the synchronous pass: it renders in blocks,
  // yielding to the browser (plan 8.4).
  const [tree, setTree] = useState<React.ReactElement | null>(() =>
    fullPipelineWarm || markdownText.length >= LARGE_DOC_CHARS ? null : safeFastRender(markdownText),
  );
  // The document the *displayed* tree was rendered from — it lags `docKey`
  // until the async render for the new document lands.
  const [treeDocKey, setTreeDocKey] = useState<string | null>(docKey);
  const [error, setError] = useState<string | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const seqRef = useRef(0);
  const fastTextRef = useRef<string | null>(fullPipelineWarm ? null : markdownText);
  // `![[embeds]]`: bumped when a note or file the displayed tree embeds
  // changes in the workspace, so the embed shows the new text.
  const [embedVersion, setEmbedVersion] = useState(0);
  const embedWatchRef = useRef<{ active: boolean; paths: Set<string> }>({ active: false, paths: new Set() });
  /** Block-by-block renderer for long documents, loaded on first need. */
  const incrementalRef = useRef<IncrementalPreview | null>(null);

  useEffect(() => {
    const seq = ++seqRef.current;
    const isDark = () => document.documentElement.classList.contains("dark");
    const renderedFor = docKey;
    const stale = () => seq !== seqRef.current;
    const render = async (): Promise<React.ReactElement | null> => {
      if (markdownText.length < LARGE_DOC_CHARS) return renderMarkdown(markdownText, isDark);
      const m = await import("./incrementalPreview");
      if (!m.canRenderInBlocks(markdownText)) return renderMarkdown(markdownText, isDark);
      const inc = (incrementalRef.current ??= new m.IncrementalPreview());
      return inc.render(markdownText, isDark, stale);
    };
    const run = () => {
      // Only a note with `![[embeds]]` loads the embed code and waits for
      // the workspace index; if that chunk fails, embeds render as links.
      // Any other note renders through render(): in blocks when it is long.
      const rendered = hasEmbeds(markdownText)
        ? import("./embedContext")
            .then((m) => m.loadEmbedContext(markdownText, renderedFor))
            .catch(() => undefined)
            .then(async (embeds) => ({ el: await renderMarkdown(markdownText, isDark, { embeds }), embeds }))
        : render().then((el) => ({ el, embeds: undefined }));
      rendered
        .then(({ el, embeds }) => {
          if (!el || stale()) return;
          fullPipelineWarm = true;
          embedWatchRef.current = { active: !!embeds, paths: embeds?.used ?? new Set() };
          setTree(el);
          setTreeDocKey(renderedFor);
          setError(null);
        })
        .catch((e: Error) => {
          if (stale()) return;
          setError(e.message);
        });
    };
    if (fullPipelineWarm || markdownText.length >= LARGE_DOC_CHARS) {
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
  }, [markdownText, themeVersion, docKey, embedVersion]);

  // Live embeds: an autosave of an embedded note (or a rename / delete that
  // may make a missing target appear) re-renders. The workspace index marks
  // the saved file dirty on the same event, so the re-render reads its new
  // text. Notes that embed nothing never re-render here.
  useEffect(
    () =>
      onWorkspaceChanged(
        (c) => {
          const w = embedWatchRef.current;
          if (!w.active) return;
          if (c.kind === "structure" || !c.paths || c.paths.some((p) => w.paths.has(p))) setEmbedVersion((v) => v + 1);
        },
        { debounceMs: 250 },
      ),
    [],
  );

  // Re-process when a plugin starts or stops rendering a code-block language (plan 11.2).
  useEffect(() => subscribePluginLangs(() => setThemeVersion((v) => v + 1)), []);

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
      // Hover / focus on a [[link]] previews the note (4.6; loaded on first use).
      {...wikiHoverHandlers}
      // Double-click a handwriting block to edit it in the pad (W5.27; loaded on first use).
      onDoubleClick={(e) => {
        const ink = (e.target as Element).closest?.("svg[data-lumen-ink]");
        const id = ink?.getAttribute("data-ink-id");
        if (!id) return;
        e.preventDefault();
        void import("../ink/inkCommand").then((m) => m.editInkInNote(id));
      }}
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
                // rendered headings (Unicode-aware: Hebrew / CJK keep their
                // text); a block reference (`#^id`) is the block's own id
                // (remarkBlockIds).
                detail: /\.pdf$/i.test(path)
                  ? { path, fragment: heading ?? null }
                  : heading
                    ? { path, heading: wikiFragmentId(heading) }
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
          {t("block.renderError", { error })}
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
