/**
 * EditorLayout – split-pane editor/preview layout with sync scrolling.
 *
 * Extracted from App.tsx to isolate:
 *  - split-pane resize feel (50/50 by default)
 *  - deterministic ratio-based sync-scroll
 *  - editor and preview section refs
 */
import { headingSlugger } from "../lib/slug";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { clampLineNumber } from "../editor/lineClamp";
import type { EditorHandle } from "../editor/Editor";

// The source editor drags the whole CodeMirror stack (~530KB gz). The page's
// LCP element is the PREVIEW text, which doesn't need it — so the editor
// hydrates lazily behind a layout-preserving skeleton and first paint stops
// paying for CodeMirror's execute.
const Editor = lazy(() =>
  import("../editor/Editor").then((m) => ({ default: m.Editor })),
);
import { Preview } from "../renderer/Preview";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { WritingGoalBanner } from "../ui/WritingGoalBanner";
import { useAppStore } from "../store/useStore";
import type { ViewMode, SplitAxis } from "../store/useStore";
import type { CollabSession } from "../collab/yjs";

const WysiwygEditor = lazy(() => import("../editor/WysiwygEditor"));
const PageView = lazy(() => import("../ui/PageView").then(m => ({ default: m.PageView })));

/**
 * Resolves the user's split-axis preference into a concrete orientation.
 *
 * - "auto": follow the viewport — vertical split on phones (≤640px), horizontal
 *   otherwise. The default; tracks resize events.
 * - "vertical": user's explicit choice, returned verbatim.
 * - "horizontal": honoured on wide viewports, but a ≤640px viewport still
 *   stacks — two side-by-side panes at phone width are unusable, and users
 *   expect narrowing the window to flow into the stacked layout.
 */
function useResolvedAxis(pref: SplitAxis): SplitAxis {
  const [narrow, setNarrow] = useState<boolean>(
    () => typeof window !== "undefined" && window.innerWidth <= 640,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setNarrow(window.innerWidth <= 640);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  if (pref === "vertical") return "vertical";
  return narrow ? "vertical" : pref === "auto" ? "horizontal" : pref;
}

interface Props {
  mode: ViewMode;
  docContent: string;
  deferredContent: string;
  /** Document identity matching `deferredContent` (they lag together). */
  deferredDocKey?: string | null;
  editorRef: React.RefObject<EditorHandle | null>;
  vimEnabled: boolean;
  spellCheck: boolean;
  grammarCheck: boolean;
  typewriterMode: boolean;
  /** Suggesting mode (track changes) in the source editor. */
  suggestingMode?: boolean;
  activeFile: string | null;
  pageView: boolean;
  collab: CollabSession | null;
  setContent: (s: string) => void;
  handleAddAsset: (file: File) => Promise<string | null>;
}

export function EditorLayout({
  mode,
  docContent,
  deferredContent,
  deferredDocKey = null,
  editorRef,
  vimEnabled,
  spellCheck,
  grammarCheck,
  typewriterMode,
  suggestingMode = false,
  pageView,
  collab,
  setContent,
  handleAddAsset,
}: Props) {
  const showEditor = mode === "source" || mode === "split";
  const showPreview = mode === "preview" || mode === "split";
  const showWysiwyg = mode === "wysiwyg";

  // Resolve the split axis. "auto" picks horizontal on wide viewports and
  // vertical on phones; explicit "horizontal"/"vertical" lock the layout.
  const splitAxisPref = useAppStore((s) => s.splitAxis);
  const resolvedAxis: SplitAxis = useResolvedAxis(splitAxisPref);
  const isVerticalSplit = mode === "split" && resolvedAxis === "vertical";

  // Forward the latest doc content to CM6. The Editor's internal sync
  // effect bails when the incoming value already equals the editor's
  // current state, so passing this on every keystroke is a no-op for the
  // textarea itself.
  //
  // ADR-001 — DO NOT memoize live store values without including them
  // in the dependency array. The previous `useMemo(() => docContent,
  // [docName, mode])` was a real P0 bug: when the welcome doc was seeded
  // asynchronously after first mount (docName/mode unchanged), the memo
  // stayed pinned to the empty initial value and the editor rendered
  // blank forever. If you ever feel tempted to memoize this kind of
  // hand-off prop "for performance", trust the child's equality check
  // instead.
  const editorInitial = docContent;

  // ── Deterministic sync-scroll ─────────────────────────────────
  const editorSectionRef = useRef<HTMLElement | null>(null);
  const previewSectionRef = useRef<HTMLElement | null>(null);

  // Subscribed (not getState()-once) so flipping "Scroll: Linked" applies
  // immediately, and the axis flip (side-by-side ⇄ stacked on narrow
  // viewports) re-binds the listeners against the new pane geometry.
  const syncScroll = useAppStore((s) => s.syncScroll);

  useEffect(() => {
    if (mode !== "split") return;
    if (syncScroll === "single") return;

    let editorEl: HTMLElement | null = null;
    let previewEl: HTMLElement | null = null;
    // setTimeout (not requestAnimationFrame): rAF callbacks are starved in
    // hidden/background tabs, which silently killed the sync there.
    let debounceId: ReturnType<typeof setTimeout> | undefined;

    // Wait for BOTH panes to mount. A one-shot timeout silently killed the
    // sync whenever the lazy-loaded preview (or CodeMirror) took longer than
    // the delay to appear — frequent on a cold dev server — so poll until
    // both elements exist (bounded; gives up after ~8s).
    let pollTries = 0;
    const timer = setInterval(() => {
      editorEl = editorSectionRef.current?.querySelector(".cm-scroller") as HTMLElement | null;
      previewEl = previewSectionRef.current?.querySelector("[data-preview-root]") as HTMLElement | null;
      if (!editorEl || !previewEl) {
        if (++pollTries > 80) clearInterval(timer);
        return;
      }
      clearInterval(timer);

      // Heading-anchored sync: ratio-based sync drifts because the editor's
      // pixel height (monospace lines) and preview's pixel height (rendered
      // markdown with images, tables, math) don't line up. We instead build a
      // list of headings shared between the two panes and slide the inactive
      // pane so its corresponding heading sits at the same viewport offset
      // as the active pane's heading.

      interface Anchor {
        line: number; // 1-based line in the markdown source
        slug: string;
        previewEl: HTMLElement;
      }
      let anchors: Anchor[] = [];

      const buildAnchors = () => {
        if (!previewEl) return;
        const view = editorRef.current?.getView();
        const text = view ? view.state.doc.toString() : "";
        const lines = text.split("\n");
        const result: Anchor[] = [];
        // Same slugger as rehype-slug (Unicode, repeats numbered), so
        // Hebrew headings get the ids the preview actually has (T26).
        const slugger = headingSlugger();
        let inFence = false;
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          if (/^```/.test(ln.trim())) inFence = !inFence;
          if (inFence) continue;
          const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln);
          if (m) {
            const slug = slugger.slug(m[2]);
            const headingEl =
              previewEl.querySelector<HTMLElement>(`#${CSS.escape(slug)}`) ??
              previewEl.querySelector<HTMLElement>(`[id="${slug}"]`);
            if (headingEl) {
              result.push({ line: i + 1, slug, previewEl: headingEl });
            }
          }
        }
        anchors = result;
      };

      buildAnchors();
      // Rebuild after the preview re-renders (debounced by RAF).
      const previewObserver = new MutationObserver(() => {
        cancelAnimationFrame(rebuildRaf);
        rebuildRaf = requestAnimationFrame(buildAnchors);
      });
      let rebuildRaf = 0;
      previewObserver.observe(previewEl, { childList: true, subtree: true });

      let activePane: "editor" | "preview" | null = null;
      let suppressBounceUntil = 0;

      const setActive = (pane: "editor" | "preview") => {
        activePane = pane;
      };
      const editorEnter = () => setActive("editor");
      const previewEnter = () => setActive("preview");
      editorEl.addEventListener("mouseenter", editorEnter);
      editorEl.addEventListener("focusin", editorEnter);
      previewEl.addEventListener("mouseenter", previewEnter);
      previewEl.addEventListener("focusin", previewEnter);

      function getEditorYForLine(line: number): number {
        const view = editorRef.current?.getView();
        if (!view) return 0;
        // Anchors are rebuilt asynchronously by the MutationObserver after
        // the preview re-renders. Between a doc shrink and that rebuild,
        // an anchor.line value can exceed `doc.lines` and make `doc.line(n)`
        // throw "Invalid line number N in M-line document". `clampLineNumber`
        // keeps the sync code defensive — the slight visual offset corrects
        // on the next rebuild a few ms later.
        const safe = clampLineNumber(line, view.state.doc.lines);
        if (safe === 0) return 0;
        const docLine = view.state.doc.line(safe);
        return view.lineBlockAt(docLine.from).top;
      }

      // Find the pair of anchors bracketing the given position. Returns the
      // index of the anchor at-or-above the target (or -1 if scrolled before
      // the first heading).
      function bracket(value: number, getter: (a: Anchor) => number): { i: number; lower?: Anchor; upper?: Anchor } {
        if (anchors.length === 0) return { i: -1 };
        let i = -1;
        for (let k = 0; k < anchors.length; k++) {
          if (getter(anchors[k]) <= value + 0.5) i = k;
          else break;
        }
        return { i, lower: anchors[i], upper: anchors[i + 1] };
      }

      const sync = (from: "editor" | "preview") => {
        if (!editorEl || !previewEl) return;
        suppressBounceUntil = performance.now() + 120;
        if (from === "editor") {
          // Where is the editor right now, and which two headings bracket it?
          const editorTop = editorEl.scrollTop;
          const { lower, upper } = bracket(editorTop, (a) => getEditorYForLine(a.line));
          if (lower) {
            const lowerEditorY = getEditorYForLine(lower.line);
            const upperEditorY = upper ? getEditorYForLine(upper.line) : editorEl.scrollHeight;
            const lowerPreviewY = lower.previewEl.offsetTop;
            const upperPreviewY = upper ? upper.previewEl.offsetTop : previewEl.scrollHeight;
            // Position within the section, normalised so editor and preview
            // each scroll the same FRACTION of their own section. This keeps
            // identical content at the top of both panes regardless of how
            // much vertical space each side renders for the same words.
            const sectionRatio = (editorTop - lowerEditorY) / Math.max(1, upperEditorY - lowerEditorY);
            previewEl.scrollTop = Math.max(0, lowerPreviewY + sectionRatio * (upperPreviewY - lowerPreviewY));
          } else if (upper) {
            // Before the first heading — pin to the very top.
            previewEl.scrollTop = 0;
          } else {
            const denom = Math.max(1, editorEl.scrollHeight - editorEl.clientHeight);
            const ratio = editorEl.scrollTop / denom;
            previewEl.scrollTop = ratio * Math.max(1, previewEl.scrollHeight - previewEl.clientHeight);
          }
        } else {
          const previewTop = previewEl.scrollTop;
          const { lower, upper } = bracket(previewTop, (a) => a.previewEl.offsetTop);
          if (lower) {
            const lowerPreviewY = lower.previewEl.offsetTop;
            const upperPreviewY = upper ? upper.previewEl.offsetTop : previewEl.scrollHeight;
            const lowerEditorY = getEditorYForLine(lower.line);
            const upperEditorY = upper ? getEditorYForLine(upper.line) : editorEl.scrollHeight;
            const sectionRatio = (previewTop - lowerPreviewY) / Math.max(1, upperPreviewY - lowerPreviewY);
            editorEl.scrollTop = Math.max(0, lowerEditorY + sectionRatio * (upperEditorY - lowerEditorY));
          } else if (upper) {
            editorEl.scrollTop = 0;
          } else {
            const denom = Math.max(1, previewEl.scrollHeight - previewEl.clientHeight);
            const ratio = previewEl.scrollTop / denom;
            editorEl.scrollTop = ratio * Math.max(1, editorEl.scrollHeight - editorEl.clientHeight);
          }
        }
      };

      const onEditorScroll = () => {
        if (performance.now() < suppressBounceUntil && activePane !== "editor") return;
        if (activePane !== "editor") return;
        clearTimeout(debounceId);
        debounceId = setTimeout(() => sync("editor"), 16);
      };

      const onPreviewScroll = () => {
        if (performance.now() < suppressBounceUntil && activePane !== "preview") return;
        if (activePane !== "preview") return;
        clearTimeout(debounceId);
        debounceId = setTimeout(() => sync("preview"), 16);
      };

      editorEl.addEventListener("scroll", onEditorScroll, { passive: true });
      previewEl.addEventListener("scroll", onPreviewScroll, { passive: true });

      // Store cleanup on the ref so the unmount path can find it later.
      const refWithCleanup = editorSectionRef as React.MutableRefObject<
        HTMLElement | null
      > & { _cleanup?: () => void };
      refWithCleanup._cleanup = () => {
        editorEl?.removeEventListener("scroll", onEditorScroll);
        previewEl?.removeEventListener("scroll", onPreviewScroll);
        editorEl?.removeEventListener("mouseenter", editorEnter);
        editorEl?.removeEventListener("focusin", editorEnter);
        previewEl?.removeEventListener("mouseenter", previewEnter);
        previewEl?.removeEventListener("focusin", previewEnter);
        previewObserver.disconnect();
        clearTimeout(debounceId);
        cancelAnimationFrame(rebuildRaf);
      };
    }, 100);

    return () => {
      clearInterval(timer);
      const refWithCleanup = editorSectionRef as React.MutableRefObject<
        HTMLElement | null
      > & { _cleanup?: () => void };
      refWithCleanup._cleanup?.();
    };
  }, [mode, syncScroll, isVerticalSplit]);

  return (
    <div
      className={`flex-1 min-w-0 min-h-0 flex ${isVerticalSplit ? "flex-col" : "flex-row"}`}
      data-split-axis={isVerticalSplit ? "vertical" : "horizontal"}
    >
      {showEditor && (
        <section
          ref={editorSectionRef}
          className={
            mode === "split"
              ? isVerticalSplit
                ? "w-full h-1/2 min-h-0 border-b border-border bg-bg flex flex-col"
                : "w-1/2 min-w-0 h-full min-h-0 border-r border-border bg-bg flex flex-col"
              : "w-full min-w-0 h-full min-h-0 bg-bg flex flex-col"
          }
        >
          <WritingGoalBanner />
          {/* Layout-preserving fallback: the pane keeps its flex size while
              CodeMirror hydrates, so the lazy mount causes no CLS. */}
          <Suspense fallback={<div className="flex-1 min-h-0" aria-hidden />}>
            <Editor
              key={collab ? `collab:${collab.roomName}` : "local"}
              ref={editorRef as React.Ref<EditorHandle>}
              value={editorInitial}
              onChange={setContent}
              onAddAsset={handleAddAsset}
              vimEnabled={vimEnabled}
              spellCheck={spellCheck}
              grammarCheck={grammarCheck}
              typewriterMode={typewriterMode}
              suggesting={suggestingMode}
              collab={collab}
            />
          </Suspense>
        </section>
      )}
      {showPreview && (
        <section
          ref={previewSectionRef}
          className={
            mode === "split"
              ? isVerticalSplit
                ? "w-full h-1/2 min-h-0 bg-bg-subtle flex flex-col"
                : "w-1/2 min-w-0 h-full min-h-0 bg-bg-subtle flex flex-col"
              : "w-full min-w-0 h-full min-h-0 bg-bg-subtle flex flex-col"
          }
        >
          {pageView ? (
            <Suspense fallback={<div style={{padding:'2rem',color:'hsl(var(--fg-muted))'}}>Loading page view…</div>}>
              <PageView markdownText={deferredContent} docKey={deferredDocKey} />
            </Suspense>
          ) : (
            <Preview markdownText={deferredContent} docKey={deferredDocKey} />
          )}
        </section>
      )}
      {showWysiwyg && (
        <section className="w-full min-w-0 bg-bg">
          <Suspense
            fallback={
              <div
                style={{
                  padding: "2rem",
                  color: "hsl(var(--fg-muted))",
                  fontSize: 13,
                }}
              >
                Loading WYSIWYG editor…
              </div>
            }
          >
            <ErrorBoundary fallback={
              <div style={{ padding: "2rem", color: "hsl(0 80% 60%)" }}>
                <strong>WYSIWYG editor failed</strong>
                <p style={{ fontSize: 12, opacity: 0.8 }}>Try switching to Source mode.</p>
              </div>
            }>
              <WysiwygEditor value={docContent} onChange={setContent} />
            </ErrorBoundary>
          </Suspense>
        </section>
      )}
    </div>
  );
}
