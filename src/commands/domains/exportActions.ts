/**
 * The bodies of the text-format export commands (./export.ts), loaded on
 * first use. Every one goes through the export door first (W5.11: <redact>
 * passages and hidden comments never leave the device).
 */
import type { EditorView } from "@codemirror/view";
import { exportReadyText } from "../../storage/exportReady";

/** The formats exported as one file from the open note's text. */
export type ExportKind = "rtf" | "latex" | "rst" | "adoc" | "org" | "opml" | "reveal" | "epub" | "ipynb" | "site" | "pptx";

/** Export `doc` (read by the command before any await) as `kind`. */
export async function exportAs(doc: { name: string; content: string }, kind: ExportKind): Promise<void> {
  const content = await exportReadyText(doc.content);
  const f = await import("../../storage/exportFormats");
  const baseName = doc.name.replace(/\.[^.]+$/, "");
  switch (kind) {
    case "rtf":
      return f.downloadText(`${baseName}.rtf`, f.markdownToRtf(content), "application/rtf");
    case "latex":
      return f.downloadText(`${baseName}.tex`, f.markdownToLatex(content), "application/x-latex");
    case "rst":
      return f.downloadText(`${baseName}.rst`, f.markdownToRst(content), "text/x-rst");
    case "adoc":
      return f.downloadText(`${baseName}.adoc`, f.markdownToAdoc(content), "text/asciidoc");
    case "org":
      return f.downloadText(`${baseName}.org`, f.markdownToOrg(content), "text/x-org");
    case "opml":
      return f.downloadText(`${baseName}.opml`, f.markdownToOpml(content, baseName), "text/x-opml");
    case "reveal":
      return f.downloadText(`${baseName}.slides.html`, f.markdownToRevealHtml(content, baseName), "text/html");
    case "epub":
      return f.downloadBytes(`${baseName}.epub`, await f.markdownToEpubBytes(content, baseName), "application/epub+zip");
    case "ipynb":
      return f.downloadText(`${baseName}.ipynb`, f.markdownToIpynb(content), "application/x-ipynb+json");
    case "site":
      return f.downloadBytes(`${baseName}-site.zip`, await f.markdownToStaticSiteBytes(content, baseName), "application/zip");
    case "pptx": {
      const { markdownToPptxBytes, PPTX_MIME } = await import("../../storage/exportPptx");
      return f.downloadBytes(`${baseName}.pptx`, await markdownToPptxBytes(content, baseName), PPTX_MIME);
    }
  }
}

/** The note as Markdown with its AI-authorship footer; `view` is the open source editor, if any. */
export async function exportWithAiMarks(doc: { name: string; content: string; workspaceName?: string | null }, view: EditorView | null): Promise<void> {
  const [{ withAuthorshipFooter, loadSpans }, { downloadText }] = await Promise.all([import("../../ai/authorship"), import("../../storage/exportFormats")]);
  // The open source editor has the live marks; otherwise the saved ones.
  const spans = view ? (await import("../../editor/aiAuthorship")).aiSpansOf(view) : loadSpans(doc.workspaceName ?? `file:${doc.name}`, doc.content);
  const text = view ? view.state.doc.toString() : doc.content;
  // W5.11: what is marked <redact> leaves the file (the footer only counts offsets).
  const md = await exportReadyText(withAuthorshipFooter(text, spans));
  downloadText(doc.name.endsWith(".md") ? doc.name : `${doc.name}.md`, md, "text/markdown");
}
