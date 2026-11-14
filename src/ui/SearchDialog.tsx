import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";
import type { ReactElement } from "react";
import { Search, FileText, Sparkles, Loader2, FileCode2, Wand2, Image as ImageIcon } from "lucide-react";
import { t, tPlural } from "../i18n";
import "../ai/imageSearchStrings";
import { searchWorkspace, type SearchHit } from "../storage/workspaceIndex";
import { wrongLayoutVariant } from "../lib/keyboardLayout";
import { mergeLayoutHits } from "./paletteSearch";
import { isOPFSAvailable, readWorkspaceFile } from "../storage/workspace";
import { AiError } from "../ai/llm";
import type { ChatMessage } from "../ai/llm";
import { renderMarkdown } from "../renderer/pipeline";
import { log } from "../lib/logger";
import { showAiToast } from "../ui/AiToast";
import { semanticSearch, type RagResult } from "../ai/embeddings";
import { indexWorkspace, searchHybrid, type SemanticHit } from "../ai/semanticSearch";
import { rerank } from "../ai/reranker";
import { CITE_INSTRUCTIONS, verifyVaultCitations, type VaultCitation } from "../ai/vaultCitations";
import { useCapability } from "../billing/gates";
import { UpgradeNotice } from "./UpgradeNotice";
import { rememberSearch, getSearchHistory, forgetSearch } from "../storage/searchHistory";
import { flashSearchHighlight } from "../editor/searchHighlight";
import { isSaved, removeSavedSearch, saveSearch } from "../search/savedSearches";

// The Images tab (plan 6.7) and its model code load only when it is opened.
const ImageSearchPanel = lazy(() => import("./ImageSearchPanel").then((m) => ({ default: m.ImageSearchPanel })));
import { explainError } from "../lib/userError";
import { EmptyState, runCommand } from "./EmptyState";
import { HelpButton } from "./HelpButton";
import "./searchDialogStrings";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the workspace path + content when a file is selected. */
  onOpenFile: (path: string, content: string) => void;
  /** Plan W3.4: a query to start with (a widget, Siri or Spotlight search). */
  initialQuery?: string;
}

export function SearchDialog({ open, onClose, onOpenFile, initialQuery = "" }: Props) {
  const [mode, setMode] = useState<"search" | "smart" | "ai" | "images">("search");
  // Smart (embedding) search is a Pro capability when billing is enforced;
  // self-hosted setups always have it.
  const smartAllowed = useCapability("smartSearch");
  const [query, setQuery] = useState("");
  // Re-render after saving / removing a saved search (its state lives in localStorage).
  const [, setSavedTick] = useState(0);
  // A spoken "search …" (plan W5.20, src/ai/voice/run.ts) fills the box.
  useEffect(() => {
    const onQuery = (e: Event) => setQuery(String((e as CustomEvent<{ query?: string }>).detail?.query ?? ""));
    window.addEventListener("lumen-search-query", onQuery);
    return () => window.removeEventListener("lumen-search-query", onQuery);
  }, []);
  const [hits, setHits] = useState<SearchHit[]>([]);
  /** The other-layout reading of the query whose hits are shown too. */
  const [layoutVariant, setLayoutVariant] = useState<string | null>(null);
  const [smartHits, setSmartHits] = useState<SemanticHit[]>([]);
  // W5.28: local translations of the hits in another language than the query, and whether the embeddings bridge languages.
  const [translations, setTranslations] = useState<Record<string, string | null>>({});
  const [monolingual, setMonolingual] = useState(false);
  const [smartIndexing, setSmartIndexing] = useState(false);
  const [smartIndexedAt, setSmartIndexedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [aiRendered, setAiRendered] = useState<ReactElement | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSources, setAiSources] = useState<RagResult[]>([]);
  const [aiCitations, setAiCitations] = useState<{ citations: VaultCitation[]; verifiedCount: number } | null>(null);
  const [conversation, setConversation] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (open) {
      // A saved search opens the dialog on its query (plan W2.12); a widget or shortcut passes its own (W3.4).
      const preset = (window as unknown as { __lumenSearchQuery?: string }).__lumenSearchQuery;
      (window as unknown as { __lumenSearchQuery?: string }).__lumenSearchQuery = undefined;
      setQuery(preset ?? initialQuery);
      // Honour an optional `lumen-search-mode` event that lets command
      // palette entries open the dialog already on a specific tab.
      const requested = (window as unknown as { __lumenSearchMode?: "search" | "smart" | "ai" | "images" })
        .__lumenSearchMode;
      setMode(requested ?? "search");
      (window as unknown as { __lumenSearchMode?: string }).__lumenSearchMode = undefined;
      setAiAnswer(null);
      setAiRendered(null);
      setAiSources([]);
      setConversation([]);
      setSmartHits([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Focus trap while open; focus returns to the opener; Escape closes from anywhere in the dialog (plan 10.1).
  useFocusTrap(dialogRef, { active: open, onEscape: onClose });

  useEffect(() => {
    if (!open) return;
    if (mode !== "search") return;
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      searchWorkspace(query, { limit: 40 })
        .then(async (h) => {
          // Few hits: try the same keystrokes in the other keyboard layout too (plan W2.8).
          const other = h.length < 3 ? wrongLayoutVariant(query) : null;
          const more = other ? await searchWorkspace(other, { limit: 40 }).catch(() => [] as SearchHit[]) : [];
          if (cancelled) return;
          setLayoutVariant(more.length ? other : null);
          setHits(mergeLayoutHits(h, more));
          setActive(0);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setHits([]);
          setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, mode]);

  // Smart search — debounced hybrid retrieval (BM25 + vector embeddings).
  useEffect(() => {
    if (!open) return;
    if (mode !== "smart") return;
    if (!smartAllowed || !query.trim()) {
      setSmartHits([]);
      return;
    }
    let cancelled = false;
    // Abort a stale model rerank on the next keystroke: the worker runs jobs
    // one at a time, so obsolete inferences would delay the current query.
    const abort = new AbortController();
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const fused = await searchHybrid(query, 30);
        if (cancelled) return;
        // T29: reorder the 30 candidates by relevance (local reranker).
        const ranked = await rerank(query, fused.map((h) => ({ ...h, text: `${h.path}\n${h.snippet}` })), { signal: abort.signal });
        const results = ranked.slice(0, 20).map(({ text: _text, rerankScore: _r, ...h }) => h);
        if (cancelled) return;
        setSmartHits(results);
        setActive(0);
      } catch (err) {
        if (cancelled) return;
        log.warn("smart search failed", err);
        setSmartHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      abort.abort();
    };
  }, [open, query, mode, smartAllowed]);

  async function rebuildSmartIndex() {
    // Embeddings are computed on this device by default (Ollama or
    // transformers.js); no cloud key is needed.
    setSmartIndexing(true);
    showAiToast(t("toast.buildingSemanticIndex"), "info");
    try {
      const idx = await indexWorkspace({ force: true });
      setSmartIndexedAt(idx.builtAt || Date.now());
      showAiToast(t("toast.indexedFiles", { count: Object.keys(idx.files).length }), "success");
    } catch (e) {
      log.error("indexWorkspace failed", e);
      showAiToast(t("toast.indexingFailed", { error: explainError(e) }), "error");
    } finally {
      setSmartIndexing(false);
    }
  }

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-search-index="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  async function openHit(hit: SearchHit) {
    // Persist the query that led to this open — enables the recent-searches
    // chip row when the dialog re-opens with an empty query.
    const q = query.trim();
    if (q) rememberSearch(q);
    onClose();
    try {
      const content = await readWorkspaceFile(hit.path);
      onOpenFile(hit.path, content);
      // Flash the editor on the first match so the user can see *where*
      // their hit lives. Slight delay so the doc has loaded into the editor.
      if (q) setTimeout(() => flashSearchHighlight(q), 80);
    } catch {
      /* why: the file was deleted since the search ran; nothing to open */
    }
  }

  useEffect(() => {
    if (mode !== "smart" || !smartHits.length) {
      setTranslations({});
      return;
    }
    const ac = new AbortController();
    setTranslations({});
    void (async () => {
      const [{ markCrossLingual, scriptOf }, { translatePassage }, { embeddingStatus }] = await Promise.all([import("../search/crossLingual"), import("../search/passageTranslator"), import("../ai/semanticSearch")]);
      const marked = markCrossLingual(query, smartHits).slice(0, 8).filter((h) => h.crossLingual);
      if (scriptOf(query) === "he") {
        const st = await embeddingStatus().catch(() => null);
        if (!ac.signal.aborted) setMonolingual(st ? !st.multilingual : false);
      }
      const to = scriptOf(query) === "he" ? "he" : "en";
      for (const h of marked) {
        const r = await translatePassage(h.snippet, h.lang, to, { signal: ac.signal });
        if (ac.signal.aborted) return;
        setTranslations((cur) => ({ ...cur, [h.path]: r.text }));
      }
    })();
    return () => ac.abort();
  }, [mode, smartHits, query]);

  async function openSmartHit(hit: SemanticHit) {
    const q = query.trim();
    if (q) rememberSearch(q);
    onClose();
    try {
      const content = await readWorkspaceFile(hit.path);
      onOpenFile(hit.path, content);
      if (q) setTimeout(() => flashSearchHighlight(q), 80);
    } catch {
      /* why: the file was deleted since the search ran; nothing to open */
    }
  }

  function onKey(e: React.KeyboardEvent) {
    const listLen = mode === "smart" ? smartHits.length : hits.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(listLen - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "search") {
        const hit = hits[active];
        if (hit) void openHit(hit);
      } else if (mode === "smart") {
        const hit = smartHits[active];
        if (hit) void openSmartHit(hit);
      } else if (mode === "ai" && query.trim()) {
        void askAi();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  // T55: closing the dialog (or Esc anywhere) cancels a running answer.
  const askOp = useRef<{ end(): void; abort(): void } | null>(null);
  useEffect(() => {
    if (!open) askOp.current?.abort();
  }, [open]);

  async function askAi() {
    // Each question is one LLM prompt against the monthly AI quota, counted
    // when it is actually sent (ownPrompt).
    const { aiOperation, isAbort } = await import("../ai/aiAbort");
    // A new question replaces one still running: abort that one, so only
    // this invocation owns the handle, the loading state and the answer.
    askOp.current?.abort();
    const op = aiOperation();
    const local = new AbortController();
    op.signal.addEventListener("abort", () => local.abort(op.signal.reason), { once: true });
    const mine = { end: op.end, abort: () => local.abort(new DOMException("closed", "AbortError")) };
    askOp.current = mine;
    setAiLoading(true);
    setAiAnswer(t("searchDialog.searching"));
    setAiSources([]);
    setAiCitations(null);

    try {
      // Hybrid retrieval — when the user has built the embedding index
      // (Smart tab → Build) we fuse BM25 + semantic via RRF for genuinely
      // semantic-aware Q&A. When the index is empty, `searchHybrid` falls
      // back to BM25 alone, so we never block the AI tab on a missing index.
      const hybridHits = smartAllowed
        ? await searchHybrid(query, 30).catch(() => [] as SemanticHit[])
        : [];
      const fallback =
        hybridHits.length === 0
          ? // Whole notes (bounded), like the hybrid path: the packer trims.
            await semanticSearch(query, { topK: 8, maxContentChars: 200_000 })
          : [];
      // Materialise the hybrid hits into RagResult shape so the existing
      // citation-rendering code below works untouched.
      const hybridResults: RagResult[] = await Promise.all(
        hybridHits.map(async (h) => ({
          path: h.path,
          score: h.score,
          snippet: h.snippet,
          content: await readWorkspaceFile(h.path)
            // Whole notes (bounded): the context packer picks the parts.
            .then((c) => c.slice(0, 200_000))
            .catch(() => h.snippet),
        })),
      );
      // T29: rerank the candidates against the question, keep the best 8.
      const pool = hybridResults.length > 0 ? hybridResults : fallback;
      const results: RagResult[] = (
        await rerank(query, pool.map((r) => ({ ...r, text: `${r.snippet ?? ""}\n${r.content.slice(0, 1500)}` })))
      )
        .slice(0, 8)
        .map(({ text: _text, rerankScore: _r, ...r }) => r as RagResult);
      if (local.signal.aborted) throw local.signal.reason; // superseded or closed
      setAiSources(results);
      setAiCitations(null);

      // Build context from semantic results: only the parts relevant to the
      // question, within the AI mode's token budget (context packer).
      const { packContext, CONTEXT_BUDGET, getAiMode } = await import("../ai/contextPacker");
      const packed = packContext(
        query,
        results.map((r) => ({ path: r.path, content: r.content })),
        CONTEXT_BUDGET[getAiMode()],
      );
      // Plan 2.7: a note from outside (clipped, imported, pulled) goes to the model cleaned and delimited, and taints the run.
      const { ensureProvenanceBackfill, guardUntrusted, untrustedSourcesOfNote } = await import("../agents/untrusted");
      await ensureProvenanceBackfill();
      const untrusted: string[] = [];
      const contextStr = results.length > 0
        ? packed
            .map((r, i) => {
              const entry = `📄 [${i + 1}] ${r.path}\n${r.text}`;
              const from = untrustedSourcesOfNote(r.path, results.find((x) => x.path === r.path)?.content);
              untrusted.push(...from);
              return `---\n${from.length ? guardUntrusted(entry, from).text : entry}`;
            })
            .join("\n")
        : t("searchDialog.noRelevant");

      setAiAnswer(t("searchDialog.thinking"));

      // Plan 5.5: the `answerer` agent, through the runtime (earlier turns go along).
      const [{ runAgentOrThrow }, { answererAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
      const answer = await runAgentOrThrow(
        answererAgent,
        { text: query, extra: { context: contextStr, history: conversation.filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant"), citeInstructions: CITE_INSTRUCTIONS } },
        { ownPrompt: true, signal: local.signal, untrusted },
      );
      if (local.signal.aborted) throw local.signal.reason;
      setAiAnswer(answer);
      // Check every citation against the note it names (T29).
      setAiCitations(verifyVaultCitations(answer, results.map((r) => ({ path: r.path, content: r.content }))));

      // Save to conversation history
      setConversation((prev) => [
        ...prev,
        { role: "user" as const, content: query },
        { role: "assistant" as const, content: answer },
      ]);

      const isDark = () => document.documentElement.classList.contains("dark");
      const rendered = await renderMarkdown(answer, isDark);
      setAiRendered(rendered);
    } catch (e) {
      if (isAbort(e) || local.signal.aborted) {
        if (askOp.current === mine) setAiAnswer(t("toast.aiCancelled", { count: 1 }));
        return;
      }
      if (e instanceof AiError && e.code === "NO_KEY") {
        setAiAnswer("⚠️ Please configure your AI Key (⌘K → AI Settings).");
        showAiToast(t("toast.pleaseConfigureYourAiKey"), "error");
      } else if (e instanceof Error && e.name === "AiQuotaExceededError") {
        setAiAnswer(e.message); // the quota toast was already shown
      } else {
        log.error("AI workspace search failed", e);
        setAiAnswer("Failed to reach AI API.");
        // 5.6.4: an agent failure opens the suggestions panel instead of a bare toast.
        if (!(await import("../agents/suggestions")).reportAgentFailure(e, "search.askWorkspace")) showAiToast(t("toast.aiWorkspaceSearchFailed"), "error");
      }
    } finally {
      op.end();
      if (askOp.current === mine) {
        askOp.current = null;
        setAiLoading(false);
      }
    }
  }

  const empty = useMemo(() => {
    if (loading) return false;
    if (mode === "smart") return smartHits.length === 0;
    return hits.length === 0;
  }, [loading, hits, smartHits, mode]);

  // Result-count badge: shown once a query has settled (not while the
  // debounced search is in flight, and not on the Ask tab).
  const resultCount = mode === "smart" ? smartHits.length : hits.length;
  const showCount = !loading && query.trim().length > 0 && mode !== "ai" && mode !== "images";

  if (!open) return null;

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} role="dialog" aria-modal>
      <div ref={dialogRef} className="cmd-palette" style={{ minHeight: "350px", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", borderBottom: "1px solid hsl(var(--border))", padding: "0 10px", alignItems: "center" }}>
          <button className={`chart-block-tab ${mode === "search" ? "active" : ""}`} style={{ fontSize: 13, background: "transparent" }} onClick={() => setMode("search")}>
             {t("searchDialog.mode.search")}
          </button>
          <button
            className={`chart-block-tab ${mode === "smart" ? "active" : ""}`}
            style={{ fontSize: 13, background: "transparent" }}
            onClick={() => setMode("smart")}
            title={t("searchDialog.smartHint")}
          >
            <Wand2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} /> {t("searchDialog.mode.smart")}
          </button>
          <button className={`chart-block-tab ${mode === "ai" ? "active" : ""}`} style={{ fontSize: 13, background: "transparent" }} onClick={() => setMode("ai")}>
             <Sparkles size={11} style={{display:"inline", marginInlineEnd:4}}/> {t("searchDialog.mode.ai")}
          </button>
          <button className={`chart-block-tab ${mode === "images" ? "active" : ""}`} style={{ fontSize: 13, background: "transparent" }} onClick={() => setMode("images")} data-testid="search-tab-images">
             <ImageIcon size={11} style={{ display: "inline", marginInlineEnd: 4 }} /> {t("imageSearch.tab")}
          </button>
          <span style={{ marginInlineStart: "auto" }}>
            <HelpButton topic="workspace/search" />
          </span>
          {mode === "smart" && smartAllowed && (
            <button
              type="button"
              onClick={rebuildSmartIndex}
              disabled={smartIndexing}
              style={{
                marginInlineStart: "auto",
                fontSize: 11,
                padding: "3px 9px",
                borderRadius: 999,
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--bg-subtle))",
                color: "hsl(var(--fg-muted))",
                cursor: smartIndexing ? "wait" : "pointer",
              }}
              title={t("searchDialog.rebuildIndex")}
            >
              {smartIndexing ? t("searchDialog.indexing") : smartIndexedAt ? t("searchDialog.reindex") : t("searchDialog.buildIndex")}
            </button>
          )}
        </div>
        {mode === "search" && layoutVariant && query.trim() && (
          <div role="status" data-testid="search-layout-hint" dir="auto" style={{ padding: "6px 14px", fontSize: 12, color: "hsl(var(--fg-muted))" }}>
            {t("palette.layoutHint", { text: layoutVariant })}
          </div>
        )}
        <div className="cmd-palette-search">
          <Search size={16} style={{ opacity: 0.6, flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              isOPFSAvailable() ? t("search.placeholder") : t("search.unavailable")
            }
            aria-label={t("search.placeholder")}
            spellCheck={false}
            disabled={!isOPFSAvailable()}
          />
          {showCount && (
            <span
              data-testid="search-result-count"
              role="status"
              aria-live="polite"
              style={{
                flexShrink: 0,
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                background: resultCount ? "hsl(var(--accent) / 0.12)" : "hsl(var(--bg-subtle))",
                color: resultCount ? "hsl(var(--accent))" : "hsl(var(--fg-muted))",
                border: "1px solid hsl(var(--border))",
                whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {tPlural("search.results", resultCount)}
            </span>
          )}
          {mode === "search" && query.trim() && isOPFSAvailable() && (
            // Plan W2.12: keep this search in the sidebar.
            <button
              type="button"
              data-testid="search-save"
              aria-pressed={isSaved(query)}
              onClick={() => {
                if (isSaved(query)) removeSavedSearch(query.trim());
                else saveSearch(query);
                setSavedTick((n) => n + 1);
              }}
              title={isSaved(query) ? t("search.unsave") : t("search.save")}
              style={{
                flexShrink: 0,
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid hsl(var(--border))",
                background: isSaved(query) ? "hsl(var(--accent) / 0.12)" : "hsl(var(--bg-subtle))",
                color: isSaved(query) ? "hsl(var(--accent))" : "hsl(var(--fg-muted))",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {isSaved(query) ? `★ ${t("search.savedLabel")}` : `☆ ${t("search.save")}`}
            </button>
          )}
        </div>
        {mode !== "smart" && isOPFSAvailable() && (
          // Plan 11.3: the operators, shown under the input (LTR syntax inside an RTL UI stays readable).
          <div
            data-testid="search-operators-hint"
            dir="auto"
            style={{ padding: "2px 14px 6px", fontSize: 11, color: "hsl(var(--fg-muted))", unicodeBidi: "plaintext" }}
          >
            {t("search.operatorsHint")}
          </div>
        )}
        <div className="cmd-palette-list" ref={listRef}>
          {mode === "images" && (
            <Suspense fallback={null}>
              <ImageSearchPanel
                query={query}
                onPick={(path) => {
                  // Copy the image as Markdown to paste it into the note.
                  void navigator.clipboard?.writeText(`![](${path.split("/").map(encodeURIComponent).join("/")})`).catch(() => undefined);
                  showAiToast(t("imageSearch.copied"), "success");
                  onClose();
                }}
              />
            </Suspense>
          )}
          {mode === "smart" && !smartAllowed && (
            <UpgradeNotice compact plan="pro" message={t("billing.upgrade.smartSearch")} />
          )}
          {empty && mode !== "images" && !(mode === "smart" && !smartAllowed) && (
            mode === "smart" && !smartIndexedAt && !query ? (
              <div className="cmd-palette-empty">{t("searchDialog.buildHint")}</div>
            ) : query ? (
              <EmptyState message={t("search.noMatches")} action={{ label: t("search.clear"), onClick: () => setQuery("") }} />
            ) : (
              <EmptyState
                message={t("search.empty")}
                action={{
                  label: t("search.newNote"),
                  onClick: () => {
                    onClose();
                    runCommand("file.new");
                  },
                }}
              />
            )
          )}
          {/* Recent-searches chip row — only when the query is empty and the
              user has actually run searches before. Click a chip to re-run
              that query; click ✕ to forget it. */}
          {!query && mode !== "images" && getSearchHistory().length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                padding: "10px 12px 6px",
                borderBottom: "1px solid hsl(var(--border))",
              }}
              role="group"
              aria-label={t("searchDialog.recent")}
            >
              <span style={{ fontSize: 10, color: "hsl(var(--fg-muted))", textTransform: "uppercase", letterSpacing: "0.05em", marginInlineEnd: 4, alignSelf: "center" }}>
                {t("searchDialog.recentLabel")}
              </span>
              {getSearchHistory().map((q) => (
                <span
                  key={q}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 8px 3px 10px",
                    borderRadius: 999,
                    background: "hsl(var(--bg-subtle))",
                    border: "1px solid hsl(var(--border))",
                    fontSize: 11,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setQuery(q)}
                    aria-label={t("searchDialog.rerun", { q })}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "hsl(var(--fg))",
                      cursor: "pointer",
                      fontSize: 11,
                      padding: 0,
                    }}
                  >
                    {q}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      forgetSearch(q);
                      // Force re-render — cheap nudge via setQuery toggle.
                      setQuery((s) => s);
                    }}
                    aria-label={t("searchDialog.forget", { q })}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "hsl(var(--fg-muted))",
                      cursor: "pointer",
                      fontSize: 10,
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {(mode === "search" || mode === "ai") && hits.map((hit, i) => (
            <div
              key={hit.path}
              data-search-index={i}
              className={`cmd-palette-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => void openHit(hit)}
              style={{ alignItems: "flex-start" }}
              title={hit.path}
            >
              <FileText size={14} style={{ opacity: 0.7, marginTop: 1, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cmd-palette-label" style={{ fontWeight: 500 }}>
                  {hit.name}
                  {hit.path !== hit.name && (
                    <span style={{ color: "hsl(var(--fg-muted))", fontWeight: 400, marginInlineStart: 6, fontSize: 11 }}>
                      {hit.path}
                    </span>
                  )}
                </div>
                {hit.snippet && (
                  <div
                    style={{
                      color: "hsl(var(--fg-muted))",
                      fontSize: 11.5,
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {renderSnippet(hit)}
                  </div>
                )}
              </div>
            </div>
          ))}
          {mode === "smart" && smartHits.map((hit, i) => {
            const name = hit.path.split("/").pop() ?? hit.path;
            return (
              <div
                key={hit.path}
                data-search-index={i}
                className={`cmd-palette-item ${i === active ? "active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => void openSmartHit(hit)}
                style={{ alignItems: "flex-start" }}
                title={t("searchDialog.hitTitle", { path: hit.path, score: hit.score.toFixed(3) })}
              >
                <Wand2 size={14} style={{ opacity: 0.7, marginTop: 1, flexShrink: 0, color: "hsl(var(--accent))" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cmd-palette-label" style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{name}</span>
                    {hit.path !== name && (
                      <span style={{ color: "hsl(var(--fg-muted))", fontWeight: 400, fontSize: 11 }}>
                        {hit.path}
                      </span>
                    )}
                    <span style={{ marginInlineStart: "auto", fontSize: 10, color: "hsl(var(--fg-muted))" }}>
                      {hit.score.toFixed(2)}
                    </span>
                  </div>
                  {hit.snippet && (
                    <div
                      style={{
                        color: "hsl(var(--fg-muted))",
                        fontSize: 11.5,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {hit.snippet}
                    </div>
                  )}
                  {hit.path in translations && (
                    <div data-testid="smart-hit-translation" dir="auto" style={{ fontSize: 11.5, marginTop: 2, color: "hsl(var(--fg))" }}>
                      {translations[hit.path] ? (
                        <>
                          <span style={{ color: "hsl(var(--fg-muted))" }}>{t("searchDialog.localTranslation")}: </span>
                          {translations[hit.path]}
                        </>
                      ) : (
                        <span style={{ color: "hsl(var(--fg-muted))" }}>{t("searchDialog.noLocalTranslator")}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {mode === "smart" && monolingual && smartHits.length > 0 && (
            <div role="note" data-testid="smart-monolingual" style={{ padding: "6px 12px", fontSize: 11.5, color: "hsl(var(--fg-muted))" }}>
              {t("searchDialog.monolingualEmbeddings")}
            </div>
          )}
        </div>
        
        {mode === "ai" && (
          <div style={{ flex: 1, padding: "12px 16px", overflowY: "auto", fontSize: 13, color: "hsl(var(--fg))", borderTop: "1px solid hsl(var(--border))", background: "hsl(var(--bg-subtle))", display: "flex", flexDirection: "column", gap: 10 }}>
            {aiLoading ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "hsl(var(--accent))" }}>
                <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                <span>{aiAnswer === t("searchDialog.searching") ? t("searchDialog.searching") : t("searchDialog.thinking")}</span>
              </div>
            ) : aiRendered ? (
              <>
                <div className="prose-lumen" style={{ padding: 0, fontSize: 13, lineHeight: 1.6, maxWidth: "none" }}>
                  {aiRendered}
                </div>
                {aiCitations && (
                  <div data-testid="vault-citations" style={{ borderTop: "1px solid hsl(var(--border))", paddingTop: 8, marginTop: 4, fontSize: 11.5 }}>
                    {aiCitations.verifiedCount === 0 ? (
                      <div role="alert" style={{ color: "hsl(var(--warning))", fontWeight: 600, marginBottom: 4 }}>{t("vaultCite.unsupported")}</div>
                    ) : (
                      <div style={{ color: "hsl(var(--fg-muted))", fontWeight: 600, marginBottom: 4 }}>
                        {t("vaultCite.summary", { ok: aiCitations.verifiedCount, total: aiCitations.citations.length })}
                      </div>
                    )}
                    {aiCitations.citations.map((c, i) => (
                      <button
                        type="button"
                        key={`${c.n}-${i}`}
                        disabled={!c.path}
                        data-verified={c.verified ? "1" : "0"}
                        onClick={() => {
                          const src = aiSources[c.n - 1];
                          if (!src) return;
                          onClose();
                          onOpenFile(src.path, src.content);
                          if (c.line) window.dispatchEvent(new CustomEvent("lumen-reveal-line", { detail: { line: c.line, content: src.content } }));
                        }}
                        style={{ display: "flex", gap: 6, alignItems: "baseline", width: "100%", textAlign: "start", padding: "3px 0", background: "none", border: 0, color: "inherit", cursor: c.path ? "pointer" : "default" }}
                      >
                        <span style={{ color: c.verified ? "hsl(var(--success))" : "hsl(var(--danger))", fontWeight: 700 }} aria-label={c.verified ? t("vaultCite.verified") : t("vaultCite.notVerified")}>
                          {c.verified ? "✓" : "✗"}
                        </span>
                        <span style={{ color: "hsl(var(--accent))", whiteSpace: "nowrap" }}>
                          [{c.n}] <bdi>{c.path ?? t("vaultCite.noSource")}</bdi>{c.line ? `:${c.line}` : ""}
                        </span>
                        {c.quote && <span dir="auto" style={{ color: "hsl(var(--fg-muted))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>“{c.quote}”</span>}
                      </button>
                    ))}
                  </div>
                )}
                {aiSources.length > 0 && (
                  <div style={{ borderTop: "1px solid hsl(var(--border))", paddingTop: 8, marginTop: 4 }}>
                    <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))", marginBottom: 4, fontWeight: 600 }}>{t("searchDialog.sources")}</div>
                    {aiSources.map((s, i) => (
                      <div
                        key={s.path}
                        onClick={() => { onClose(); onOpenFile(s.path, s.content); }}
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", fontSize: 11, color: "hsl(var(--accent))", cursor: "pointer" }}
                        title={t("searchDialog.relevance", { pct: (s.score * 100).toFixed(0) })}
                      >
                        <FileCode2 size={11} />
                        <span>[{i + 1}] {s.path}</span>
                        <span style={{ color: "hsl(var(--fg-muted))", marginInlineStart: "auto" }}>{(s.score * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                )}
                {conversation.length > 0 && (
                  <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))", fontStyle: "italic" }}>
                    {tPlural("searchDialog.turns", conversation.length / 2)}
                  </div>
                )}
              </>
            ) : aiAnswer ? (
              <div style={{ whiteSpace: "pre-wrap" }}>{aiAnswer}</div>
            ) : (
              <div style={{ opacity: 0.5, fontStyle: "italic" }}>{t("searchDialog.askPlaceholder")}</div>
            )}
          </div>
        )}

        <div className="cmd-palette-footer">
          <span><kbd>↑</kbd> <kbd>↓</kbd> {t("palette.navigate")}</span>
          <span><kbd>↵</kbd> {t("palette.select")}</span>
          <span><kbd>Esc</kbd> {t("palette.close")}</span>
        </div>
      </div>
    </div>
  );
}

function renderSnippet(hit: SearchHit): React.ReactNode {
  if (!hit.snippet) return null;
  if (!hit.match) return hit.snippet;
  const { start, end } = hit.match;
  return (
    <>
      {hit.snippet.slice(0, start)}
      <mark
        style={{
          background: "hsl(var(--accent) / 0.25)",
          color: "hsl(var(--fg))",
          padding: 0,
        }}
      >
        {hit.snippet.slice(start, end)}
      </mark>
      {hit.snippet.slice(end)}
    </>
  );
}
