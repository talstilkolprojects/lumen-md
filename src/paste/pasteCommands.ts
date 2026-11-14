/**
 * "Paste as plain text" and "Paste with formatting" (W1.4), in whichever
 * editor is showing. The command reads the clipboard and sends a
 * `lumen-paste` event; the WYSIWYG editor takes it while it is mounted, the
 * source editor otherwise.
 */
import { t } from "../i18n";
import { pastedHtmlToMarkdown } from "./htmlPaste";

export interface PasteDetail {
  /** Plain: the clipboard's text as is. Formatted: its HTML as Markdown. */
  mode: "plain" | "formatted";
  text: string;
  /** The Markdown to insert for "formatted" (the text when there is no HTML). */
  markdown: string;
}

let wysiwygMounted = 0;

/** The WYSIWYG editor counts itself in while mounted. */
export function setWysiwygPasteTarget(on: boolean): void {
  wysiwygMounted = Math.max(0, wysiwygMounted + (on ? 1 : -1));
}

export function wysiwygTakesPaste(): boolean {
  return wysiwygMounted > 0;
}

export async function readClipboard(): Promise<{ html?: string; text: string }> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.read === "function") {
    try {
      const items = await clip.read();
      let html: string | undefined;
      let text = "";
      for (const it of items) {
        if (!html && it.types.includes("text/html")) html = await (await it.getType("text/html")).text();
        if (!text && it.types.includes("text/plain")) text = await (await it.getType("text/plain")).text();
      }
      return { html, text };
    } catch {
      // why: the async clipboard is refused or empty: the caller falls back to the paste event
      // Permission refused or unsupported type: fall back to the text.
    }
  }
  return { text: await clip.readText() };
}

/** Read the clipboard and hand it to the editor. Returns a message when it could not. */
export async function runPaste(mode: PasteDetail["mode"]): Promise<string | null> {
  let clip: { html?: string; text: string };
  try {
    clip = await readClipboard();
  } catch {
    return t("paste.clipboardDenied");
  }
  const markdown = mode === "formatted" && clip.html ? pastedHtmlToMarkdown(clip.html) : clip.text;
  if (!markdown && !clip.text) return t("paste.clipboardEmpty");
  window.dispatchEvent(new CustomEvent<PasteDetail>("lumen-paste", { detail: { mode, text: clip.text, markdown } }));
  return null;
}
