/**
 * "Handwriting: draw or edit" (plan W5.27). With the source editor's cursor
 * inside an ink block, the pad opens on that ink and saving replaces the
 * block in place (an emptied ink is removed). Otherwise a new ink goes in
 * at the cursor — or at the end of the note when no source editor is
 * mounted (rich editor, preview). Double-clicking an ink in the preview
 * edits it too (`editInkById`).
 */
import type { EditorView } from "@codemirror/view";
import "./inkStrings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { useAppStore } from "../store/useStore";
import { findInkBlocks, inkBlockAt, parseInk, replaceInkBlock, textDirAt, toInsertion, type InkDir } from "./inkModel";

export interface InkHost {
  getView: () => EditorView | null;
  getContent: () => string;
  setContent: (s: string) => void;
}

/** Write `next` over `now`: through the source editor when one is mounted (one undoable change), else the store. */
function writeNote(host: InkHost, now: string, next: string): void {
  const view = host.getView();
  if (!view || view.state.doc.toString() !== now) return host.setContent(next);
  let from = 0;
  while (from < now.length && from < next.length && now[from] === next[from]) from++;
  let a = now.length;
  let b = next.length;
  while (a > from && b > from && now[a - 1] === next[b - 1]) {
    a--;
    b--;
  }
  view.dispatch({ changes: { from, to: a, insert: next.slice(from, b) } });
}

function pageDir(): InkDir {
  return typeof document !== "undefined" && document.documentElement.dir === "rtl" ? "rtl" : "ltr";
}

/** Edit the ink block `id` of the current note in the pad; true if it was found. */
export async function editInkById(host: InkHost, id: string): Promise<boolean> {
  const before = findInkBlocks(host.getContent()).find((b) => b.id === id);
  if (!before) return false;
  const ink = parseInk(host.getContent().slice(before.start, before.end));
  if (!ink) return false;
  const { openInkPad } = await import("./InkPad");
  const edited = await openInkPad(ink, ink.dir);
  if (!edited) return true;
  // The note may have changed while the pad was open: find the block again.
  const now = host.getContent();
  const range = findInkBlocks(now).find((b) => b.id === id);
  if (!range) {
    showAiToast(t("ink.gone"), "error");
    return true;
  }
  writeNote(host, now, replaceInkBlock(now, range, edited));
  showAiToast(t(edited.strokes.length ? "ink.updated" : "ink.removed"), "success");
  return true;
}

export async function drawOrEditInk(host: InkHost): Promise<void> {
  const view = host.getView();
  const content = view ? view.state.doc.toString() : host.getContent();
  const cursor = view ? view.state.selection.main.head : null;
  const at = cursor === null ? null : inkBlockAt(content, cursor);
  if (at) {
    await editInkById({ ...host, getContent: () => host.getView()?.state.doc.toString() ?? host.getContent() }, at.id);
    return;
  }
  const dir = textDirAt(content, cursor ?? content.length, pageDir());
  const { openInkPad } = await import("./InkPad");
  const ink = await openInkPad(null, dir);
  if (!ink) return;
  const block = toInsertion(ink);
  const live = host.getView();
  if (live) {
    const pos = Math.min(live.state.selection.main.head, live.state.doc.length);
    live.dispatch({ changes: { from: pos, insert: block }, selection: { anchor: pos + block.length }, scrollIntoView: true });
    live.focus();
    return;
  }
  const now = host.getContent();
  host.setContent(now.replace(/\n*$/, "") + block.replace(/\n+$/, "\n"));
}

/** The preview's double-click: edit the ink `id` of the open note, through the store. */
export function editInkInNote(id: string): Promise<boolean> {
  return editInkById(
    {
      getView: () => null,
      getContent: () => useAppStore.getState().doc.content,
      setContent: (s: string) => useAppStore.getState().setContent(s),
    },
    id,
  );
}
