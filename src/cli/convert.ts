/**
 * Headless document conversion — the core of the `lumen convert` CLI.
 *
 * Uses ONLY the DOM-free converters so it runs in plain Node (no jsdom):
 *   md → tex / rst / org / adoc / rtf / opml / ipynb   (export)
 *   md → docx / epub / pptx                            (binary export)
 *   tex / rst / org / adoc / csv / tsv / json / ipynb → md   (import)
 *
 * The dispatch is a pure function (tested in src/__tests__/cliConvert.test.ts);
 * bin/lumen.ts is the thin file-I/O wrapper.
 *
 * Markdown going out goes through the export door first (plan W5.11, review
 * 12.11): `<redact>` passages and hidden comments are removed, inline photos
 * lose their metadata. Imports are not touched.
 */
import {
  markdownToLatex,
  markdownToRst,
  markdownToOrg,
  markdownToAdoc,
  markdownToRtf,
  markdownToOpml,
  markdownToIpynb,
  markdownToEpubBytes,
} from "../storage/exportFormats";
import { markdownToDocxBytes } from "../storage/exportDocx";
import { markdownToPptxBytes } from "../storage/exportPptx";
import {
  latexToMarkdown,
  rstToMarkdown,
  orgToMarkdown,
  adocToMarkdown,
  csvToMarkdown,
  jsonToMarkdown,
  ipynbToMarkdown,
} from "../storage/fileFormats";
import { prepareForExport, prepareForExportSync } from "../lib/redaction";

const EXPORTERS: Record<string, (md: string) => string> = {
  tex: markdownToLatex,
  latex: markdownToLatex,
  rst: markdownToRst,
  org: markdownToOrg,
  adoc: markdownToAdoc,
  rtf: markdownToRtf,
  opml: (md) => markdownToOpml(md),
  ipynb: (md) => markdownToIpynb(md),
};

const IMPORTERS: Record<string, (text: string) => string> = {
  tex: latexToMarkdown,
  latex: latexToMarkdown,
  rst: rstToMarkdown,
  org: orgToMarkdown,
  adoc: adocToMarkdown,
  csv: csvToMarkdown,
  tsv: csvToMarkdown,
  json: jsonToMarkdown,
  ipynb: ipynbToMarkdown,
};

const extOf = (name: string): string => (name.split(".").pop() || "").toLowerCase();

/** Binary export targets — real OOXML/EPUB bytes (work in Node via zip.ts). */
const BINARY_EXPORTERS: Record<string, (md: string, title: string) => Promise<Uint8Array>> = {
  docx: (md) => markdownToDocxBytes(md),
  epub: (md) => markdownToEpubBytes(md),
  pptx: (md, title) => markdownToPptxBytes(md, title),
};

export function isBinaryTarget(ext: string): boolean {
  return ext.toLowerCase() in BINARY_EXPORTERS;
}

export function listFormats(): { export: string[]; import: string[] } {
  return {
    export: [...Object.keys(EXPORTERS), ...Object.keys(BINARY_EXPORTERS)].sort(),
    import: Object.keys(IMPORTERS).sort(),
  };
}

/**
 * Convert `inText` (named `inName`) to Markdown, or — when the input is
 * Markdown — to the format implied by `toExt`. Returns the suggested output
 * filename and the converted text. Throws on unsupported formats.
 */
export function convert(
  inName: string,
  inText: string,
  toExt?: string,
): { outName: string; outText: string } {
  const inExt = extOf(inName);
  const base = inName.replace(/\.[^.]+$/, "");

  if (inExt === "md" || inExt === "markdown") {
    const to = (toExt || "").toLowerCase();
    const fn = EXPORTERS[to];
    if (!fn)
      throw new Error(
        `Unknown export target ".${to}". Supported: ${Object.keys(EXPORTERS).join(", ")}`,
      );
    return { outName: `${base}.${to}`, outText: fn(prepareForExportSync(inText)) };
  }

  const fn = IMPORTERS[inExt];
  if (!fn)
    throw new Error(
      `Unknown source format ".${inExt}". Supported: ${Object.keys(IMPORTERS).join(", ")}`,
    );
  return { outName: `${base}.md`, outText: fn(inText) };
}

/**
 * Request handler for the headless HTTP API (api-server/server.ts):
 * `{ name, text, to? }` → `{ name, text }`. Throws on bad input or
 * unsupported formats (the server maps that to a 400).
 */
export function handleConvert(payload: {
  name?: unknown;
  text?: unknown;
  to?: unknown;
}): { name: string; text: string } {
  if (typeof payload?.name !== "string" || typeof payload?.text !== "string")
    throw new Error("convert: 'name' and 'text' string fields are required");
  const { outName, outText } = convert(
    payload.name,
    payload.text,
    typeof payload.to === "string" ? payload.to : undefined,
  );
  return { name: outName, text: outText };
}

/** Convert Markdown to a binary document (docx/epub) — returns raw bytes. */
export async function convertBinary(
  inName: string,
  inText: string,
  toExt: string,
): Promise<{ outName: string; bytes: Uint8Array }> {
  const inExt = extOf(inName);
  if (inExt !== "md" && inExt !== "markdown")
    throw new Error(`Binary export only supports Markdown input (got ".${inExt}")`);
  const to = toExt.toLowerCase();
  const fn = BINARY_EXPORTERS[to];
  if (!fn)
    throw new Error(
      `Unknown binary target ".${to}". Supported: ${Object.keys(BINARY_EXPORTERS).join(", ")}`,
    );
  const base = inName.replace(/\.[^.]+$/, "");
  const { text } = await prepareForExport(inText);
  return { outName: `${base}.${to}`, bytes: await fn(text, base.split(/[\\/]/).pop() || base) };
}
