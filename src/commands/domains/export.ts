/** Export commands: the open note to each format, each exporter loaded on first use. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import type { CommandContext } from "./context";

/** Export the open note to each format (exporters load on first use), and print. */
export function buildExportCommands({ handleExportHtml, liveDoc }: CommandContext): Command[] {
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
      id: "file.exportDocx",
      label: t("cmd.file.exportDocx") ?? "Export to Word (.doc)",
      hint: t("cmd.file.exportDocx.hint") ?? "Download as Word document",
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
      id: "file.exportRtf",
      label: t("cmd.file.exportRtf"),
      hint: t("cmd.file.exportRtf.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        // Snapshot before any await: a tab switch while the chunk loads must not export another note.
        const doc = liveDoc();
        const { markdownToRtf, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.rtf`, markdownToRtf(doc.content), "application/rtf");
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
        const { markdownToLatex, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.tex`, markdownToLatex(doc.content), "application/x-latex");
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
        const { markdownToRst, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.rst`, markdownToRst(doc.content), "text/x-rst");
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
        const { markdownToAdoc, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.adoc`, markdownToAdoc(doc.content), "text/asciidoc");
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
        const { markdownToOrg, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.org`, markdownToOrg(doc.content), "text/x-org");
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
        const { markdownToOpml, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.opml`, markdownToOpml(doc.content, baseName), "text/x-opml");
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
        const { markdownToRevealHtml, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(
          `${baseName}.slides.html`,
          markdownToRevealHtml(doc.content, baseName),
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
        const { markdownToEpubBytes, downloadBytes } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        const bytes = await markdownToEpubBytes(doc.content, baseName);
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
        const { markdownToIpynb, downloadText } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        downloadText(`${baseName}.ipynb`, markdownToIpynb(doc.content), "application/x-ipynb+json");
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
        const { markdownToStaticSiteBytes, downloadBytes } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        const bytes = await markdownToStaticSiteBytes(doc.content, baseName);
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
        const { markdownToPptxBytes, PPTX_MIME } = await import("../../storage/exportPptx");
        const { downloadBytes } = await import("../../storage/exportFormats");
        const baseName = doc.name.replace(/\.[^.]+$/, "");
        const bytes = await markdownToPptxBytes(doc.content, baseName);
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
      id: "file.print",
      label: t("cmd.file.print"),
      hint: t("cmd.file.print.hint"),
      shortcut: "⌘P",
      icon: cmdIcons.Printer,
      group: t("group.file"),
      action: () => {
        // Make sure preview is visible before printing.
        useAppStore.getState().setMode("preview");
        setTimeout(() => window.print(), 50);
      },
    },
  ];
}
