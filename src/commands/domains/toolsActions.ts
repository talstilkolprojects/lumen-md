/**
 * The bodies of tools.ts's Hebrew grammar-level and dictionary commands,
 * loaded when one runs (W4.9; train 5, startup budget after the W6.25 split).
 */
import { t } from "../../i18n";
import { uiConfirm } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { explainError } from "../../lib/userError";

/** `view.hebrewGrammarLevel` (moved from tools.ts, which loads this module when the command runs; W4.9). */
export const cycleHebrewGrammarLevel = async (): Promise<void> => {
  const { getGrammarLevel, setGrammarLevel } = await import("../../ai/hebrewSpellService");
  const { GRAMMAR_LEVELS } = await import("../../ai/hebrewGrammar");
  const next = GRAMMAR_LEVELS[(GRAMMAR_LEVELS.indexOf(getGrammarLevel()) + 1) % GRAMMAR_LEVELS.length];
  setGrammarLevel(next);
  const name = { everyday: t("grammar.he.level.everyday"), academic: t("grammar.he.level.academic"), legal: t("grammar.he.level.legal") }[next];
  showAiToast(t("grammar.he.levelSet", { level: name }), "success");
};

/** `view.hebrewGrammarModel` (plan W10.B9): turn the local grammar model on or off, and register it now. */
export const toggleHebrewGrammarModel = async (): Promise<void> => {
  const { grammarModelEnabled, setGrammarModelEnabled, setupGrammarRanker } = await import("../../ai/grammarModel");
  const on = !grammarModelEnabled();
  setGrammarModelEnabled(on);
  const r = await setupGrammarRanker({ enabled: on });
  if (r.registered) showAiToast(t("grammar.he.model.on", { model: r.model }), "success");
  else if (r.reason === "off") showAiToast(t("grammar.he.model.off"), "info");
  else showAiToast(t({ "no-ollama": "grammar.he.model.noOllama", "no-hebrew-model": "grammar.he.model.noHebrewModel", "not-local": "grammar.he.model.notLocal" }[r.reason]), "info");
};

/** `spell.hebrewDictionary` (moved from tools.ts, which loads this module when the command runs; W4.9). */
export const toggleHebrewDictionary = async (): Promise<void> => {
  const svc = await import("../../ai/hebrewSpellService");
  if (await svc.hebrewDictionaryInstalled()) {
    if (!(await uiConfirm({ message: t("spell.he.removeConfirm") }))) return;
    await svc.removeHebrewDictionary();
    showAiToast(t("spell.he.removed"), "info");
    return;
  }
  if (!(await uiConfirm({ message: t("spell.he.downloadConfirm") }))) return;
  try {
    const n = await svc.downloadHebrewDictionary();
    showAiToast(t("spell.he.installed", { n: n.toLocaleString() }), "info");
  } catch (e) {
    showAiToast(t("spell.he.failed", { error: explainError(e) }), "error");
  }
};
