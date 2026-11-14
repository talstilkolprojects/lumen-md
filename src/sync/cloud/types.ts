/**
 * The storage services' plain-text side (Dropbox, Google Drive): what the
 * migration to encrypted sync (plan 3.5.6) needs from the folder an earlier
 * Lumen synced notes into — list, read, and move aside into a backup folder.
 * Nothing here writes note content: sync itself is the encrypted
 * `SyncProvider` (src/sync/e2ee/providers).
 */

export interface CloudFile {
  /** Path relative to the bound folder. */
  path: string;
  size: number;
  /** mtime ms since epoch. */
  modified: number;
  /** Server-side hash, when the API exposes one. */
  hash?: string;
}

export interface LegacyCloudStore {
  /** Stable name shown in the UI. */
  name: string;
  /** True once a session is live. */
  isConnected(): boolean;
  /** Run the OAuth flow and persist credentials in the secret store. */
  connect(): Promise<void>;
  /** Drop credentials. Does not revoke server-side. */
  disconnect(): Promise<void>;
  /** Enumerate every file under the bound folder, recursively. */
  listFiles(): Promise<CloudFile[]>;
  /** Read a file's bytes. */
  readFile(path: string): Promise<Uint8Array>;
  /** Move / rename a file (creating the target folder); the backup step of the migration. */
  moveFile(from: string, to: string): Promise<void>;
}
