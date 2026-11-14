/**
 * "Import highlights…" (plan W2.15): pick the app, pick its file (or ask
 * Zotero on this computer), and every book gets its note under
 * Highlights/ — new highlights added, nothing duplicated. Everything is read
 * on this device; the only request is the desktop app's to Zotero's local
 * server on 127.0.0.1.
 */

import "./strings";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import { log } from "../../lib/logger";
import type { ImportReport, ImportSource } from "./model";
import { bookNotePath, mergeBookNote } from "./notes";

const ACCEPT: Record<Exclude<ImportSource, "zotero" | "scan">, string> = {
  kindle: ".txt,text/plain",
  kobo: ".sqlite,.db,application/x-sqlite3,application/vnd.sqlite3",
  readwise: ".csv,text/csv",
};

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Read the source into books (no vault writes). */
export async function readSource(source: ImportSource, file: File | null): Promise<ImportReport> {
  if (source === "zotero") {
    const { importZotero, desktopZoteroGet } = await import("./zotero");
    return importZotero(await desktopZoteroGet());
  }
  if (!file) throw new Error("no file");
  if (source === "kindle") return (await import("./kindle")).parseKindleClippings(await file.text());
  if (source === "readwise") return (await import("./readwise")).parseReadwiseCsv(await file.text());
  return (await import("./kobo")).parseKoboDatabase(new Uint8Array(await file.arrayBuffer()));
}

export interface WriteTotals {
  books: number;
  added: number;
  updated: number;
  unchanged: number;
  paths: string[];
}

/** Write each book's note (through the highlights writer, so an open copy of the note is updated too). */
export async function writeBooks(report: ImportReport, write: (path: string, update: (existing: string | null) => string) => Promise<void>): Promise<WriteTotals> {
  const totals: WriteTotals = { books: 0, added: 0, updated: 0, unchanged: 0, paths: [] };
  for (const book of report.books) {
    if (!book.highlights.length) continue;
    const path = bookNotePath(book);
    await write(path, (existing) => {
      const r = mergeBookNote(existing, book);
      totals.added += r.added;
      totals.updated += r.updated;
      totals.unchanged += r.unchanged;
      return r.content;
    });
    totals.books++;
    totals.paths.push(path);
  }
  return totals;
}

export async function importHighlights(): Promise<void> {
  const { uiSelect } = await import("../../ui/PromptDialog");
  const source = (await uiSelect({
    message: t("hlimport.pick"),
    choices: [
      { value: "kindle", label: t("hlimport.kindle") },
      { value: "kobo", label: t("hlimport.kobo") },
      { value: "readwise", label: t("hlimport.readwise") },
      { value: "zotero", label: t("hlimport.zotero") },
    ],
  })) as Exclude<ImportSource, "scan"> | null;
  if (!source) return;
  const file = source === "zotero" ? null : await pickFile(ACCEPT[source]);
  if (source !== "zotero" && !file) return;
  try {
    const report = await readSource(source, file);
    const { writeSidecar } = await import("../sidecar");
    const totals = await writeBooks(report, writeSidecar);
    const skipped = Object.values(report.skipped).reduce((a, b) => a + b, 0);
    if (!totals.books) showAiToast(t("hlimport.none"), "info");
    else showAiToast(t("hlimport.done", { added: totals.added, updated: totals.updated, unchanged: totals.unchanged, books: totals.books }), "success");
    if (skipped) {
      log.info("highlight import skipped", report.skipped);
      showAiToast(t("hlimport.skipped", { n: skipped }), "info");
    }
  } catch (e) {
    const err = e as Error & { reason?: string };
    if (err.name === "ZoteroUnavailable") {
      const key = err.reason === "disabled" ? "hlimport.zotero.disabled" : err.reason === "browser" ? "hlimport.zotero.browser" : err.reason === "not-running" ? "hlimport.zotero.notRunning" : "hlimport.failed";
      showAiToast(t(key, { error: err.message }), "error");
      return;
    }
    showAiToast(t("hlimport.failed", { error: err.message }), "error");
  }
}
