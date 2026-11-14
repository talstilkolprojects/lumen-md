/**
 * The one door every export goes through (plan W5.11): the note's text with
 * its `<redact>` passages and hidden comments removed, and its photos without
 * metadata. Kept tiny for the startup bundle; the work loads on first export.
 */

/**
 * `inlinePhotos`: also inline the vault's photos as clean data: URLs (PDF and
 * HTML, which would otherwise carry, or link to, the original file).
 */
export async function exportReadyText(markdown: string, inlinePhotos = false): Promise<string> {
  const { prepareForExport } = await import("../lib/redaction");
  // No static imports: the CLI (lumen convert / publish) loads the exporters without the vault.
  const readAsset = inlinePhotos ? (await import("./workspace")).readWorkspaceBlob : undefined;
  const { text } = await prepareForExport(markdown, readAsset ? { readAsset } : {});
  return text;
}
