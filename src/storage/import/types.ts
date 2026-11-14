/**
 * The import wizard's shared shapes (plan W1.26).
 *
 * Every source converter turns the files of an export (archive path →
 * bytes) into a converted vault: notes (Markdown text), attachments
 * (bytes), and what it left out and why. The wizard then writes that vault
 * into a new folder, counts the links, and keeps what it needs to undo.
 */

export type ImportSourceId = "obsidian" | "notion" | "evernote" | "bear" | "appleNotes" | "keep" | "logseq" | "onenote" | "lumen";

/** Why a file of the export did not become a note or an attachment. */
export type SkipReason =
  | "appFolder" // the tool's own settings (.obsidian, logseq/, …)
  | "trashed" // in the tool's trash
  | "duplicate" // another copy of a file already imported (Keep's .html next to its .json)
  | "unsupported" // a format this source cannot convert (with a hint in `detail`)
  | "empty" // nothing to import (an empty note)
  | "unreadable" // the file is broken (bad JSON, bad XML)
  | "encrypted"; // content the tool encrypted (Evernote en-crypt)

/** A note that came through with something missing. */
export type WarningReason =
  | "missingAttachment" // the note points at an attachment the export does not have
  | "encryptedPart" // part of the note was encrypted and is left out
  | "noDates" // the export carries no creation / modification dates
  | "notionComputed" // a Notion formula or rollup column: its values came across, not the formula (plan W8.2)
  | "notionUnparsed"; // a Notion value that did not fit its column's type; kept as text (plan W8.2)

export interface ImportIssue<R extends string> {
  path: string;
  reason: R;
  detail?: string;
}

export interface ConvertedVault {
  /** Path inside the import folder → Markdown (notes, and .base files). */
  notes: Map<string, string>;
  /** Path inside the import folder → bytes. */
  attachments: Map<string, Uint8Array>;
  skipped: ImportIssue<SkipReason>[];
  warnings: ImportIssue<WarningReason>[];
  /** Attachments the export held (the denominator of "0 lost"). */
  sourceAttachments: number;
}

export function emptyVault(): ConvertedVault {
  return { notes: new Map(), attachments: new Map(), skipped: [], warnings: [], sourceAttachments: 0 };
}

export interface LinkStats {
  /** Internal links and embeds in the imported notes. */
  total: number;
  /** …that point at a note or an attachment of the import. */
  resolved: number;
  /** The rest: note path → link target, at most 200 kept. */
  unresolved: { path: string; target: string }[];
}

export interface ImportReport {
  source: ImportSourceId;
  /** The folder of the vault the import went into. */
  folder: string;
  notes: number;
  attachments: number;
  /** `.base` files made from databases (Notion). */
  bases: number;
  skipped: ImportIssue<SkipReason>[];
  warnings: ImportIssue<WarningReason>[];
  links: LinkStats;
  /** Attachments of the export that are not in the vault after the import. */
  attachmentsLost: number;
  /** When the import finished (ms). */
  at: number;
}
