/**
 * The file extensions the importer understands (src/storage/fileFormats.ts
 * holds the converters). Kept apart from the converters so the open-file
 * picker can name the formats at startup while the converters and their
 * libraries load only when a file is imported.
 */

export const SUPPORTED_IMPORT_EXTENSIONS = [
  // Plain text + markdown family
  "md", "markdown", "mdown", "mkd", "txt", "text",
  // Tabular
  "csv", "tsv", "json", "xml", "yaml", "yml", "toml",
  // Office
  "rtf", "doc", "docx", "odt", "pptx", "xlsx",
  // Apple iWork
  "pages", "numbers", "key",
  // Archives (Notion export / Obsidian vault)
  "zip",
  // Web
  "html", "htm", "mhtml", "mht", "eml",
  // Documents
  "pdf", "epub",
  // Outlines
  "opml",
  // Other markup
  "tex", "ltx", "rst", "adoc", "asciidoc", "org",
  // Notebooks
  "ipynb",
  // Screenwriting
  "fountain", "spmd",
];

export function isSupportedFormat(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_IMPORT_EXTENSIONS.includes(ext);
}
