/**
 * The text a share link carries (review 12.11, with plan W5.11 / #473).
 *
 * #473 adds the one door every export goes through,
 * `exportReadyText` in src/storage/exportReady.ts: `<redact>` passages and
 * hidden comments removed, inline photos without their metadata. A share
 * link is an export too, so it must go through that door. This branch is
 * based where that file doesn't exist yet, so the door is looked up at
 * build time: once #473 is merged next to this code, the link uses it with
 * no change here.
 *
 * TODO(#473): when both are merged, replace the lookup with a plain
 * `import { exportReadyText } from "../storage/exportReady"` and drop the
 * fallback.
 */

type ExportDoor = { exportReadyText: (markdown: string, inlinePhotos?: boolean) => Promise<string> };

// Vite resolves this at build time: {} while the file isn't there, its loader once it is. (A
// pattern, not a plain path, so every glob implementation treats a missing file as no match.)
const doors = import.meta.glob<ExportDoor>("../storage/exportReady*.ts");

/** Is the export door (#473) part of this build? */
export function hasExportDoor(): boolean {
  return "../storage/exportReady.ts" in doors;
}

/**
 * The note's text as a share link may carry it: through the export door when
 * the build has it (photos are not inlined: a link has no room for them).
 */
export async function shareReadyText(markdown: string): Promise<string> {
  const load = doors["../storage/exportReady.ts"];
  if (!load) return markdown;
  return (await load()).exportReadyText(markdown, false);
}
