/** Export commands: the open note to each format, each exporter loaded on first use. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import type { CommandContext } from "./context";
import type { ExportKind } from "./exportActions";

/** A text-format export: the body (./exportActions.ts, through the export door) loads on use. */
const exportAs = (doc: { name: string; content: string }, kind: ExportKind) => import("./exportActions").then((m) => m.exportAs(doc, kind));

/** Export the open note to each format (exporters load on first use), and print. */
export function buildExportCommands({ handleExportHtml, liveDoc, getEditorView }: CommandContext): Command[] {
  return [
    {
      id: "file.exportHtml",
      label: t("cmd.file.exportHtml"),
      hint: t("cmd.file.exportHtml.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: handleExportHtml,
    },
    {
      // 4.18: the picked notes as a website (GitHub Pages or a .zip); the dialog loads on use.
      id: "file.publishSite",
      label: t("cmd.file.publishSite"),
      hint: t("cmd.file.publishSite.hint"),
      icon: cmdIcons.Link,
      group: t("group.file"),
      action: () => {
        void import("../../ui/PublishSiteDialog").then((m) => m.openPublishSite());
      },
    },
    {
      // W5.10: a read-only copy of the open note inside an encrypted link (no server); the dialog loads on use.
      id: "file.shareLink",
      label: t("cmd.file.shareLink"),
      hint: t("cmd.file.shareLink.hint"),
      icon: cmdIcons.Link,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not share another note.
        const doc = liveDoc();
        // Review 12.11 + W5.11: a link is an export, so it carries the export door's text (<redact>
        // passages and hidden comments removed; photos are not inlined: a link has no room for them).
        const [{ openShareLink }, { exportReadyText }] = await Promise.all([import("../../share/ShareLinkDialog"), import("../../storage/exportReady")]);
        openShareLink({ title: doc.name, markdown: await exportReadyText(doc.content, false) });
      },
    },
    {
      // W7.19: the open note as a public Standard.site record in the user's own AT Protocol account,
      // after a confirmation that says it is public and permanent (review 20). One note, never in bulk.
      id: "file.publishAtproto",
      label: t("cmd.file.publishAtproto"),
      hint: t("cmd.file.publishAtproto.hint"),
      icon: cmdIcons.Link,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not publish another note.
        const doc = liveDoc();
        const { publishOpenNote } = await import("../../publish/standardSiteActions");
        await publishOpenNote({ path: doc.workspaceName ?? doc.name, markdown: doc.content });
      },
    },
    {
      id: "file.unpublishAtproto",
      label: t("cmd.file.unpublishAtproto"),
      hint: t("cmd.file.unpublishAtproto.hint"),
      icon: cmdIcons.Link,
      group: t("group.file"),
      action: async () => {
        const doc = liveDoc();
        const { unpublishOpenNote } = await import("../../publish/standardSiteActions");
        await unpublishOpenNote({ path: doc.workspaceName ?? doc.name, markdown: doc.content });
      },
    },
    {
      id: "file.exportDocx",
      label: t("cmd.file.exportDocx"),
      hint: t("cmd.file.exportDocx.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const { exportToDocx } = await import("../../storage/exportDocx");
        await exportToDocx(doc.content, doc.name);
      },
    },
    {
      id: "cite.insert",
      label: t("cmd.cite.insert"),
      icon: cmdIcons.FileText,
      group: t("group.tools"),
      shortcut: "⌥⌘C",
      // Plan W2.16: one dialog for every source (BibTeX, CSL-JSON, Zotero); Enter inserts [@key].
      action: () => void import("../../citations/CiteDialog").then((m) => m.openCiteDialog()),
    },
    {
      id: "cite.legal",
      label: t("cmd.cite.legal"),
      hint: t("cmd.cite.legal.hint"),
      icon: cmdIcons.FileText,
      group: t("group.tools"),
      // Plan W5.2: rulings, laws, bills, books and articles by the uniform citation rules.
      action: () => void import("../../citations/LegalCiteDialog").then((m) => m.openLegalCiteDialog()),
    },
    {
      id: "cite.legalFromCase",
      label: t("cmd.cite.legalFromCase"),
      hint: t("cmd.cite.legalFromCase.hint"),
      icon: cmdIcons.FileText,
      group: t("group.tools"),
      // The body loads on use (./citeActions.ts).
      action: () => {
        const view = getEditorView?.();
        if (view) void import("./citeActions").then((m) => m.legalCiteFromCase(view));
      },
    },
    {
      id: "cite.syncZotero",
      label: t("cmd.cite.syncZotero"),
      icon: cmdIcons.FileText,
      group: t("group.tools"),
      action: () => void import("../../citations/run").then((m) => m.syncZoteroLibrary()),
    },
    {
      // W5.16: the institution's formatting, title page and table of contents; the dialog loads on use.
      id: "file.exportAcademic",
      label: t("cmd.file.exportAcademic"),
      hint: t("cmd.file.exportAcademic.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: () => {
        // Snapshot before the import: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        void import("../../ui/AcademicExportDialog").then((m) => m.openAcademicExport({ content: doc.content, name: doc.name }));
      },
    },
    {
      // Plan W5.23: the Web API, for the browser and phones (no Zotero Desktop).
      id: "cite.syncZoteroWeb",
      label: t("cmd.cite.syncZoteroWeb"),
      icon: cmdIcons.FileText,
      group: t("group.tools"),
      action: () => void import("../../citations/run").then((m) => m.syncZoteroWebLibrary()),
    },
    {
      id: "file.exportRtf",
      label: t("cmd.file.exportRtf"),
      hint: t("cmd.file.exportRtf.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "rtf"),
    },
    {
      id: "file.exportMarkdownAiMarks",
      label: t("cmd.ai.marks.export"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot before any await (as above); the body loads on use (./exportActions.ts).
      action: () => {
        const doc = liveDoc();
        const view = getEditorView?.() ?? null;
        void import("./exportActions").then((m) => m.exportWithAiMarks(doc, view));
      },
    },
    {
      id: "file.exportLatex",
      label: t("cmd.file.exportLatex"),
      hint: t("cmd.file.exportLatex.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "latex"),
    },
    {
      id: "file.exportRst",
      label: t("cmd.file.exportRst"),
      hint: t("cmd.file.exportRst.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "rst"),
    },
    {
      id: "file.exportAdoc",
      label: t("cmd.file.exportAdoc"),
      hint: t("cmd.file.exportAdoc.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "adoc"),
    },
    {
      id: "file.exportOrg",
      label: t("cmd.file.exportOrg"),
      hint: t("cmd.file.exportOrg.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "org"),
    },
    {
      id: "file.exportOpml",
      label: t("cmd.file.exportOpml"),
      hint: t("cmd.file.exportOpml.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "opml"),
    },
    {
      id: "file.exportReveal",
      label: t("cmd.file.exportReveal"),
      hint: t("cmd.file.exportReveal.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "reveal"),
    },
    {
      id: "file.exportEpub",
      label: t("cmd.file.exportEpub"),
      hint: t("cmd.file.exportEpub.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "epub"),
    },
    {
      id: "file.exportIpynb",
      label: t("cmd.file.exportIpynb"),
      hint: t("cmd.file.exportIpynb.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "ipynb"),
    },
    {
      id: "file.exportSite",
      label: t("cmd.file.exportSite"),
      hint: t("cmd.file.exportSite.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "site"),
    },
    {
      id: "file.exportPptx",
      label: t("cmd.file.exportPptx"),
      hint: t("cmd.file.exportPptx.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      // Snapshot first: a tab switch while the chunk loads must not export another note.
      action: () => exportAs(liveDoc(), "pptx"),
    },
    {
      id: "file.exportPdf",
      label: t("cmd.file.exportPdf"),
      hint: t("cmd.file.exportPdf.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const { printDocument } = await import("../../ui/PrintExport");
        await printDocument(doc.content, doc.name);
      },
    },
    {
      // W5.11: the note as Markdown, without what is marked <redact> and without hidden comments.
      id: "file.exportMarkdown",
      label: t("cmd.file.exportMarkdown"),
      hint: t("cmd.file.exportMarkdown.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        await (await import("./journalistActions")).exportRedactedMarkdown(doc);
      },
    },
    {
      // W5.11: wrap the selection in <redact>; it stays in the note and leaves every export.
      id: "edit.redact",
      label: t("cmd.edit.redact"),
      hint: t("cmd.edit.redact.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.edit"),
      action: async () => (await import("./journalistActions")).redactSelection(getEditorView?.() ?? null),
    },
    {
      // W5.11: lock the open note with a password of its own (or open, re-lock, change, remove).
      id: "file.notePassword",
      label: t("cmd.file.notePassword"),
      hint: t("cmd.file.notePassword.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: async () => {
        const { notePasswordFlow } = await import("../../ui/notePassword");
        await notePasswordFlow();
      },
    },
    {
      id: "file.print",
      label: t("cmd.file.print"),
      hint: t("cmd.file.print.hint"),
      shortcut: "⌘P",
      icon: cmdIcons.Printer,
      group: t("group.file"),
      action: async () => {
        // W5.11: a note with redacted passages prints through the export, which removes them.
        const doc = liveDoc();
        if (/<redact\s*>/i.test(doc.content)) {
          const { printDocument } = await import("../../ui/PrintExport");
          await printDocument(doc.content, doc.name);
          return;
        }
        // Make sure preview is visible before printing.
        useAppStore.getState().setMode("preview");
        setTimeout(() => window.print(), 50);
      },
    },
  ];
}
