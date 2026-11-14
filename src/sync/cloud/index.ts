/**
 * Cloud storage — the OAuth side of Dropbox and Google Drive, and the
 * plain-text adapters the migration to encrypted sync reads from (plan 3.5).
 * Encrypted sync itself: src/sync/e2ee (the core) and
 * src/sync/e2ee/providers (Dropbox, Google Drive, WebDAV, S3 as SyncProvider).
 */

export type { CloudFile, LegacyCloudStore } from "./types";
export { dropboxLegacy, finishDropboxOAuth, dropboxConfigured, dropboxFetch } from "./dropbox";
export { gdriveLegacy, finishGDriveOAuth, gdriveConfigured, gdriveFetch } from "./gdrive";
