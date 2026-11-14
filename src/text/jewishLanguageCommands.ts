/**
 * The Yiddish and Ladino commands (plan W7.9), loaded when one runs:
 * transliterate the selection (Yiddish ↔ YIVO, Ladino Latin ↔ Hebrew
 * letters) and download or remove the Yiddish spelling list.
 */
import "./jewishLanguagesStrings";
import type { EditorView } from "@codemirror/view";
import { t } from "../i18n";
import { uiConfirm, uiSelect } from "../ui/PromptDialog";
import { showAiToast } from "../ui/AiToast";
import { explainError } from "../lib/userError";
import { latinToYiddish, yiddishToLatin } from "./yiddish";
import { ladinoHebrewToLatin, ladinoLatinToHebrew } from "./ladino";

export type Direction = "yiToLatin" | "latinToYi" | "ladToHebrew" | "ladToLatin";

/** Transliterate `text` one way; `guessed` counts Ladino vowels read from an ambiguous letter. */
export function transliterate(text: string, way: Direction): { text: string; guessed: number } {
  switch (way) {
    case "yiToLatin":
      return { text: yiddishToLatin(text), guessed: 0 };
    case "latinToYi":
      return { text: latinToYiddish(text), guessed: 0 };
    case "ladToHebrew":
      return { text: ladinoLatinToHebrew(text), guessed: 0 };
    case "ladToLatin":
      return ladinoHebrewToLatin(text);
  }
}

/** The likelier way for a selection: Hebrew letters go to Latin, Latin to Hebrew; Yiddish unless the note says Ladino. */
export function defaultDirection(text: string, noteTag: string | null): Direction {
  const hebrew = /[א-ת]/.test(text);
  const ladino = !!noteTag?.startsWith("lad");
  return hebrew ? (ladino ? "ladToLatin" : "yiToLatin") : ladino ? "ladToHebrew" : "latinToYi";
}

export async function runTransliterateCommand(view: EditorView): Promise<void> {
  const sel = view.state.selection.main;
  if (sel.empty) {
    showAiToast(t("jewishLang.translit.noSelection"), "info");
    return;
  }
  const text = view.state.sliceDoc(sel.from, sel.to);
  const { documentLanguage } = await import("./noteLanguageLoader");
  const first = defaultDirection(text, await documentLanguage(view.state.sliceDoc(0, 4000)));
  const ways: Direction[] = ["yiToLatin", "latinToYi", "ladToHebrew", "ladToLatin"];
  const way = await uiSelect({
    message: t("jewishLang.translit.title"),
    defaultValue: first,
    choices: ways.map((w) => ({ value: w, label: t(`jewishLang.translit.${w}`) })),
  });
  if (!way) return;
  const out = transliterate(text, way as Direction);
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: out.text }, selection: { anchor: sel.from, head: sel.from + out.text.length } });
  showAiToast(out.guessed ? t("jewishLang.translit.guessed", { count: out.guessed }) : t("jewishLang.translit.done"), out.guessed ? "info" : "success");
}

export async function runYiddishDictionaryCommand(): Promise<void> {
  const svc = await import("../ai/yiddishSpellService");
  if (await svc.yiddishDictionaryInstalled()) {
    if (!(await uiConfirm({ message: t("jewishLang.dict.removeConfirm") }))) return;
    await svc.removeYiddishDictionary();
    showAiToast(t("jewishLang.dict.removed"), "info");
    return;
  }
  if (!(await uiConfirm({ message: t("jewishLang.dict.downloadConfirm") }))) return;
  try {
    const n = await svc.downloadYiddishDictionary();
    showAiToast(t("jewishLang.dict.installed", { count: n.toLocaleString() }), "success");
  } catch (e) {
    showAiToast(t("jewishLang.dict.failed", { error: explainError(e) }), "error");
  }
}
