/**
 * Jewish sources from Sefaria (plan W5.1), in the palette:
 *
 *  - "Insert a source from Sefaria…": the selection (or a typed reference —
 *    "בראשית א:א", "ב״ר א, א", "Berakhot 2a") becomes a quote with the
 *    Hebrew and its translation where their licences are free, each
 *    version's licence, a Sefaria link, and a verse link for the graph.
 *    A saved (offline) copy is used first, with no request; otherwise the
 *    reference — and only the reference — goes to sefaria.org, after the
 *    user confirms, through the privacy ledger.
 *  - "Save this source for offline": the user-initiated offline copy
 *    (free text only) in Sources/Sefaria/.
 *  - "My notes on this verse": every note that cites the same verse.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { uiAlert, uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { useToastStore } from "../../store/useToastStore";
import { useAppStore } from "../../store/useStore";
import type { CommandContext } from "./context";

type Sefaria = typeof import("../../sources/sefaria/app");
const sefaria = (): Promise<Sefaria> => import("../../sources/sefaria/app");

/** The selected text in the source editor, or the current line when nothing is selected. */
function selectionOrLine(ctx: CommandContext): { text: string; from: number; to: number } | null {
  const view = ctx.getEditorView?.();
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from !== to) return { text: view.state.sliceDoc(from, to), from, to };
  const line = view.state.doc.lineAt(from);
  return { text: line.text, from: line.from, to: line.to };
}

export function buildSourceCommands(ctx: CommandContext): Command[] {
  const group = t("group.insert");
  return [
    {
      id: "sources.insertSefaria",
      label: t("cmd.sources.insert"),
      hint: t("cmd.sources.insert.hint"),
      icon: cmdIcons.Quote,
      group,
      action: async () => {
        const s = await sefaria();
        const here = selectionOrLine(ctx);
        const fromSelection = here && s.parseSourceRef(here.text.trim()) ? here : null;
        const typed = fromSelection ? fromSelection.text.trim() : await uiPrompt({ message: t("sources.prompt"), defaultValue: "" });
        if (!typed) return;
        const ref = s.parseSourceRef(typed);
        if (!ref) {
          await uiAlert({ message: t("sources.notARef", { text: typed }) });
          return;
        }
        let result;
        try {
          result = await s.lookup(ref, () => uiConfirm({ message: t("sources.confirmFetch", { ref: ref.tref }) }));
        } catch (e) {
          useToastStore.getState().push({ kind: "error", title: t("sources.failed", { error: (e as Error).message }) });
          return;
        }
        if (!result) return;
        const block = s.quoteBlock(result.passage);
        const view = ctx.getEditorView?.();
        if (view && fromSelection) {
          view.dispatch({ changes: { from: fromSelection.from, to: fromSelection.to, insert: block }, userEvent: "input" });
          view.focus();
        } else ctx.insertSnippet(`\n${block}\n`);
        const linkOnly = result.passage.versions.filter((v) => !v.free).length;
        useToastStore.getState().push({
          kind: "success",
          title: t("sources.inserted", { ref: result.passage.heRef ?? ref.he }),
          ...(linkOnly ? { body: t("sources.linkOnly", { count: linkOnly }) } : {}),
          ...(result.from === "network" && result.passage.versions.some((v) => v.free)
            ? { ttlMs: 12_000, action: { label: t("sources.saveOffline"), run: () => void s.saveForOffline(result.passage) } }
            : {}),
        });
      },
    },
    {
      id: "sources.saveOffline",
      label: t("cmd.sources.saveOffline"),
      hint: t("cmd.sources.saveOffline.hint"),
      icon: cmdIcons.Download,
      group,
      action: async () => {
        const s = await sefaria();
        const here = selectionOrLine(ctx);
        const refs = here ? s.sourceRefsIn(here.text).concat(s.parseSourceRef(here.text.trim()) ?? []) : [];
        const ref = refs[0] ?? s.parseSourceRef((await uiPrompt({ message: t("sources.prompt"), defaultValue: "" })) ?? "");
        if (!ref) return;
        try {
          const r = await s.lookup(ref, () => uiConfirm({ message: t("sources.confirmFetch", { ref: ref.tref }) }));
          if (!r) return;
          const path = await s.saveForOffline(r.passage);
          if (path) useToastStore.getState().push({ kind: "success", title: t("sources.saved", { path }) });
        } catch (e) {
          useToastStore.getState().push({ kind: "error", title: t("sources.failed", { error: (e as Error).message }) });
        }
      },
    },
    {
      id: "sources.notesOnVerse",
      label: t("cmd.sources.notesOnVerse"),
      hint: t("cmd.sources.notesOnVerse.hint"),
      icon: cmdIcons.Link,
      group,
      action: async () => {
        const s = await sefaria();
        const here = selectionOrLine(ctx);
        const doc = ctx.liveDoc();
        const ref = (here && (s.sourceRefsIn(here.text)[0] ?? s.parseSourceRef(here.text.trim()))) || s.refOfSourceNote(doc.content);
        if (!ref) {
          await uiAlert({ message: t("sources.noVerseHere") });
          return;
        }
        const paths = await s.notesOnVerse(ref);
        if (!paths.length) {
          await uiAlert({ message: t("sources.noNotes", { ref: ref.he }) });
          return;
        }
        const pick = await uiSelect({ message: t("sources.notesTitle", { ref: ref.he, count: paths.length }), choices: paths.map((p) => ({ value: p, label: p })) });
        if (!pick) return;
        const { readWorkspaceFile } = await import("../../storage/workspace");
        useAppStore.getState().openTab({ name: pick.split("/").pop()!, content: await readWorkspaceFile(pick), workspaceName: pick });
      },
    },
  ];
}
