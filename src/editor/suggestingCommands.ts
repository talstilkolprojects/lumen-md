/**
 * Command-palette entries for suggesting mode (track changes).
 *
 * Accept / reject all also work without a mounted source editor (preview /
 * WYSIWYG): they rewrite the document text directly. The cursor-based
 * commands need the CodeMirror view.
 */
import type { EditorView } from "@codemirror/view";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { resolveAll } from "./suggesting";
import type { ViewLike } from "./suggestingExtension";

// CodeMirror-backed helpers load with the editor, not with the palette (C1):
// a view only exists once the editor (and CodeMirror) is already loaded.
type Ext = typeof import("./suggestingExtension");
const ext = (): Promise<Ext> => import("./suggestingExtension");
import { getWysiwygSuggestActions } from "./wysiwygSuggestBridge";

export interface SuggestingCommandDeps {
  getView: () => EditorView | null;
  getContent: () => string;
  setContent: (s: string) => void;
  suggesting: boolean;
  toggle: () => void;
}

export interface SuggestingPaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  action: () => void | Promise<void>;
}

export function buildSuggestingCommands(deps: SuggestingCommandDeps): SuggestingPaletteCommand[] {
  const group = t("group.edit");
  const withView = (
    pick: (m: Ext) => (v: ViewLike) => boolean,
    atCursor: boolean,
    wysiwyg?: (a: NonNullable<ReturnType<typeof getWysiwygSuggestActions>>) => boolean,
  ) => async () => {
    const view = deps.getView();
    if (!view) {
      // WYSIWYG mounted instead of the source editor: same command there.
      const actions = getWysiwygSuggestActions();
      if (actions && wysiwyg) {
        if (!wysiwyg(actions)) showAiToast(atCursor ? t("suggest.noneAtCursor") : t("suggest.none"), "info");
        return;
      }
      showAiToast(t("suggest.needsSource"), "info");
      return;
    }
    if (pick(await ext())(view)) view.focus();
    else showAiToast(atCursor ? t("suggest.noneAtCursor") : t("suggest.none"), "info");
  };
  const everywhere = (mode: "accept" | "reject") => async () => {
    const view = deps.getView();
    if (view) {
      const m = await ext();
      const ok = mode === "accept" ? m.acceptAllSuggestions(view) : m.rejectAllSuggestions(view);
      if (!ok) showAiToast(t("suggest.none"), "info");
      return;
    }
    // WYSIWYG mounted: resolve in its live state (the content snapshot may
    // lag behind its debounced listener).
    const actions = getWysiwygSuggestActions();
    if (actions) {
      if (!actions.resolveAll(mode)) showAiToast(t("suggest.none"), "info");
      return;
    }
    const before = deps.getContent();
    const after = resolveAll(before, mode);
    if (after === before) showAiToast(t("suggest.none"), "info");
    else deps.setContent(after);
  };
  return [
    {
      id: "edit.suggesting.toggle",
      label: deps.suggesting ? t("cmd.suggest.toggle.off") : t("cmd.suggest.toggle.on"),
      hint: t("cmd.suggest.toggle.hint"),
      group,
      action: deps.toggle,
    },
    {
      id: "edit.suggesting.accept",
      label: t("cmd.suggest.accept"),
      hint: t("cmd.suggest.accept.hint"),
      group,
      action: withView((m) => m.acceptSuggestionAtCursor, true, (a) => a.resolve("accept")),
    },
    {
      id: "edit.suggesting.reject",
      label: t("cmd.suggest.reject"),
      hint: t("cmd.suggest.reject.hint"),
      group,
      action: withView((m) => m.rejectSuggestionAtCursor, true, (a) => a.resolve("reject")),
    },
    {
      id: "edit.suggesting.acceptAll",
      label: t("cmd.suggest.acceptAll"),
      group,
      action: everywhere("accept"),
    },
    {
      id: "edit.suggesting.rejectAll",
      label: t("cmd.suggest.rejectAll"),
      group,
      action: everywhere("reject"),
    },
    {
      id: "edit.suggesting.next",
      label: t("cmd.suggest.next"),
      group,
      action: withView((m) => m.nextSuggestionCommand, false, (a) => a.jump(1)),
    },
    {
      id: "edit.suggesting.prev",
      label: t("cmd.suggest.prev"),
      group,
      action: withView((m) => m.prevSuggestionCommand, false, (a) => a.jump(-1)),
    },
  ];
}
