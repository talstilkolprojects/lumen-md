/**
 * `canvases/<name>.excalidraw` — read, validate and write Excalidraw scene
 * files (plan 4.19). The file is open JSON in Excalidraw's own format, so it
 * opens in excalidraw.com or any Excalidraw build as-is.
 *
 * Storage is the vault's `canvases/` folder, where the tldraw canvas kept
 * `<name>.tldr` — read and written through the vault layer like every other
 * file (plan 4.1; no direct file-system handles). Everything goes through the
 * small `CanvasStore` interface so the migration and the tests can run
 * against an in-memory store.
 *
 * `.tldr` files are never written or deleted here: after the migration they
 * stay next to the `.excalidraw` file as the backup.
 */

import { createWorkspaceFile, deleteWorkspaceFile, isOPFSAvailable, listWorkspaceDir, readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import type { ExBinaryFile, ExcalidrawElement, ExcalidrawFile } from "./tldrawToExcalidraw";

export const CANVAS_DIR = "canvases";
export const EXCALIDRAW_EXT = ".excalidraw";
export const TLDRAW_EXT = ".tldr";

/** File access inside `canvases/`. Names are bare file names (`plan.excalidraw`). */
export interface CanvasStore {
  /** Every file name in the directory. */
  list(): Promise<string[]>;
  /** The file's text, or null when it doesn't exist. */
  read(fileName: string): Promise<string | null>;
  /** Create or replace the file. */
  write(fileName: string, text: string): Promise<void>;
  /** Create the file; rejects with `CanvasFileExistsError` when it already exists. */
  create(fileName: string, text: string): Promise<void>;
  /**
   * Delete a `.excalidraw` file, but only while its content is still exactly
   * `onlyIf` (checked under the file's lock). Only used to take back a bad
   * output the migration itself just wrote; returns whether it was removed.
   */
  remove(fileName: string, onlyIf: string): Promise<boolean>;
}

const localLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` holding the lock for one canvas file: the Web Locks API when
 * present (exclusive across tabs), else a per-page queue, so the "exists?"
 * check and the write of a create, or the read and delete of a remove, never
 * interleave with another create or save of the same file.
 */
export function withCanvasLock<T>(fileName: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && "locks" in navigator && typeof navigator.locks?.request === "function") {
    const locks = navigator.locks;
    return new Promise<T>((resolve, reject) => {
      locks
        .request(`lumen-canvas:${CANVAS_DIR}/${fileName}`, async () => {
          try {
            resolve(await fn());
          } catch (err) {
            reject(err);
          }
        })
        .catch(reject);
    });
  }
  const prev = localLocks.get(fileName) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  localLocks.set(fileName, settled);
  void settled.then(() => {
    if (localLocks.get(fileName) === settled) localLocks.delete(fileName);
  });
  return run;
}

export class CanvasFileExistsError extends Error {
  constructor(fileName: string) {
    super(`${fileName} already exists`);
    this.name = "CanvasFileExistsError";
  }
}

export class ExcalidrawFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExcalidrawFileError";
  }
}

/** The vault's `canvases/` folder, or null when the vault isn't available. */
export function opfsCanvasStore(): CanvasStore | null {
  if (!isOPFSAvailable()) return null;
  const at = (fileName: string) => `${CANVAS_DIR}/${fileName}`;
  const isMissing = (err: unknown) => (err as { name?: string } | null)?.name === "NotFoundError";
  return {
    async list() {
      try {
        return (await listWorkspaceDir(CANVAS_DIR)).map((e) => e.name).sort();
      } catch (err) {
        if (isMissing(err)) return []; // no canvases yet
        throw err;
      }
    },
    async read(fileName) {
      try {
        return await readWorkspaceFile(at(fileName));
      } catch {
        return null;
      }
    },
    write(fileName, text) {
      // The vault writes atomically: a failed write never leaves half a file behind.
      return withCanvasLock(fileName, () => writeWorkspaceFile(at(fileName), text));
    },
    create(fileName, text) {
      return withCanvasLock(fileName, async () => {
        // createWorkspaceFile checks and writes under the path's lock: never an overwrite.
        if (!(await createWorkspaceFile(at(fileName), text))) throw new CanvasFileExistsError(fileName);
      });
    },
    remove(fileName, onlyIf) {
      if (!fileName.endsWith(EXCALIDRAW_EXT)) return Promise.reject(new ExcalidrawFileError(`refusing to delete ${fileName}`));
      return withCanvasLock(fileName, async () => {
        let current: string | null = null;
        try {
          current = await readWorkspaceFile(at(fileName));
        } catch {
          return false;
        }
        if (current !== onlyIf) return false; // someone saved it since: keep their version
        await deleteWorkspaceFile(at(fileName));
        return true;
      });
    },
  };
}

/** A canvas name is a single file-name segment: no slashes, not empty, not dot-only. */
export function isValidCanvasName(name: string): boolean {
  return name.trim() !== "" && !/[/\\]/.test(name) && !/^\.+$/.test(name) && !name.includes("\0");
}

function excalidrawFileName(name: string): string {
  if (!isValidCanvasName(name)) throw new ExcalidrawFileError(`invalid canvas name: ${JSON.stringify(name)}`);
  return name + EXCALIDRAW_EXT;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse and validate an `.excalidraw` file. Checks the envelope and that
 * every element has an id, a type and a finite position; Excalidraw's own
 * `restore()` fills in any optional element field when the scene is loaded.
 */
export function parseExcalidrawFile(text: string): ExcalidrawFile {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ExcalidrawFileError("not JSON");
  }
  if (!isObj(data) || data.type !== "excalidraw") throw new ExcalidrawFileError('not an Excalidraw file (type !== "excalidraw")');
  if (typeof data.version !== "number") throw new ExcalidrawFileError("missing version");
  if (!Array.isArray(data.elements)) throw new ExcalidrawFileError("elements is not an array");
  const ids = new Set<string>();
  data.elements.forEach((el, i) => {
    if (!isObj(el)) throw new ExcalidrawFileError(`element ${i} is not an object`);
    if (typeof el.id !== "string" || !el.id) throw new ExcalidrawFileError(`element ${i} has no id`);
    if (typeof el.type !== "string") throw new ExcalidrawFileError(`element ${el.id} has no type`);
    if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) throw new ExcalidrawFileError(`element ${el.id} has no position`);
    if (ids.has(el.id)) throw new ExcalidrawFileError(`duplicate element id ${el.id}`);
    ids.add(el.id);
  });
  const files: Record<string, ExBinaryFile> = {};
  if (data.files !== undefined) {
    if (!isObj(data.files)) throw new ExcalidrawFileError("files is not an object");
    for (const [id, f] of Object.entries(data.files)) {
      if (!isObj(f) || typeof f.dataURL !== "string" || typeof f.mimeType !== "string") {
        throw new ExcalidrawFileError(`file ${id} has no dataURL / mimeType`);
      }
      files[id] = f as unknown as ExBinaryFile;
    }
  }
  const appState = isObj(data.appState) ? data.appState : {};
  return {
    type: "excalidraw",
    version: 2,
    source: typeof data.source === "string" ? data.source : "",
    elements: data.elements as ExcalidrawElement[],
    appState: {
      ...appState,
      viewBackgroundColor: typeof appState.viewBackgroundColor === "string" ? appState.viewBackgroundColor : "#ffffff",
      gridSize: typeof appState.gridSize === "number" ? appState.gridSize : null,
    },
    files,
  };
}

/** Pretty-printed like Excalidraw's own "Save to disk", so diffs in a git-synced vault stay readable. */
export function serializeExcalidrawFile(file: ExcalidrawFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

/** Read `canvases/<name>.excalidraw`; null when it doesn't exist. Throws `ExcalidrawFileError` when it is corrupt. */
export async function readExcalidrawCanvas(store: CanvasStore, name: string): Promise<ExcalidrawFile | null> {
  const text = await store.read(excalidrawFileName(name));
  return text === null ? null : parseExcalidrawFile(text);
}

/** Save `canvases/<name>.excalidraw` (create or replace). The scene is validated before anything is written. */
export async function writeExcalidrawCanvas(store: CanvasStore, name: string, file: ExcalidrawFile): Promise<void> {
  const text = serializeExcalidrawFile(file);
  parseExcalidrawFile(text);
  await store.write(excalidrawFileName(name), text);
}

/** Create `canvases/<name>.excalidraw`; rejects with `CanvasFileExistsError` instead of overwriting. */
export async function createExcalidrawCanvas(store: CanvasStore, name: string, file: ExcalidrawFile): Promise<void> {
  const text = serializeExcalidrawFile(file);
  parseExcalidrawFile(text);
  await store.create(excalidrawFileName(name), text);
}

/** Canvas names that have a `.excalidraw` file. */
export async function listExcalidrawCanvases(store: CanvasStore): Promise<string[]> {
  return (await store.list())
    .filter((f) => f.endsWith(EXCALIDRAW_EXT))
    .map((f) => f.slice(0, -EXCALIDRAW_EXT.length))
    .sort();
}

/** Canvas names that have a `.tldr` file. */
export async function listTldrawCanvases(store: CanvasStore): Promise<string[]> {
  return (await store.list())
    .filter((f) => f.endsWith(TLDRAW_EXT))
    .map((f) => f.slice(0, -TLDRAW_EXT.length))
    .sort();
}
