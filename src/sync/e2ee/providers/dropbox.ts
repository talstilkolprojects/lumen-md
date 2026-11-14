/**
 * Dropbox as a `SyncProvider` (plan 3.5). The vault is one folder in the
 * app's folder (`/Apps/Lumen/vault` by default); every object is a file in
 * it under its opaque name.
 *
 * Conditional writes use Dropbox's revisions: `files/upload` with
 * `mode: { ".tag": "update", update: <rev> }` and `strict_conflict: true`
 * replaces exactly the revision that was read, `mode: "add"` with
 * `autorename: false` creates only when nothing is there; Dropbox answers a
 * 409 `path/conflict` to a lost race. The rev of an object comes back in the
 * `Dropbox-API-Result` header of a download.
 *
 * OAuth and tokens: src/sync/cloud/dropbox.ts (PKCE; app key from
 * `VITE_DROPBOX_APP_KEY`, plan 15.5). Without a real app key this provider
 * is exercised only against the mock server in the tests.
 */

import { dropboxFetch } from "../../cloud/dropbox";
import { PreconditionFailedError, ProviderUnavailableError, type PutCondition, type StoredObject, type SyncProvider } from "../provider";
import { checkObjectName, defaultFetch, failed, type FetchLike } from "./http";

export interface DropboxSyncConfig {
  /** Folder of the vault inside Dropbox, e.g. `/Apps/Lumen/vault`. */
  folder?: string;
}

export const DROPBOX_DEFAULT_FOLDER = "/Apps/Lumen/vault";

/** Dropbox-API-Arg must be ASCII: non-ASCII characters are escaped. */
function apiArg(arg: unknown): string {
  return JSON.stringify(arg).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function isConflict(body: string): boolean {
  return /"conflict"|path\/conflict/.test(body);
}

export function dropboxSyncProvider(cfg: DropboxSyncConfig = {}, deps: { fetch?: FetchLike } = {}): SyncProvider {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const folder = (cfg.folder ?? DROPBOX_DEFAULT_FOLDER).replace(/\/+$/, "");
  const path = (name: string) => {
    checkObjectName(name);
    return `${folder}/${name}`;
  };
  const via = (input: string, init?: RequestInit) => fetchImpl(input, init);

  async function call(apiPath: string, init: Parameters<typeof dropboxFetch>[1]): Promise<Response> {
    try {
      const res = await dropboxFetch(apiPath, init, via);
      if (res.status >= 500 || res.status === 429) throw new ProviderUnavailableError(`dropbox: ${res.status}`);
      return res;
    } catch (e) {
      if (e instanceof ProviderUnavailableError) throw e;
      if (e instanceof TypeError) throw new ProviderUnavailableError(`dropbox: ${e.message}`);
      throw e;
    }
  }

  return {
    id: "dropbox",

    async get(name): Promise<StoredObject | null> {
      const res = await call("/2/files/download", { contentEndpoint: true, headers: { "Dropbox-API-Arg": apiArg({ path: path(name) }) } });
      if (res.status === 409) {
        const body = await res.text();
        if (/not_found/.test(body)) return null;
        throw new Error(`dropbox: ${body.slice(0, 200)}`);
      }
      if (!res.ok) throw await failed(res, "dropbox", name);
      const meta = res.headers.get("Dropbox-API-Result");
      const rev = meta ? (JSON.parse(meta) as { rev?: string }).rev : undefined;
      if (!rev) throw new Error("dropbox: download answer without a rev");
      return { data: new Uint8Array(await res.arrayBuffer()), etag: rev };
    },

    async put(name, data, cond?: PutCondition) {
      const mode = cond && "ifMatch" in cond ? { ".tag": "update", update: cond.ifMatch } : cond && "ifNoneMatch" in cond ? "add" : "overwrite";
      const res = await call("/2/files/upload", {
        contentEndpoint: true,
        headers: {
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": apiArg({ path: path(name), mode, autorename: false, mute: true, strict_conflict: true }),
        },
        body: data as BodyInit,
      });
      if (res.status === 409) {
        const body = await res.text();
        if (isConflict(body)) throw new PreconditionFailedError(name);
        throw new Error(`dropbox: ${body.slice(0, 200)}`);
      }
      if (!res.ok) throw await failed(res, "dropbox", name);
      const json = (await res.json()) as { rev?: string };
      if (!json.rev) throw new Error("dropbox: upload answer without a rev");
      return { etag: json.rev };
    },

    async delete(name) {
      const res = await call("/2/files/delete_v2", { body: JSON.stringify({ path: path(name) }) });
      if (res.ok) return;
      if (res.status === 409 && /not_found/.test(await res.text())) return;
      throw await failed(res, "dropbox", name);
    },

    async list() {
      type Entry = { ".tag": "file" | "folder" | "deleted"; name: string };
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await call(cursor ? "/2/files/list_folder/continue" : "/2/files/list_folder", {
          body: JSON.stringify(cursor ? { cursor } : { path: folder, recursive: false }),
        });
        if (res.status === 409 && /not_found/.test(await res.clone().text())) return [];
        if (!res.ok) throw await failed(res, "dropbox", "");
        const page = (await res.json()) as { entries: Entry[]; cursor?: string; has_more: boolean };
        for (const e of page.entries) if (e[".tag"] === "file") out.push(e.name);
        cursor = page.has_more ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}
