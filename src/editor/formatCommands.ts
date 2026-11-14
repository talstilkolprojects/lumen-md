/**
 * CodeMirror glue for the formatter in `format.ts`.
 *
 * Each command reads the current doc, formats it (Prettier loads lazily on
 * first use), and applies the result as ONE transaction — a single undo
 * step — with the cursor mapped approximately to the same token. If the
 * user typed while Prettier was running, the result is discarded rather
 * than clobbering their edits.
 */

import type { EditorView } from "@codemirror/view";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { log } from "../lib/logger";
import {
  formatBlockAt,
  formatMarkdown,
  mapCursor,
  minimalChange,
  NoFormatterError,
} from "./format";

export type FormatOutcome = "formatted" | "unchanged" | "stale" | "noBlock" | "noFormatter" | "error";

function reportError(err: unknown): FormatOutcome {
  if (err instanceof NoFormatterError) {
    showAiToast(t("format.noFormatter", { lang: err.lang || "text" }), "info");
    return "noFormatter";
  }
  log.warn("format failed", err);
  const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
  showAiToast(t("format.failed", { error: msg }), "error");
  return "error";
}

/** Format the whole markdown document in `view`. */
export async function formatDocumentInView(view: EditorView): Promise<FormatOutcome> {
  const before = view.state.doc.toString();
  const head = view.state.selection.main.head;
  let after: string;
  try {
    after = await formatMarkdown(before);
  } catch (err) {
    return reportError(err);
  }
  if (view.state.doc.toString() !== before) return "stale";
  const change = minimalChange(before, after);
  if (!change) {
    showAiToast(t("format.unchanged"), "info");
    return "unchanged";
  }
  view.dispatch({
    changes: change,
    selection: { anchor: Math.min(mapCursor(before, after, head), after.length) },
    scrollIntoView: true,
    userEvent: "input.format",
  });
  return "formatted";
}

/** Format the fenced code block under the cursor. */
export async function formatCodeBlockInView(view: EditorView): Promise<FormatOutcome> {
  const before = view.state.doc.toString();
  const head = view.state.selection.main.head;
  let result: Awaited<ReturnType<typeof formatBlockAt>>;
  try {
    result = await formatBlockAt(before, head);
  } catch (err) {
    return reportError(err);
  }
  if (!result) {
    showAiToast(t("format.noBlock"), "info");
    return "noBlock";
  }
  if (view.state.doc.toString() !== before) return "stale";
  if (!result.change) {
    showAiToast(t("format.unchanged"), "info");
    return "unchanged";
  }
  const newLen = before.length - (result.change.to - result.change.from) + result.change.insert.length;
  view.dispatch({
    changes: result.change,
    selection: { anchor: Math.max(0, Math.min(result.cursor, newLen)) },
    scrollIntoView: true,
    userEvent: "input.format",
  });
  return "formatted";
}

/**
 * Format a plain string (used when no CodeMirror view is mounted, e.g. in
 * preview / WYSIWYG mode). Returns null on failure (after toasting).
 */
export async function formatDocumentText(doc: string): Promise<string | null> {
  try {
    const out = await formatMarkdown(doc);
    if (out === doc) showAiToast(t("format.unchanged"), "info");
    return out;
  } catch (err) {
    reportError(err);
    return null;
  }
}

/* ─── Command palette entries ───────────────────────────────────── */

export interface FormatCommandDeps {
  /** Mounted CodeMirror view, or null in preview / WYSIWYG mode. */
  getView: () => EditorView | null;
  getContent: () => string;
  setContent: (s: string) => void;
}

export interface FormatPaletteCommand {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  group?: string;
  action: () => void;
}

/** `Shift+Alt+F` rendered for the current platform. */
export function formatShortcutLabel(isMac: boolean): string {
  return isMac ? "⇧⌥F" : "Shift+Alt+F";
}

export function buildFormatCommands(deps: FormatCommandDeps, isMac = false): FormatPaletteCommand[] {
  return [
    {
      id: "edit.formatDocument",
      label: t("cmd.edit.formatDocument"),
      hint: t("cmd.edit.formatDocument.hint"),
      shortcut: formatShortcutLabel(isMac),
      group: t("group.edit"),
      action: () => {
        const view = deps.getView();
        if (view) {
          void formatDocumentInView(view);
          return;
        }
        const before = deps.getContent();
        void formatDocumentText(before).then((out) => {
          // Skip if the doc moved on while Prettier ran.
          if (out !== null && out !== before && deps.getContent() === before) deps.setContent(out);
        });
      },
    },
    {
      id: "edit.formatCodeBlock",
      label: t("cmd.edit.formatCodeBlock"),
      hint: t("cmd.edit.formatCodeBlock.hint"),
      group: t("group.edit"),
      action: () => {
        const view = deps.getView();
        if (!view) {
          showAiToast(t("format.needsSource"), "info");
          return;
        }
        void formatCodeBlockInView(view);
      },
    },
  ];
}
