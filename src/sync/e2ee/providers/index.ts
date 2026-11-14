/**
 * The storage providers of the encrypted sync (plan 3.5): which one the
 * user chose, its settings, and its credentials — settings in IndexedDB,
 * every secret (WebDAV password, S3 keys, OAuth tokens) in the secret store.
 *
 * `createSyncProvider` builds the `SyncProvider` the engine (../engine.ts)
 * talks to. OAuth providers need a client id from Tal (plan 15.5):
 * `oauthAvailable()` says whether one is configured.
 */

import { getSecret, setSecret } from "../../../lib/secretStore";
import { dropboxConfigured, dropboxLegacy, gdriveConfigured, gdriveLegacy, type LegacyCloudStore } from "../../cloud";
import type { SyncProvider } from "../provider";
import { dropboxSyncProvider, DROPBOX_DEFAULT_FOLDER } from "./dropbox";
import { gdriveSyncProvider, GDRIVE_DEFAULT_FOLDER } from "./gdrive";
import { s3Provider, type S3Provider } from "./s3";
import { webdavProvider, type WebdavProvider } from "./webdav";
import type { FetchLike } from "./http";

export type ProviderKind = "webdav" | "s3" | "dropbox" | "gdrive";

export const PROVIDER_KINDS: ProviderKind[] = ["webdav", "s3", "dropbox", "gdrive"];

/** Settings without secrets — what is persisted in IndexedDB. */
export type ProviderSettings =
  | { kind: "webdav"; url: string; username: string }
  | { kind: "s3"; endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; pathStyle: boolean }
  | { kind: "dropbox"; folder: string }
  | { kind: "gdrive"; folderName: string };

/** The secret of a provider, by kind (OAuth providers keep their tokens through the cloud modules). */
export const SECRET_NAMES: Record<ProviderKind, string | null> = {
  webdav: "lumen.sync.webdav.password",
  s3: "lumen.sync.s3.secretAccessKey",
  dropbox: null,
  gdrive: null,
};

export function defaultSettings(kind: ProviderKind): ProviderSettings {
  switch (kind) {
    case "webdav":
      return { kind, url: "", username: "" };
    case "s3":
      return { kind, endpoint: "", region: "auto", bucket: "", prefix: "lumen/", accessKeyId: "", pathStyle: true };
    case "dropbox":
      return { kind, folder: DROPBOX_DEFAULT_FOLDER };
    case "gdrive":
      return { kind, folderName: GDRIVE_DEFAULT_FOLDER };
  }
}

const SETTINGS_KEY = "lumen-sync-provider";

interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

let kv: KV | null = null;
async function store(): Promise<KV> {
  if (kv) return kv;
  const { get, set, del } = await import("idb-keyval");
  return (kv = { get: (k) => get(k), set: (k, v) => set(k, v), del: (k) => del(k) });
}

/** @internal tests */
export function __setProviderStore(s: KV | null): void {
  kv = s;
}

export async function loadProviderSettings(): Promise<ProviderSettings | null> {
  return (await (await store()).get<ProviderSettings>(SETTINGS_KEY)) ?? null;
}

export async function saveProviderSettings(settings: ProviderSettings | null): Promise<void> {
  const s = await store();
  if (settings) await s.set(SETTINGS_KEY, settings);
  else await s.del(SETTINGS_KEY);
}

/** Keep a provider's secret (null removes it). */
export async function saveProviderSecret(kind: ProviderKind, value: string | null): Promise<void> {
  const name = SECRET_NAMES[kind];
  if (name) await setSecret(name, value);
}

export function hasProviderSecret(kind: ProviderKind): boolean {
  const name = SECRET_NAMES[kind];
  if (name) return !!getSecret(name);
  return kind === "dropbox" ? dropboxLegacy.isConnected() : gdriveLegacy.isConnected();
}

/** Can the OAuth flow run (a client id is configured — plan 15.5)? */
export function oauthAvailable(kind: ProviderKind): boolean {
  if (kind === "dropbox") return dropboxConfigured();
  if (kind === "gdrive") return gdriveConfigured();
  return true;
}

/** The OAuth side of Dropbox / Drive (connect, disconnect, the plain-text folder for the migration). */
export function legacyStore(kind: ProviderKind): LegacyCloudStore | null {
  if (kind === "dropbox") return dropboxLegacy;
  if (kind === "gdrive") return gdriveLegacy;
  return null;
}

/** The hosts a provider talks to, for the privacy ledger. */
export function providerHosts(settings: ProviderSettings): string[] {
  switch (settings.kind) {
    case "webdav":
      return safeHost(settings.url);
    case "s3":
      return safeHost(settings.endpoint).flatMap((h) => (settings.pathStyle ? [h] : [h, `${settings.bucket}.${h}`]));
    case "dropbox":
      return ["api.dropboxapi.com", "content.dropboxapi.com"];
    case "gdrive":
      return ["www.googleapis.com", "oauth2.googleapis.com"];
  }
}

function safeHost(url: string): string[] {
  try {
    return [new URL(url).host.toLowerCase()];
  } catch {
    return [];
  }
}

export type ConnectedProvider = SyncProvider & { probe?(): Promise<void> };

/** The SyncProvider for `settings`, with its secret from the secret store (or `secret`, before it is saved). */
export function createSyncProvider(settings: ProviderSettings, opts: { secret?: string; fetch?: FetchLike } = {}): ConnectedProvider {
  const secret = opts.secret ?? (SECRET_NAMES[settings.kind] ? (getSecret(SECRET_NAMES[settings.kind]!) ?? "") : "");
  const deps = opts.fetch ? { fetch: opts.fetch } : {};
  switch (settings.kind) {
    case "webdav":
      return webdavProvider({ url: settings.url, username: settings.username, password: secret }, deps) as WebdavProvider;
    case "s3":
      return s3Provider(
        { endpoint: settings.endpoint, region: settings.region, bucket: settings.bucket, prefix: settings.prefix, accessKeyId: settings.accessKeyId, secretAccessKey: secret, pathStyle: settings.pathStyle },
        deps,
      ) as S3Provider;
    case "dropbox":
      return dropboxSyncProvider({ folder: settings.folder }, deps);
    case "gdrive":
      return gdriveSyncProvider({ folderName: settings.folderName }, deps);
  }
}
