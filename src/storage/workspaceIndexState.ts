/**
 * The workspace index's notes and its state object (plan W6.25: moved out
 * of workspaceIndex.ts unchanged; ./workspaceIndex.ts owns every change of
 * it, and re-exports IndexedFile).
 */
import type { WorkspaceEntry, WorkspaceNode } from "./workspace";
import type { NoteSummary } from "./noteSummary";

/**
 * A note as the main thread knows it. W2.22: a compact summary
 * (./noteSummary.ts), not its text — the text lives once, in the index.
 */
export interface IndexedFile extends NoteSummary {
  /** Full workspace path. */
  path: string;
  /** Basename. */
  name: string;
  modified: number;
  /** UTF-8 bytes of the note's text when it was read (review 14.11 S3): compared with the listed size. */
  size?: number;
}

/** A note just read: its summary, and its text for the index (then dropped). */
export interface ReadNote {
  file: IndexedFile;
  content: string;
}

export const cache = {
  byPath: new Map<string, IndexedFile>(),
  builtAt: 0,
  inflight: null as Promise<void> | null,
  /** Files whose text changed since they were indexed (C3). */
  dirty: new Set<string>(),
  /** Deletes and moves (files or folders) not yet applied to the index, in the order they happened. */
  ops: [] as ({ type: "remove"; path: string } | { type: "move"; from: string; to: string })[],
  /** Files may have appeared / disappeared behind the events: re-list on next use. */
  stale: false,
  /** When the index was last checked against the vault listing. */
  checkedAt: 0,
  /** Bumped whenever `byPath` changes, so views can cache what they derive from it. */
  version: 0,
  /** Bumped on every structural event; a listing is reusable only within one generation. */
  generation: 0,
  /** The file tree's last listing (`workspaceTree`), which the index reuses when nothing moved since. */
  listing: null as { generation: number; tree: WorkspaceNode[] } | null,
  /** Review 12.11 S1: the index holds notes of an encrypted vault, so it is never saved in the clear. */
  filledEncrypted: false,
  /** Review 14.11 T1: the vault (backend id) the index was filled from; another vault's index is never saved or answered. */
  filledVault: null as string | null,
  /** Review 14.11 T2: the last check of a trusted snapshot failed, so the next open waits for the listing. */
  distrust: false,
  /**
   * Review 17 W1: the listing a check timed out on, still running. The
   * rebuild that follows waits for this one instead of starting a second
   * listing, so a slow but healthy vault pays for one listing.
   */
  pendingListing: null as { vault: string; listing: Promise<WorkspaceEntry[]>; since: ListingWatch } | null,
  /** Review 19 Y2: the key the snapshot record of the vault being built is filed under (`recordVault`). */
  recordVault: "default",
  /** W6.36: the check of a trusted snapshot against the vault's listing, while it runs. */
  verify: null as Promise<void> | null,
};

/** Review 19 Y1: what happened in the vault while a listing ran. */
export interface ListingWatch {
  /** Notes saved since the listing started. */
  dirty: Set<string>;
  /** False once a delete, a move or a structural change came: the listing no longer describes the vault. */
  reusable: boolean;
}
