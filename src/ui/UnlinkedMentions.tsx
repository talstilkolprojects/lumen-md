/**
 * "Unlinked mentions" in the backlinks panel (plan 4.6): the notes that
 * name this note's title in plain text, without a link, each with a Link
 * button that turns that mention into `[[Title]]` (or `[[Title|as written]]`).
 * Loaded lazily with the panel's section.
 */

import { useCallback, useEffect, useState } from "react";
import { ensureIndex, indexedFiles } from "../storage/workspaceIndex";
import { basename, readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { notifyWorkspaceChanged, onWorkspaceChanged } from "../storage/workspaceEvents";
import { findUnlinkedMentions, linkMention, type Mention } from "../lib/unlinkedMentions";
import { noteKey } from "../lib/slug";
import { useAppStore } from "../store/useStore";
import { showAiToast } from "./AiToast";
import { t } from "../i18n";

const MD = /\.(md|markdown)$/i;
const stem = (p: string) => basename(p).replace(MD, "");

export interface UnlinkedHit {
  path: string;
  mention: Mention;
  snippet: string;
}

function snippet(text: string, m: Mention): string {
  const from = Math.max(0, m.start - 50);
  const to = Math.min(text.length, m.end + 50);
  return (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ").trim() + (to < text.length ? "…" : "");
}

/** Every unlinked mention of the note at `path`'s title in the other notes of the vault. */
export function unlinkedMentionsOf(path: string, files: ReadonlyArray<{ path: string; content: string }>): UnlinkedHit[] {
  const own = stem(path);
  const ownLower = own.toLowerCase();
  const notes = files.filter((f) => MD.test(f.path));
  const titles = [...new Set(notes.map((f) => stem(f.path)))];
  const out: UnlinkedHit[] = [];
  for (const f of notes) {
    if (f.path === path) continue;
    const lower = f.content.toLowerCase();
    if (!lower.includes(ownLower)) continue;
    // Only the titles this note contains can compete with ours for a span.
    const present = titles.filter((x) => lower.includes(x.toLowerCase()));
    for (const m of findUnlinkedMentions(f.content, present, stem(f.path))) {
      if (noteKey(m.target) === noteKey(own)) out.push({ path: f.path, mention: m, snippet: snippet(f.content, m) });
    }
  }
  return out;
}

/** What a link to the note says: its name, or its path when another note has the same name. */
function linkTargetFor(path: string): string {
  const own = noteKey(stem(path));
  const shared = indexedFiles().filter((f) => MD.test(f.path) && noteKey(stem(f.path)) === own).length > 1;
  return shared ? path.replace(MD, "") : stem(path);
}

export default function UnlinkedMentions({ filePath, onOpen }: { filePath: string; onOpen: (path: string) => void }) {
  const [hits, setHits] = useState<UnlinkedHit[] | null>(null);
  const scan = useCallback(async () => {
    await ensureIndex();
    // The open note's latest text, not the index's copy.
    const doc = useAppStore.getState().doc;
    const files = indexedFiles().map((f) => (f.path === doc.workspaceName ? { path: f.path, content: doc.content } : f));
    return unlinkedMentionsOf(filePath, files);
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    setHits(null);
    const run = () => void scan().then((h) => !cancelled && setHits(h)).catch(() => !cancelled && setHits([]));
    run();
    const off = onWorkspaceChanged(run, { debounceMs: 500 });
    return () => {
      cancelled = true;
      off();
    };
  }, [scan]);

  const link = async (hit: UnlinkedHit) => {
    const name = stem(hit.path);
    try {
      const target = linkTargetFor(filePath);
      // Only where the mention is still there as it was found.
      const linked = (text: string) => {
        if (text.slice(hit.mention.start, hit.mention.end) !== hit.mention.text) throw new Error(t("backlinks.changed"));
        return linkMention(text, hit.mention, target);
      };
      const store = useAppStore.getState();
      if (store.doc.workspaceName === hit.path) store.setContent(linked(store.doc.content));
      else {
        // Open in a tab that isn't active: its copy (unsaved edits too) takes
        // the link as well, or switching back would bring the old text back
        // and its next save would undo the link. Computed before writing.
        const tabs = store.openTabs.filter((tb) => tb.workspaceName === hit.path).map((tb) => ({ id: tb.id, from: tb.content, to: linked(tb.content) }));
        await writeWorkspaceFile(hit.path, linked(await readWorkspaceFile(hit.path)));
        useAppStore.setState((st) => ({
          openTabs: st.openTabs.map((tb) => {
            const e = tabs.find((x) => x.id === tb.id);
            return e && tb.content === e.from ? { ...tb, content: e.to } : tb;
          }),
        }));
        notifyWorkspaceChanged({ kind: "content", paths: [hit.path] });
      }
      setHits((hs) => hs?.filter((h) => h !== hit) ?? hs);
      showAiToast(t("backlinks.linked", { note: name }), "success");
    } catch (e) {
      showAiToast(t("backlinks.linkFailed", { note: name, error: (e as Error)?.message ?? String(e) }), "error");
    }
  };

  return (
    <section aria-label={t("backlinks.unlinked")} data-testid="unlinked-mentions">
      <div className="file-tree-header" style={{ marginBlockStart: 8 }}>
        <span>{t("backlinks.unlinked")}</span>
        {hits && <span style={{ opacity: 0.7, marginInlineStart: 6 }}>{hits.length}</span>}
      </div>
      {hits === null && <div style={{ padding: "0.5rem 1rem", color: "hsl(var(--fg-muted))", fontSize: 12 }}>{t("backlinks.scanning")}</div>}
      {hits && hits.length === 0 && <div style={{ padding: "0.5rem 1rem", color: "hsl(var(--fg-muted))", fontSize: 12 }}>{t("backlinks.unlinkedEmpty")}</div>}
      {hits && hits.length > 0 && (
        <ul className="backlinks-list" role="list">
          {hits.map((h) => (
            <li key={`${h.path}:${h.mention.start}`} role="listitem" style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
              <button type="button" className="backlink-item" onClick={() => onOpen(h.path)} title={h.path} style={{ flex: 1, minInlineSize: 0 }}>
                <span className="backlink-from">{stem(h.path)}</span>
                <span className="backlink-snippet" dir="auto">{h.snippet}</span>
              </button>
              <button
                type="button"
                className="backlink-link"
                onClick={() => void link(h)}
                aria-label={t("backlinks.linkAria", { text: h.mention.text, note: stem(h.path) })}
                style={{ fontSize: 11, padding: "2px 8px", border: "1px solid hsl(var(--border))", borderRadius: 4, background: "hsl(var(--bg))", color: "hsl(var(--fg))", marginBlockStart: 4 }}
              >
                {t("backlinks.link")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
