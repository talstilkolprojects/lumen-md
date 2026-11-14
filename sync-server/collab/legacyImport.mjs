/**
 * One-time import of rooms stored by the legacy y-websocket server
 * (persistent-server.js, LevelDB) into the SQLite store (plan 3.6, review
 * #237). An upgraded deployment keeps its rooms: same room names, same Yjs
 * state (ciphertext transport docs in encrypted rooms).
 *
 * Rooms already in SQLite are never overwritten. The import is recorded in
 * the store's meta table, so it runs once per LevelDB directory.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as Y from "yjs";

const require = createRequire(import.meta.url);

/**
 * `source` is y-leveldb's LeveldbPersistence (or a stand-in in tests):
 * getAllDocNames() and getYDoc(name). Returns {imported, skipped}.
 */
export async function importLegacyRooms(store, source, { marker, log = () => {} } = {}) {
  if (marker && store.getMeta(marker)) return { imported: 0, skipped: 0, already: true };
  let imported = 0;
  let skipped = 0;
  for (const name of await source.getAllDocNames()) {
    if (store.load(name)) {
      skipped++;
      continue;
    }
    const doc = await source.getYDoc(name);
    try {
      store.save(name, Y.encodeStateAsUpdate(doc));
      imported++;
    } finally {
      doc.destroy();
    }
  }
  if (marker) store.setMeta(marker, new Date().toISOString());
  log(`imported ${imported} legacy room(s) from LevelDB, ${skipped} already present`);
  return { imported, skipped, already: false };
}

/** Import from a LevelDB directory, when one exists. Needs y-leveldb (an optional dependency). */
export async function importLegacyDir(store, dir, { log = () => {} } = {}) {
  if (!dir || !existsSync(dir)) return null;
  const marker = `leveldb-import:${dir}`;
  if (store.getMeta(marker)) return { imported: 0, skipped: 0, already: true };
  let LeveldbPersistence;
  try {
    ({ LeveldbPersistence } = require("y-leveldb"));
  } catch {
    throw new Error(`Legacy LevelDB rooms found in ${dir}, but y-leveldb is not installed: run npm install in sync-server (it is an optional dependency) and start again.`);
  }
  const source = new LeveldbPersistence(dir);
  try {
    return await importLegacyRooms(store, source, { marker, log });
  } finally {
    await source.destroy();
  }
}
