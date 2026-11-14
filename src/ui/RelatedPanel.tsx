/**
 * Related notes while writing (plan W2.2): a side panel with the notes
 * closest to the paragraph at the cursor, and the notes it mentions
 * without a link (also underlined in the editor). Updated `delay` ms after
 * typing stops; nothing is computed on a keystroke. Off for a note with
 * `related: false` in its front matter, or for a folder turned off
 * (Related notes: off for this folder).
 *
 * Lazy: mounted by "Related notes: show / hide"; never in the startup bundle.
 */
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Link2, X } from "lucide-react";
import { t } from "../i18n";
import { useAppStore } from "../store/useStore";
import { ensureIndex, indexedFiles, indexedNoteText, relatedInIndex } from "../storage/workspaceIndex";
import { linkHints, titleEntries, type LinkHint, type RelatedHit, type TitleEntry } from "../related/related";
import { acceptHint, currentHints, hasRelatedExtension, relatedExtension } from "../related/editorPlugin";
import { offFolders, relatedOff } from "../related/prefs";
import "./relatedPanelStrings";
import { HelpButton } from "./HelpButton";
import { EmptyState, learnHow } from "./EmptyState";

/** Debounce after the last keystroke (the plan's budget: the panel is up to date < 150 ms after typing stops). */
export const RELATED_DELAY_MS = 100;

/** Hits from an on-device embedding index (seam; see related.ts). */
export type RelatedSemantic = (paragraph: string, k: number) => Promise<Array<{ path: string; score: number }>>;
let semantic: RelatedSemantic | null = null;
export function setRelatedSemantic(fn: RelatedSemantic | null): void {
  semantic = fn;
}

/** The last update, for the e2e and the perf check: when it ran and how long it took. */
export const relatedTiming = { at: 0, ms: 0, runs: 0 };

const nameOf = (p: string) => (p.split("/").pop() ?? p).replace(/\.(md|markdown|txt)$/i, "");
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const btn: React.CSSProperties = { padding: "2px 8px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };

interface Snapshot {
  related: RelatedHit[];
  hints: LinkHint[];
  off: boolean;
}

function Panel({ getView, onClose, subscribe }: { getView: () => EditorView | null; onClose: () => void; subscribe: (fn: (s: Snapshot) => void) => () => void }) {
  const [snap, setSnap] = useState<Snapshot>({ related: [], hints: [], off: false });
  useEffect(() => subscribe(setSnap), [subscribe]);
  const open = (path: string) => {
    const file = indexedFiles().find((f) => f.path === path);
    if (!file) return;
    // W2.22: the note's text is in the index, not on this thread.
    void indexedNoteText(file.path).then((content) => {
      if (content !== null) useAppStore.getState().openTab({ name: file.name, content, workspaceName: file.path });
    });
  };
  return (
    <aside dir="auto" data-testid="related-panel" aria-label={t("related.title")} style={{ position: "fixed", insetInlineEnd: 12, top: 72, width: 280, maxHeight: "70vh", overflow: "auto", zIndex: 40, background: "hsl(var(--bg))", border: "1px solid hsl(var(--border))", borderRadius: 10, boxShadow: "var(--shadow-sm)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Link2 size={14} />
        <strong style={{ flex: 1, fontSize: 13 }}>{t("related.title")}</strong>
        <HelpButton topic="workspace/related" />
        <button type="button" style={btn} onClick={onClose} aria-label={t("related.close")}>
          <X size={12} />
        </button>
      </header>
      {snap.off ? (
        <p style={{ ...muted, margin: 0 }} data-testid="related-off">
          {t("related.off")}
        </p>
      ) : (
        <>
          {snap.related.length === 0 ? (
            <EmptyState style={{ padding: 0 }} message={t("related.none")} action={learnHow("workspace/related")} />
          ) : (
            <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {snap.related.map((h) => (
                <li key={h.path} style={{ listStyle: "none" }} data-testid="related-hit" data-path={h.path}>
                  <button type="button" onClick={() => open(h.path)} style={{ ...btn, border: "none", padding: 0, textAlign: "start", width: "100%" }}>
                    <bdi style={{ fontSize: 13 }}>{nameOf(h.path)}</bdi>
                  </button>
                  {h.matched.length > 0 && <div style={muted}>{h.matched.slice(0, 4).join(" · ")}</div>}
                </li>
              ))}
            </ul>
          )}
          {snap.hints.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <strong style={{ fontSize: 12 }}>{t("related.links")}</strong>
              {snap.hints.map((h) => (
                <div key={`${h.from}:${h.path}`} style={{ display: "flex", gap: 6, alignItems: "center" }} data-testid="related-link-hint">
                  <bdi style={{ flex: 1, fontSize: 12 }}>{h.name}</bdi>
                  <button
                    type="button"
                    style={btn}
                    data-testid="related-link-accept"
                    onClick={() => {
                      const view = getView();
                      const live = view && currentHints(view).find((x) => x.from === h.from && x.path === h.path);
                      if (view && live) acceptHint(view, live);
                    }}
                  >
                    {t("related.link")}
                  </button>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </aside>
  );
}

let mounted: { root: Root; host: HTMLElement; stop: () => void } | null = null;

export function isRelatedPanelOpen(): boolean {
  return !!mounted;
}

/** Show the panel (and attach the editor plugin), or hide it when it is open. */
export async function toggleRelatedPanel(getView: () => EditorView | null): Promise<void> {
  if (mounted) {
    mounted.stop();
    return;
  }
  // W2.22: related notes are ranked by the index's own BM25, in the index worker.
  await ensureIndex();
  if (!semantic) setRelatedSemantic(await onDeviceSemantic().catch(() => null));
  let titles: TitleEntry[] = titleEntries(indexedFiles().map((f) => f.path));
  const listeners = new Set<(s: Snapshot) => void>();
  let last: Snapshot = { related: [], hints: [], off: false };
  const publish = (s: Snapshot) => {
    last = s;
    for (const fn of listeners) fn(s);
  };
  let semSeq = 0;
  const host = {
    label: (h: LinkHint) => t("related.hint", { name: h.name }),
    pause: (_view: EditorView, paragraph: { from: number; to: number; text: string }, cursor: number): LinkHint[] => {
      const t0 = performance.now();
      const { doc } = useAppStore.getState();
      const self = doc.workspaceName ?? null;
      if (relatedOff(self, doc.content)) {
        publish({ related: [], hints: [], off: true });
        return [];
      }
      const folders = offFolders();
      const relSeq = ++semSeq;
      const linked = new Set([...doc.content.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim().toLowerCase()));
      const hints = linkHints(paragraph.text, paragraph.from, titles, { self, cursor, linked });
      relatedTiming.ms = performance.now() - t0;
      relatedTiming.at = Date.now();
      relatedTiming.runs++;
      publish({ related: last.related, hints, off: false });
      // The ranking comes back from the index a moment later; embeddings, when an on-device index exists, refine it.
      void relatedInIndex({ paragraph: paragraph.text, self, offFolders: folders })
        .then((related) => {
          if (relSeq !== semSeq || !mounted) return;
          publish({ ...last, related });
          if (!semantic || paragraph.text.trim().length <= 20) return;
          return semantic(paragraph.text, 10).then((sem) => {
            if (relSeq !== semSeq || !mounted) return;
            return relatedInIndex({ paragraph: paragraph.text, self, offFolders: folders, semantic: sem.map((h) => ({ path: h.path, score: h.score })) }).then((r) => {
              if (relSeq === semSeq && mounted) publish({ ...last, related: r });
            });
          });
        })
        .catch(() => {});
      return hints;
    },
  };
  const attach = () => {
    const view = getView();
    if (view && !hasRelatedExtension(view)) view.dispatch({ effects: StateEffect.appendConfig.of(relatedExtension(host, RELATED_DELAY_MS)) });
  };
  attach();
  // The editor may be rebuilt (mode switch, another note): re-attach; refresh the index and names now and then.
  const timer = setInterval(() => {
    attach();
  }, 1000);
  const refresh = setInterval(() => {
    void ensureIndex().then(() => {
      titles = titleEntries(indexedFiles().map((f) => f.path));
    });
  }, 15_000);
  const el = document.createElement("div");
  el.id = "related-panel-root";
  document.body.appendChild(el);
  const root = createRoot(el);
  const stop = () => {
    clearInterval(timer);
    clearInterval(refresh);
    // The plugin stays in this editor until it is rebuilt; with no panel it only clears its hints.
    host.pause = () => [];
    mounted = null;
    root.unmount();
    el.remove();
    listeners.clear();
  };
  mounted = { root, host: el, stop };
  const subscribe = (fn: (s: Snapshot) => void) => {
    listeners.add(fn);
    fn(last);
    return () => listeners.delete(fn);
  };
  root.render(<Panel getView={getView} onClose={stop} subscribe={subscribe} />);
}

/** The default semantic seam: the embedding index, only when it was built on this device. */
export async function onDeviceSemantic(): Promise<RelatedSemantic | null> {
  const m = await import("../ai/semanticSearch");
  const id = await m.semanticIndexEmbedding().catch(() => null);
  if (!id || !/^(ollama|transformers):/.test(id)) return null;
  return (paragraph, k) => m.searchSemantic(paragraph, k);
}
