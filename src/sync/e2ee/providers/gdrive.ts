/**
 * Google Drive as a `SyncProvider` (plan 3.5). The vault is one folder
 * (`appProperties.lumenVault=true`, named "Lumen Vault") that Lumen creates
 * in the user's Drive under the `drive.file` scope; every object is a file
 * in it under its opaque name.
 *
 * Conditional writes use Drive's ETags: a media upload `PATCH` with
 * `If-Match: <etag>` replaces exactly the version that was read (412 on a
 * lost race). Drive has no "create only if absent" on names, so
 * `ifNoneMatch: "*"` is look → create → look again: when two devices
 * created the same name, the older file is the object on every device and
 * the newer one's writer deletes it and gets a `PreconditionFailedError`.
 * This relies on Drive's listing showing a file once its create has
 * returned. If the listing lagged, both creates could appear to win. The
 * object would then have two copies, and every device would read the
 * older one. The ETag of an object is the
 * `ETag` header of its metadata; `get` reads metadata and media (2 requests).
 *
 * OAuth and tokens: src/sync/cloud/gdrive.ts (PKCE; client id from
 * `VITE_GDRIVE_CLIENT_ID`, plan 15.5). Without a real client id this
 * provider is exercised only against the mock server in the tests; whether
 * real Drive honours `If-Match` on media uploads is checked then.
 */

import { gdriveFetch } from "../../cloud/gdrive";
import { PreconditionFailedError, ProviderUnavailableError, type PutCondition, type StoredObject, type SyncProvider } from "../provider";
import { checkObjectName, defaultFetch, failed, ProviderUnsupportedError, type FetchLike } from "./http";

export interface GDriveSyncConfig {
  /** Name of the vault folder in Drive. */
  folderName?: string;
}

export const GDRIVE_DEFAULT_FOLDER = "Lumen Vault";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function gdriveSyncProvider(cfg: GDriveSyncConfig = {}, deps: { fetch?: FetchLike } = {}): SyncProvider {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const folderName = cfg.folderName ?? GDRIVE_DEFAULT_FOLDER;
  const via = (input: string, init?: RequestInit) => fetchImpl(input, init);
  let folderId: string | null = null;

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const res = await gdriveFetch(path, init, via);
      if (res.status >= 500 || res.status === 429) throw new ProviderUnavailableError(`gdrive: ${res.status}`);
      return res;
    } catch (e) {
      if (e instanceof ProviderUnavailableError) throw e;
      if (e instanceof TypeError) throw new ProviderUnavailableError(`gdrive: ${e.message}`);
      throw e;
    }
  }

  async function json<T>(path: string, init: RequestInit = {}, name = ""): Promise<T> {
    const res = await call(path, init);
    if (!res.ok) throw await failed(res, "gdrive", name);
    return (await res.json()) as T;
  }

  async function folder(): Promise<string> {
    if (folderId) return folderId;
    const found = await json<{ files: { id: string }[] }>(
      `/drive/v3/files?q=${encodeURIComponent(`mimeType='${FOLDER_MIME}' and appProperties has { key='lumenVault' and value='true' } and name='${q(folderName)}' and trashed=false`)}&fields=files(id)`,
    );
    if (found.files[0]) return (folderId = found.files[0].id);
    const created = await json<{ id: string }>("/drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME, appProperties: { lumenVault: "true" } }),
    });
    return (folderId = created.id);
  }

  async function lookup(name: string): Promise<string | null> {
    checkObjectName(name);
    const parent = await folder();
    return (await twins(parent, name))[0]?.id ?? null;
  }

  /**
   * Every file called `name`, oldest first. Drive allows two files with the
   * same name in a folder; when two devices create the same object at once
   * the oldest one is the object, on every device.
   */
  async function twins(parent: string, name: string): Promise<Array<{ id: string; createdTime?: string }>> {
    const found = await json<{ files: Array<{ id: string; createdTime?: string }> }>(
      `/drive/v3/files?q=${encodeURIComponent(`'${parent}' in parents and name='${q(name)}' and trashed=false`)}&fields=files(id,createdTime)`,
      {},
      name,
    );
    return [...found.files].sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || a.id.localeCompare(b.id));
  }

  /** The metadata ETag (the HTTP header) — what `If-Match` compares against. */
  async function etagOf(id: string, name: string): Promise<string> {
    const res = await call(`/drive/v3/files/${id}?fields=id,headRevisionId`);
    if (!res.ok) throw await failed(res, "gdrive", name);
    const etag = res.headers.get("ETag");
    if (!etag) throw new ProviderUnsupportedError("gdrive", "Drive returned no ETag for the file's metadata");
    return etag;
  }

  return {
    id: "gdrive",

    async get(name): Promise<StoredObject | null> {
      const id = await lookup(name);
      if (!id) return null;
      const etag = await etagOf(id, name);
      const media = await call(`/drive/v3/files/${id}?alt=media`);
      if (media.status === 404) return null;
      if (!media.ok) throw await failed(media, "gdrive", name);
      return { data: new Uint8Array(await media.arrayBuffer()), etag };
    },

    async put(name, data, cond?: PutCondition) {
      const id = await lookup(name);
      if (cond && "ifNoneMatch" in cond && id) throw new PreconditionFailedError(name);
      if (cond && "ifMatch" in cond && !id) throw new PreconditionFailedError(name);
      if (id) {
        const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
        if (cond && "ifMatch" in cond) headers["If-Match"] = cond.ifMatch;
        const res = await call(`/upload/drive/v3/files/${id}?uploadType=media&fields=id`, { method: "PATCH", headers, body: data as BodyInit });
        if (res.status === 412) throw new PreconditionFailedError(name);
        if (!res.ok) throw await failed(res, "gdrive", name);
        return { etag: res.headers.get("ETag") ?? (await etagOf(id, name)) };
      }
      const parent = await folder();
      const boundary = "lumen-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const meta = JSON.stringify({ name, parents: [parent], mimeType: "application/octet-stream" });
      const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.length + data.length + tail.length);
      body.set(head, 0);
      body.set(data, head.length);
      body.set(tail, head.length + data.length);
      const res = await call(`/upload/drive/v3/files?uploadType=multipart&fields=id`, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!res.ok) throw await failed(res, "gdrive", name);
      const created = (await res.json()) as { id: string };
      if (cond && "ifNoneMatch" in cond) {
        // Drive has no "create only if absent": look again. If another device
        // created the same object first, ours is removed and this write lost.
        const first = (await twins(parent, name))[0];
        if (first && first.id !== created.id) {
          await call(`/drive/v3/files/${created.id}`, { method: "DELETE" });
          throw new PreconditionFailedError(name);
        }
      }
      return { etag: res.headers.get("ETag") ?? (await etagOf(created.id, name)) };
    },

    async delete(name) {
      const id = await lookup(name);
      if (!id) return;
      const res = await call(`/drive/v3/files/${id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) return;
      throw await failed(res, "gdrive", name);
    },

    async list() {
      const parent = await folder();
      const out: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await json<{ nextPageToken?: string; files: { name: string; mimeType?: string }[] }>(
          `/drive/v3/files?q=${encodeURIComponent(`'${parent}' in parents and trashed=false`)}&fields=nextPageToken,files(name,mimeType)&pageSize=1000` +
            (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
        );
        for (const f of page.files) if (f.mimeType !== FOLDER_MIME) out.push(f.name);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },
  };
}
