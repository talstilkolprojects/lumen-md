/**
 * The source editor's copy and cut (plan W7.3): text/plain keeps the
 * Markdown, text/html gets the rendering from ./copyHtml. An empty selection
 * is left to CodeMirror (it copies the whole line).
 */
import type { EditorView } from "@codemirror/view";
import { markdownToClipboardHtml } from "./copyHtml";

export function copySelectionWithHtml(event: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  const data = event.clipboardData;
  const ranges = view.state.selection.ranges.filter((r) => !r.empty);
  if (!data || !ranges.length) return false;
  const md = ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n");
  event.preventDefault();
  data.setData("text/plain", md);
  data.setData("text/html", markdownToClipboardHtml(md));
  if (cut && !view.state.readOnly) {
    view.dispatch({ changes: ranges.map((r) => ({ from: r.from, to: r.to })), userEvent: "delete.cut", scrollIntoView: true });
  }
  return true;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

/** The image an embed at `col` of `line` shows (`![[x.png|300]]` or `![alt](x.png)`), or null. */
export function imageEmbedAt(line: string, col: number): string | null {
  for (const m of line.matchAll(/!\[\[([^\]|#\n]+)[^\]\n]*\]\]|!\[[^\]\n]*\]\(\s*<?([^)>\s]+)>?[^)\n]*\)/g)) {
    const start = m.index ?? 0;
    if (col < start || col > start + m[0].length) continue;
    const target = (m[1] ?? m[2] ?? "").trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https?:/i.test(target)) return null;
    return IMAGE.test(target.replace(/[?#].*$/, "")) ? target : null;
  }
  return null;
}
