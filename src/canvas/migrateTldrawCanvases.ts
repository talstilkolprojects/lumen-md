/**
 * One-shot migration: every `canvases/<name>.tldr` in the vault becomes
 * `canvases/<name>.excalidraw` (plan 4.19).
 *
 * Safety rules:
 *   - the `.tldr` file is never written, renamed or deleted — it stays next
 *     to the new file as the backup;
 *   - an existing `.excalidraw` file is never overwritten (the canvas is
 *     reported as skipped), so running the migration twice is harmless;
 *   - the new file is read back before the canvas counts as done; if it
 *     doesn't match, this run's own output is removed so a rerun retries.
 *
 * Lazy-loaded: only the palette command imports it.
 */

import {
  CanvasFileExistsError,
  createExcalidrawCanvas,
  EXCALIDRAW_EXT,
  listTldrawCanvases,
  parseExcalidrawFile,
  serializeExcalidrawFile,
  TLDRAW_EXT,
  type CanvasStore,
} from "./excalidrawFile";
import { tldrawToExcalidraw, type ConversionWarning, type ConversionWarningCode } from "./tldrawToExcalidraw";

function isExcalidrawScene(text: string): boolean {
  try {
    parseExcalidrawFile(text);
    return true;
  } catch {
    return false;
  }
}

export interface MigratedCanvas {
  name: string;
  shapes: number;
  elements: number;
  warnings: ConversionWarning[];
}

export interface CanvasMigrationReport {
  converted: MigratedCanvas[];
  /** Canvases that already had a `.excalidraw` file. */
  skipped: { name: string; reason: "exists" }[];
  failed: { name: string; error: string }[];
}

export interface MigrateOptions {
  /** Timestamp written into the new elements (default: now). */
  updated?: number;
}

export async function migrateTldrawCanvases(store: CanvasStore, options: MigrateOptions = {}): Promise<CanvasMigrationReport> {
  const report: CanvasMigrationReport = { converted: [], skipped: [], failed: [] };
  const updated = options.updated ?? Date.now();
  const existing = new Set(await store.list());
  for (const name of await listTldrawCanvases(store)) {
    if (existing.has(name + EXCALIDRAW_EXT)) {
      report.skipped.push({ name, reason: "exists" });
      continue;
    }
    try {
      const text = await store.read(name + TLDRAW_EXT);
      if (text === null) throw new Error("could not read the .tldr file");
      const result = tldrawToExcalidraw(text, { updated });
      const expected = serializeExcalidrawFile(result.file);
      await createExcalidrawCanvas(store, name, result.file);
      const back = await store.read(name + EXCALIDRAW_EXT);
      if (back !== expected) {
        if (back !== null && isExcalidrawScene(back)) {
          // A valid scene that isn't ours: the canvas was saved in the meantime. Keep it.
          report.skipped.push({ name, reason: "exists" });
          continue;
        }
        // Our output came back damaged: take it back (only while it is still that
        // damaged content), so the next run retries the canvas.
        if (back !== null) await store.remove(name + EXCALIDRAW_EXT, back).catch(() => false);
        throw new Error("the written .excalidraw file did not read back");
      }
      report.converted.push({
        name,
        shapes: result.stats.shapes,
        elements: result.stats.elements,
        warnings: result.warnings,
      });
    } catch (err) {
      if (err instanceof CanvasFileExistsError) {
        report.skipped.push({ name, reason: "exists" });
        continue;
      }
      report.failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/** Warning counts per canvas, e.g. `plan: approximated-geo ×2, elbow-arrow ×1`. */
export function warningLines(report: CanvasMigrationReport): string[] {
  const lines: string[] = [];
  for (const c of report.converted) {
    if (!c.warnings.length) continue;
    const counts = new Map<ConversionWarningCode, number>();
    for (const w of c.warnings) counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
    lines.push(`${c.name}: ${[...counts].map(([code, n]) => `${code} ×${n}`).join(", ")}`);
  }
  for (const f of report.failed) lines.push(`${f.name}: ${f.error}`);
  return lines;
}
