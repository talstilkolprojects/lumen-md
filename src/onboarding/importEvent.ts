/**
 * The small part of import-first onboarding (plan W11.P6) that App.tsx
 * needs at startup: the event that opens the import wizard on a source.
 * The rest (the sample search) is in ./importFirst.ts, loaded with the wizard.
 */

import type { ImportSourceId } from "../storage/import/types";

/** The six sources "Bring your notes" offers, in this order (R6 §5, the GA importer list). */
export const FIRST_RUN_SOURCES: readonly ImportSourceId[] = ["notion", "evernote", "appleNotes", "keep", "onenote", "obsidian"];

/** The ways the first run's last step can start. "sample" stays the default (plan 14.1). */
export type StartPath = "sample" | "empty" | "import" | "obsidianFolder";

/** The window event that opens the import wizard; `detail` may preset the source and mark the first run. */
export const OPEN_IMPORT_EVENT = "lumen-open-import";
export interface OpenImportDetail {
  source?: ImportSourceId;
  firstRun?: boolean;
}

/** Open the import wizard on `source` (the first run's "Bring your notes"). */
export function openImportWizard(detail: OpenImportDetail): void {
  window.dispatchEvent(new CustomEvent<OpenImportDetail>(OPEN_IMPORT_EVENT, { detail }));
}

/** The detail of an open-import event, checked: only a known source, only a boolean. */
export function readOpenImport(e: Event, known: readonly ImportSourceId[]): OpenImportDetail {
  const d = (e as CustomEvent<unknown>).detail;
  if (!d || typeof d !== "object") return {};
  const { source, firstRun } = d as Record<string, unknown>;
  return { source: typeof source === "string" && (known as readonly string[]).includes(source) ? (source as ImportSourceId) : undefined, firstRun: firstRun === true };
}


/**
 * The source of a `?import=<source>` link (the "Leaving Evernote or
 * Notion?" page links into the wizard this way, plan W11.P7), or null.
 */
export function importFromSearch(search: string): ImportSourceId | null {
  const v = new URLSearchParams(search).get("import");
  return v && (FIRST_RUN_SOURCES as readonly string[]).includes(v) ? (v as ImportSourceId) : null;
}
