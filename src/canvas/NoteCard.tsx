/**
 * A note card on the canvas (plan W1.16): what Excalidraw's
 * `renderEmbeddable` draws for a `lumen-note:` element (./noteCards). It
 * shows the note's title and first lines; when the card is active (click
 * it, then click again — Excalidraw's embed interaction) the text can be
 * edited in place and is saved to the note; "Open" opens the note in a tab.
 *
 * The note is read once per card and shared through a small cache, so a
 * canvas of 50 cards reads 50 files once, and only for the cards in view
 * (Excalidraw renders embeds only while visible).
 */

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useAppStore } from "../store/useStore";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { noteExcerpt, noteTitle, stripFrontmatter } from "./noteCards";
import { log } from "../lib/logger";

type Entry = { text: string | null; at: number };
const cache = new Map<string, Promise<Entry>>();

/** The note as the editor has it (an open tab's unsaved text wins), else from the vault; null if missing. */
export function readNote(path: string): Promise<string | null> {
  const st = useAppStore.getState();
  if (st.doc.workspaceName === path) return Promise.resolve(st.doc.content);
  const tab = st.openTabs.find((x) => x.workspaceName === path);
  if (tab) return Promise.resolve(tab.content);
  let hit = cache.get(path);
  if (!hit) {
    hit = readWorkspaceFile(path).then(
      (text) => ({ text, at: Date.now() }),
      () => ({ text: null, at: Date.now() }),
    );
    cache.set(path, hit);
  }
  return hit.then((e) => e.text);
}

/** Save the card's edit: the vault file, and the editor's copy when the note is open. */
export async function writeNote(path: string, text: string): Promise<void> {
  const st = useAppStore.getState();
  if (st.doc.workspaceName === path) st.setContent(text);
  else if (st.openTabs.some((x) => x.workspaceName === path)) useAppStore.setState((s) => ({ openTabs: s.openTabs.map((x) => (x.workspaceName === path ? { ...x, content: text } : x)) }));
  await writeWorkspaceFile(path, text);
  cache.set(path, Promise.resolve({ text, at: Date.now() }));
}

/** @internal tests */
export function __resetNoteCache(): void {
  cache.clear();
}

/** Body text of the note without its frontmatter; the frontmatter is kept when saving. */
function splitFrontmatter(md: string): { fm: string; body: string } {
  const body = stripFrontmatter(md);
  return { fm: md.slice(0, md.length - body.length), body };
}

export function NoteCard({ path, active, onOpen }: { path: string; active: boolean; onOpen: (path: string) => void }) {
  const [md, setMd] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    void readNote(path).then((text) => live && setMd(text));
    return () => {
      live = false;
    };
  }, [path]);

  // Leaving the card (Excalidraw deactivates it) ends the edit, saving it.
  useEffect(() => {
    if (!active && editing) void save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);

  async function save() {
    setEditing(false);
    if (md == null) return;
    const { fm, body } = splitFrontmatter(md);
    if (draft === body) return;
    const next = fm + draft;
    setMd(next);
    try {
      await writeNote(path, next);
    } catch (e) {
      log.warn("note card save failed", e);
    }
  }

  const name = (path.split("/").pop() ?? path).replace(/\.(md|markdown)$/i, "");
  const title = md ? noteTitle(path, md) : name;
  return (
    <div className="lumen-note-card" data-testid="note-card" data-path={path} data-loaded={md !== undefined ? "true" : "false"} dir="auto">
      <div className="lumen-note-card-head">
        <strong className="lumen-note-card-title" dir="auto">
          {title}
        </strong>
        <button type="button" className="lumen-note-card-open" onClick={() => onOpen(path)} title={t("canvas.card.open")} data-testid="note-card-open">
          {t("canvas.card.open")}
        </button>
      </div>
      {md === null ? (
        <p className="lumen-note-card-missing">{t("canvas.card.missing", { path })}</p>
      ) : editing ? (
        <textarea
          ref={area}
          className="lumen-note-card-edit"
          dir="auto"
          value={draft}
          aria-label={t("canvas.card.editLabel", { name: title })}
          data-testid="note-card-edit"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void save();
            }
          }}
        />
      ) : (
        <div
          className="lumen-note-card-body"
          dir="auto"
          data-testid="note-card-body"
          onDoubleClick={() => {
            if (md == null) return;
            setDraft(splitFrontmatter(md).body);
            setEditing(true);
          }}
        >
          {/* empty-action: the card itself — a click opens the note for editing */}
          {md === undefined ? "…" : noteExcerpt(md, 12, 900) || t("canvas.card.empty")}
          {active && md != null && <div className="lumen-note-card-hint">{t("canvas.card.editHint")}</div>}
        </div>
      )}
    </div>
  );
}
