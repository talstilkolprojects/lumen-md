/**
 * T31: real alt text for pasted/dropped images, filled in the background —
 * OCR on this device (Hebrew + English), else a local vision model; the
 * file-name alt stays otherwise. Works for workspace URLs and for the
 * data-URL fallback (no OPFS / asset store failed) alike: the original
 * `File` is what is read, never the URL.
 */
import type { EditorView } from "@codemirror/view";

export interface PlacedImage {
  file: File;
  url: string;
  alt: string;
}

export async function fillPastedImageText(view: EditorView, placed: PlacedImage[], lang: string): Promise<void> {
  const { imageText, escapeAlt, escapeTitle, documentLanguage } = await import("../ai/vision");
  // Captions follow the note's language; `lang` (the UI's) when it is unclear.
  lang = await documentLanguage(view.state.doc.toString(), lang);
  await Promise.all(
    placed.map(async (p) => {
      const res = await imageText(p.file, lang, { name: p.file.name }).catch(() => null);
      if (!res || res.source === "none") return;
      const target = `![${p.alt}](${p.url})`;
      const at = view.state.doc.toString().indexOf(target);
      if (at < 0) return; // the user already changed it
      const title = res.title ? ` "${escapeTitle(res.title)}"` : "";
      view.dispatch({ changes: { from: at, to: at + target.length, insert: `![${escapeAlt(res.alt)}](${p.url}${title})` } });
    }),
  );
}
