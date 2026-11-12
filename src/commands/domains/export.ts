/** Export commands: the open note to each format, each exporter loaded on first use. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import type { CommandContext } from "./context";
import { exportReadyText } from "../../storage/exportReady";

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
      action: async () => {
        const view = getEditorView?.();
        if (!view) return;
        const [{ caseNumberAt, rulingFromMatch }, dialog] = await Promise.all([import("../../citations/legal"), import("../../citations/LegalCiteDialog")]);
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const m = caseNumberAt(line.text, view.state.selection.main.head - line.from);
        if (!m) {
          showAiToast(t("toast.cite.noCaseNumber"), "info");
          dialog.openLegalCiteDialog();
          return;
        }
        // why: the citation replaces the case number it was made from
        view.dispatch({ selection: { anchor: line.from + m.from, head: line.from + m.to } });
        dialog.openLegalCiteDialog(rulingFromMatch(m));
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
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToRtf, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.rtf`, markdownToRtf(content), "application/rtf");
      },
    },
    {
      id: "file.exportMarkdownAiMarks",
      label: t("cmd.ai.marks.export"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await (as above).
        const doc = liveDoc();
        const view = getEditorView?.() ?? null;
        const [{ withAuthorshipFooter, loadSpans }, { downloadText }] = await Promise.all([import("../../ai/authorship"), import("../../storage/exportFormats")]);
        // The open source editor has the live marks; otherwise the saved ones.
        const spans = view ? (await import("../../editor/aiAuthorship")).aiSpansOf(view) : loadSpans(doc.workspaceName ?? `file:${doc.name}`, doc.content);
        const text = view ? view.state.doc.toString() : doc.content;
        // W5.11: what is marked <redact> leaves the file (the footer only counts offsets).
        const md = await exportReadyText(withAuthorshipFooter(text, spans));
        downloadText(doc.name.endsWith(".md") ? doc.name : `${doc.name}.md`, md, "text/markdown");
      },
    },
    {
      id: "file.exportLatex",
      label: t("cmd.file.exportLatex"),
      hint: t("cmd.file.exportLatex.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToLatex, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.tex`, markdownToLatex(content), "application/x-latex");
      },
    },
    {
      id: "file.exportRst",
      label: t("cmd.file.exportRst"),
      hint: t("cmd.file.exportRst.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToRst, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.rst`, markdownToRst(content), "text/x-rst");
      },
    },
    {
      id: "file.exportAdoc",
      label: t("cmd.file.exportAdoc"),
      hint: t("cmd.file.exportAdoc.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToAdoc, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.adoc`, markdownToAdoc(content), "text/asciidoc");
      },
    },
    {
      id: "file.exportOrg",
      label: t("cmd.file.exportOrg"),
      hint: t("cmd.file.exportOrg.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToOrg, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.org`, markdownToOrg(content), "text/x-org");
      },
    },
    {
      id: "file.exportOpml",
      label: t("cmd.file.exportOpml"),
      hint: t("cmd.file.exportOpml.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToOpml, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.opml`, markdownToOpml(content, baseName), "text/x-opml");
      },
    },
    {
      id: "file.exportReveal",
      label: t("cmd.file.exportReveal"),
      hint: t("cmd.file.exportReveal.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToRevealHtml, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(
          `${baseName}.slides.html`,
          markdownToRevealHtml(content, baseName),
          "text/html",
        );
      },
    },
    {
      id: "file.exportEpub",
      label: t("cmd.file.exportEpub"),
      hint: t("cmd.file.exportEpub.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToEpubBytes, downloadBytes } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        const bytes = await markdownToEpubBytes(content, baseName);
        downloadBytes(`${baseName}.epub`, bytes, "application/epub+zip");
      },
    },
    {
      id: "file.exportIpynb",
      label: t("cmd.file.exportIpynb"),
      hint: t("cmd.file.exportIpynb.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToIpynb, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.ipynb`, markdownToIpynb(content), "application/x-ipynb+json");
      },
    },
    {
      id: "file.exportSite",
      label: t("cmd.file.exportSite"),
      hint: t("cmd.file.exportSite.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToStaticSiteBytes, downloadBytes } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        const bytes = await markdownToStaticSiteBytes(content, baseName);
        downloadBytes(`${baseName}-site.zip`, bytes, "application/zip");
      },
    },
    {
      id: "file.exportPptx",
      label: t("cmd.file.exportPptx"),
      hint: t("cmd.file.exportPptx.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const content = await exportReadyText(doc.content);
        const { markdownToPptxBytes, PPTX_MIME } = await import("../../storage/exportPptx");
        const { downloadBytes } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        const bytes = await markdownToPptxBytes(content, baseName);
        downloadBytes(`${baseName}.pptx`, bytes, PPTX_MIME);
      },
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
        const content = await exportReadyText(doc.content);
        const { downloadText } = await import("../../storage/exportFormats");
        downloadText(`${doc.name.replace(/\.(md|markdown)$/i, "") || "note"}.md`, content, "text/markdown");
      },
    },
    {
      // W5.11: wrap the selection in <redact>; it stays in the note and leaves every export.
      id: "edit.redact",
      label: t("cmd.edit.redact"),
      hint: t("cmd.edit.redact.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.edit"),
      action: async () => {
        const view = getEditorView?.() ?? null;
        const sel = view?.state.selection.main;
        if (!view || !sel || sel.empty) {
          const [{ uiAlert }] = await Promise.all([import("../../ui/PromptDialog"), import("../../lib/journalistStrings")]);
          await uiAlert({ message: t("redact.empty") });
          return;
        }
        const { wrapRedaction } = await import("../../lib/redaction");
        view.dispatch({ changes: { from: sel.from, to: sel.to, insert: wrapRedaction(view.state.sliceDoc(sel.from, sel.to)) } });
        view.focus();
      },
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
