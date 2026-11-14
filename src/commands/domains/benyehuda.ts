/**
 * The Ben-Yehuda library (plan W7.7), in the palette:
 *
 *  - "Download the Ben-Yehuda library…": the catalogue of the project's
 *    public-domain dump and the works of the authors you pick, once, from
 *    GitHub, after you confirm. Then everything is local.
 *  - "Search the Ben-Yehuda library…": author, work and text, on this device.
 *    A downloaded work opens as a note (the reading view, ==highlights==).
 *  - "Copy as a quote (Ben-Yehuda)": the selected passage of an open work
 *    as a quote with author, work, link and the public-domain mark.
 *  - "Highlight this passage": the selection goes to the highlights hub.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { uiAlert, uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { useToastStore } from "../../store/useToastStore";
import { useAppStore } from "../../store/useStore";
import type { CommandContext } from "./context";
import { explainError } from "../../lib/userError";
import { isSourceEnabled, setSourceEnabled } from "../../sources/open/gate";

type BenYehuda = typeof import("../../sources/benyehuda/app");
const benyehuda = (): Promise<BenYehuda> => import("../../sources/benyehuda/app");

async function ensureOn(): Promise<boolean> {
  if (isSourceEnabled("benyehuda")) return true;
  if (!(await uiConfirm({ message: t("benyehuda.enable") }))) return false;
  setSourceEnabled("benyehuda", true);
  return true;
}

const fail = (e: unknown) => useToastStore.getState().push({ kind: "error", title: t("benyehuda.failed", { error: explainError(e) }) });

function selected(ctx: CommandContext): string {
  const view = ctx.getEditorView?.();
  if (!view) return "";
  const { from, to } = view.state.selection.main;
  return from === to ? "" : view.state.sliceDoc(from, to);
}

export function buildBenYehudaCommands(ctx: CommandContext): Command[] {
  const group = t("group.insert");
  return [
    {
      id: "sources.benyehudaDownload",
      label: t("cmd.sources.benyehudaDownload"),
      hint: t("cmd.sources.benyehudaDownload.hint"),
      icon: cmdIcons.Download,
      group,
      action: async () => {
        const b = await benyehuda();
        if (!(await ensureOn())) return;
        const confirm = () => uiConfirm({ message: t("benyehuda.confirm") });
        try {
          const works = await b.getCatalogue(confirm);
          if (!works) return;
          const authors = b.authorsOf(works);
          const pick = await uiSelect({ message: t("benyehuda.pickAuthor", { count: authors.length }), choices: authors.slice(0, 300).map((a) => ({ value: a.name, label: `${a.name} (${a.count})` })) });
          if (!pick) return;
          const toast = useToastStore.getState();
          const r = await b.download([pick], confirm, (done, total) => {
            if (done === total || done % 25 === 0) toast.push({ kind: "info", title: t("benyehuda.progress", { done, total }) });
          });
          if (!r) return;
          await b.library(true);
          toast.push({ kind: "success", title: t("benyehuda.downloaded", { count: r.works, author: pick }) });
        } catch (e) {
          fail(e);
        }
      },
    },
    {
      id: "sources.benyehudaSearch",
      label: t("cmd.sources.benyehudaSearch"),
      hint: t("cmd.sources.benyehudaSearch.hint"),
      icon: cmdIcons.FileText,
      group,
      action: async () => {
        const b = await benyehuda();
        const lib = await b.library();
        if (!lib.size) {
          await uiAlert({ message: t("benyehuda.empty") });
          return;
        }
        const q = (await uiPrompt({ message: t("benyehuda.prompt"), defaultValue: selected(ctx) }))?.trim();
        if (!q) return;
        const hits = lib.search(q, 20);
        if (!hits.length) {
          await uiAlert({ message: t("benyehuda.none", { query: q }) });
          return;
        }
        const pick = await uiSelect({
          message: t("benyehuda.results", { count: hits.length }),
          choices: hits.map((h) => ({ value: String(h.work.id), label: `${b.plain(h.work.title)} — ${h.work.authors}${h.downloaded ? "" : ` (${t("benyehuda.notDownloaded")})`}${h.snippet ? ` · ${b.plain(h.snippet).slice(0, 60)}` : ""}` })),
        });
        const hit = hits.find((h) => String(h.work.id) === pick);
        if (!hit) return;
        const note = await b.workNote(hit.work);
        if (!note) {
          await uiAlert({ message: t("benyehuda.downloadFirst", { author: hit.work.authors }) });
          return;
        }
        useAppStore.getState().openTab({ name: note.path.split("/").pop()!, content: note.content, workspaceName: note.path });
      },
    },
    {
      id: "sources.benyehudaQuote",
      label: t("cmd.sources.benyehudaQuote"),
      hint: t("cmd.sources.benyehudaQuote.hint"),
      icon: cmdIcons.Quote,
      group,
      action: async () => {
        const b = await benyehuda();
        const passage = selected(ctx);
        const work = await b.workOfNote(ctx.liveDoc().content);
        if (!passage || !work) {
          await uiAlert({ message: t("benyehuda.selectInWork") });
          return;
        }
        const quote = b.quoteBlock(work, passage);
        await navigator.clipboard?.writeText(quote).catch(() => undefined);
        useToastStore.getState().push({ kind: "success", title: t("benyehuda.copied") });
      },
    },
    {
      id: "sources.benyehudaHighlight",
      label: t("cmd.sources.benyehudaHighlight"),
      hint: t("cmd.sources.benyehudaHighlight.hint"),
      icon: cmdIcons.Pencil,
      group,
      action: async () => {
        const b = await benyehuda();
        const passage = selected(ctx);
        const work = await b.workOfNote(ctx.liveDoc().content);
        if (!passage || !work) {
          await uiAlert({ message: t("benyehuda.selectInWork") });
          return;
        }
        try {
          const path = await b.highlight(work, passage);
          useToastStore.getState().push({ kind: "success", title: t("benyehuda.highlighted", { path }) });
        } catch (e) {
          fail(e);
        }
      },
    },
  ];
}
