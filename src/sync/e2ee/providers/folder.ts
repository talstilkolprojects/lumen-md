/**
 * A folder as a `SyncProvider` (plan W4.19): the folder of a desktop sync
 * app — iCloud Drive, Dropbox, Google Drive for desktop, OneDrive — picked
 * with the same folder access the vault folder uses (storage/vault/location).
 * Lumen writes only encrypted objects into a `Lumen sync` subfolder; the
 * desktop app carries them to the other devices. No OAuth, no account with
 * us, no server.
 *
 * The folder is not a server, so the conditional writes the engine relies on
 * are checked here: the ETag is the SHA-256 of the object's bytes, and a put
 * reads the current object first. Two devices can still both write between
 * their desktop apps' uploads (the apps then keep both copies, "… (conflicted
 * copy)"); the engine's manifest merge recovers from that on the next round,
 * as it does for a lost race on any provider. Conflicted copies the apps make
 * are ignored by `list()` (their names are not object names).
 */

import type { VaultBackend } from "../../../storage/vault/types";
import { sha256Hex } from "../bytes";
import { PreconditionFailedError, type PutCondition, type StoredObject, type SyncProvider } from "../provider";
import { checkObjectName } from "./http";

/** The subfolder that holds the encrypted objects. */
export const FOLDER_SYNC_DIR = "Lumen sync";

/** Object names the engine writes: opaque, URL-safe, no dots in front. */
const OBJECT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export interface FolderProvider extends SyncProvider {
  /** Can the folder be written? Writes and removes a probe object. */
  probe(): Promise<void>;
}

/** `backend` is the picked folder (a folder vault backend on its handle). */
export function folderProvider(backend: VaultBackend | (() => Promise<VaultBackend>), dir = FOLDER_SYNC_DIR): FolderProvider {
  let resolved: VaultBackend | null = typeof backend === "function" ? null : backend;
  const fs = async (): Promise<VaultBackend> => (resolved ??= await (backend as () => Promise<VaultBackend>)());
  const path = (name: string) => {
    checkObjectName(name);
    return `${dir}/${name}`;
  };

  async function current(name: string): Promise<StoredObject | null> {
    const b = await fs();
    const p = path(name);
    if (!(await b.stat(p))) return null;
    const data = new Uint8Array(await (await b.read(p)).arrayBuffer());
    return { data, etag: await sha256Hex(data) };
  }

  return {
    id: "folder",

    async probe() {
      const b = await fs();
      await b.mkdir(dir);
      const p = `${dir}/.lumen-probe`;
      await b.write(p, new Uint8Array([1]));
      await b.remove(p);
    },

    get: current,

    async put(name, data, cond?: PutCondition) {
      const b = await fs();
      if (cond) {
        const now = await current(name);
        if ("ifNoneMatch" in cond && now) throw new PreconditionFailedError(name);
        if ("ifMatch" in cond && (!now || now.etag !== cond.ifMatch)) throw new PreconditionFailedError(name);
      }
      await b.write(path(name), data);
      return { etag: await sha256Hex(data) };
    },

    async delete(name) {
      const b = await fs();
      const p = path(name);
      if (await b.stat(p)) await b.remove(p);
    },

    async list() {
      const b = await fs();
      if (!(await b.stat(dir))) return [];
      const entries = await b.list(dir);
      return entries.filter((e) => e.kind === "file" && OBJECT_NAME.test(e.name) && !e.name.includes(" ")).map((e) => e.name);
    },
  };
}
