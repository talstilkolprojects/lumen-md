/**
 * Storage adapter for the web build.
 * Uses the File System Access API where supported, with a graceful fallback to
 * a hidden <input type="file"> + download trick for Save As.
 */
import { SUPPORTED_IMPORT_EXTENSIONS } from "./importExtensions";
// The converters load on the first import, not at startup (bundle budget).
import type * as FileFormats from "./fileFormats";

/** The converters of the markup formats `convertImported` turns into Markdown. */
export type MarkupConverters = Pick<typeof FileFormats, "rtfToMarkdown" | "htmlToMarkdown" | "xmlToMarkdown">;

declare global {
  interface Window {
    showOpenFilePicker?: (
      options?: OpenFilePickerOptions,
    ) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (
      options?: SaveFilePickerOptions,
    ) => Promise<FileSystemFileHandle>;
  }
  interface OpenFilePickerOptions {
    types?: { description: string; accept: Record<string, string[]> }[];
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
  }
  interface SaveFilePickerOptions {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }
}

const MD_TYPES = [
  {
    description: "Markdown",
    accept: { "text/markdown": [".md", ".markdown"] as string[] },
  },
];
const DATA_TYPES = [
  {
    description: "Markdown / data",
    accept: {
      "text/markdown": [".md", ".markdown"] as string[],
      "text/plain": [".txt", ".rtf"] as string[],
      "text/csv": [".csv", ".tsv"] as string[],
      "text/html": [".html", ".htm"] as string[],
      "text/xml": [".xml"] as string[],
      "application/json": [".json"] as string[],
      "application/msword": [".doc"] as string[],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"] as string[],
    },
  },
];

export interface OpenedFile {
  name: string;
  content: string;
  handle?: FileSystemFileHandle;
}

export async function openFileDialog(): Promise<OpenedFile | null> {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: DATA_TYPES,
      });
      const file = await handle.getFile();
      const imported = await importFile(file);
      return { ...imported, handle };
    } catch (e) {
      // user cancelled
      if ((e as Error).name === "AbortError") return null;
      throw e;
    }
  }
  // Fallback to <input type="file">
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = SUPPORTED_IMPORT_EXTENSIONS.map((e) => `.${e}`).join(",");
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve(await importFile(f));
    };
    input.click();
  });
}

export async function saveFile(
  file: OpenedFile,
  options: { saveAs?: boolean } = {},
): Promise<OpenedFile> {
  // Try existing handle first.
  if (file.handle && !options.saveAs) {
    const handle = file.handle;
    if ("createWritable" in handle) {
      try {
        const writable = await handle.createWritable();
        await writable.write(file.content);
        await writable.close();
        return file;
      } catch {
        /* why: fall through to Save As */
      }
    }
  }

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: file.name || "document.md",
        types: MD_TYPES,
      });
      const writable = await handle.createWritable();
      await writable.write(file.content);
      await writable.close();
      return { ...file, handle, name: handle.name ?? file.name };
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw e;
    }
  }

  // Fallback: trigger a download.
  const blob = new Blob([file.content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name || "document.md";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return file;
}

/**
 * Single entry point for importing any supported file.
 *
 * Tabular/markup formats (csv, tsv, json, rtf, html, xml) keep their special
 * Lumen-block handling via `convertImported` so the auto-table+chart engine
 * fires immediately. Everything else — including binary office formats (docx,
 * odt, epub, pdf) that must be read as bytes, and markup converters (tex, rst,
 * adoc, org, opml, mhtml) — goes through the full converter library, which
 * reads the file itself (text or arrayBuffer as appropriate).
 */
export async function importFile(file: File): Promise<OpenedFile> {
  if (/\.(csv|tsv|json|rtf|html?|xml)$/i.test(file.name)) {
    const raw = await file.text();
    const markup = /\.(rtf|html?|xml)$/i.test(file.name) ? await import("./fileFormats") : undefined;
    return { name: file.name, content: convertImported(file.name, raw, markup) };
  }
  const { fileToMarkdown } = await import("./fileFormats");
  const { name, content } = await fileToMarkdown(file);
  return { name, content };
}

/**
 * Convert imported CSV/JSON files into a small markdown stub that drops the
 * raw content into the corresponding Lumen block, so the auto-table+chart
 * engine kicks in immediately.
 *
 * Exported so tests can exercise the actual transformation rather than a
 * locally-reimplemented copy (which is theatre and can drift silently).
 */
export function convertImported(name: string, raw: string, markup?: MarkupConverters): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    const lang = lower.endsWith(".tsv") ? "tsv" : "csv";
    return `# ${name}\n\n\`\`\`${lang} title="${name}"\n${raw.trim()}\n\`\`\`\n`;
  }
  if (lower.endsWith(".json")) {
    const trimmed = raw.trim();
    let isArray = false;
    try {
      isArray = Array.isArray(JSON.parse(trimmed));
    } catch {
      /* why: malformed json — keep as code block */
    }
    if (isArray) {
      return `# ${name}\n\n\`\`\`json-table title="${name}"\n${trimmed}\n\`\`\`\n`;
    }
    return `# ${name}\n\n\`\`\`json\n${trimmed}\n\`\`\`\n`;
  }
  // rtf / html / xml need the converter library: importFile loads it first.
  if (!markup) return raw;
  const { rtfToMarkdown, htmlToMarkdown, xmlToMarkdown } = markup;
  if (lower.endsWith(".rtf")) {
    return `# ${name}\n\n${rtfToMarkdown(raw)}`;
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return htmlToMarkdown(raw);
  }
  if (lower.endsWith(".xml")) {
    return `# ${name}\n\n${xmlToMarkdown(raw)}`;
  }
  return raw;
}
