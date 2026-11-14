/**
 * The palette command "Canvas: convert tldraw canvases to Excalidraw"
 * (plan 4.19). Lazy-loaded from `useCommands.ts`, and only offered when
 * `EXCALIDRAW_CANVAS_ENABLED` (src/canvas/engine.ts) is on.
 */

import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { uiAlert } from "../ui/PromptDialog";
import { opfsCanvasStore, type CanvasStore } from "./excalidrawFile";
import { migrateTldrawCanvases, warningLines, type CanvasMigrationReport } from "./migrateTldrawCanvases";

/** Run the migration and report it. `store` is injectable for tests. */
export async function runCanvasMigration(
  store: CanvasStore | null = opfsCanvasStore(),
): Promise<CanvasMigrationReport | null> {
  if (!store) {
    showAiToast(t("search.unavailable"), "error");
    return null;
  }
  const report = await migrateTldrawCanvases(store);
  const total = report.converted.length + report.skipped.length + report.failed.length;
  if (total === 0) {
    showAiToast(t("canvas.migrate.none"), "info");
    return report;
  }
  const warnings = report.converted.reduce((n, c) => n + c.warnings.length, 0);
  const summary = t("canvas.migrate.done", {
    converted: String(report.converted.length),
    skipped: String(report.skipped.length),
    failed: String(report.failed.length),
    warnings: String(warnings),
  });
  showAiToast(summary, report.failed.length ? "error" : "success");
  const lines = warningLines(report);
  if (lines.length) await uiAlert({ title: t("cmd.canvas.migrate"), message: [summary, "", ...lines].join("\n") });
  return report;
}
