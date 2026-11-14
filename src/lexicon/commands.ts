/**
 * The lexicon's palette actions (plan W5.26), loaded on first use: get or
 * remove the pack (asking first, with its size and licence), and look up the
 * word at the cursor.
 */
import type { EditorView } from "@codemirror/view";
import "./strings";
import { t } from "../i18n";
import { uiConfirm } from "../ui/PromptDialog";
import { showAiToast } from "../ui/AiToast";
import { lexiconInstalled } from "./installed";
import { downloadLexicon, lexiconManifest, removeLexicon } from "./store";
import { explainError } from "../lib/userError";

export async function runLexiconPackCommand(): Promise<void> {
  if (lexiconInstalled()) {
    if (!(await uiConfirm({ message: t("lexicon.removeConfirm") }))) return;
    await removeLexicon();
    showAiToast(t("lexicon.removed"), "info");
    return;
  }
  const manifest = await lexiconManifest().catch(() => null);
  if (!manifest) {
    showAiToast(t("lexicon.unavailable"), "info");
    return;
  }
  const mb = (manifest.bytes / 1e6).toFixed(1);
  if (!(await uiConfirm({ message: t("lexicon.downloadConfirm", { mb, count: manifest.count.toLocaleString() }) }))) return;
  try {
    const n = await downloadLexicon();
    showAiToast(t("lexicon.installed", { count: n.toLocaleString() }), "info");
  } catch (e) {
    showAiToast(t("lexicon.failed", { error: explainError(e) }), "error");
  }
}

export async function runLexiconLookupCommand(view: EditorView): Promise<void> {
  if (!lexiconInstalled()) {
    showAiToast(t("lexicon.notInstalled"), "info");
    return;
  }
  const head = view.state.selection.main.head;
  const c = view.coordsAtPos(head);
  const { openLexicon } = await import("./LexiconPopover");
  if (!openLexicon(view, head, { x: c?.left ?? 100, y: (c?.bottom ?? 100) + 4 })) showAiToast(t("lexicon.noWord"), "info");
}
