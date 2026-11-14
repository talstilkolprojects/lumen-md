/**
 * SQLite storage for the Hocuspocus collab server (plan 3.6.1), on Node's
 * built-in `node:sqlite` (no native addon to compile). One row per room:
 * the full Yjs state as a single update. In end-to-end encrypted rooms that
 * state is the ciphertext transport document, so the server never stores
 * readable text.
 *
 * Backups: `backup()` writes a consistent copy with `VACUUM INTO` into
 * `<dir>/backups/collab-<timestamp>.sqlite` and keeps the newest `keep`.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DB_FILE = "collab.sqlite";

export function openStore(dir, { keepBackups = 24 } = {}) {
  mkdirSync(join(dir, "backups"), { recursive: true });
  const db = new DatabaseSync(join(dir, DB_FILE));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS documents (
      name TEXT PRIMARY KEY,
      state BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const select = db.prepare("SELECT state FROM documents WHERE name = ?");
  const upsert = db.prepare(
    "INSERT INTO documents (name, state, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
  );
  let closed = false;

  return {
    /** The stored state of `name`, or null for a new room. */
    load(name) {
      const row = select.get(name);
      return row ? new Uint8Array(row.state) : null;
    },
    save(name, state, nowMs = Date.now()) {
      upsert.run(name, state, nowMs);
    },
    getMeta(key) {
      return getMeta.get(key)?.value ?? null;
    },
    setMeta(key, value) {
      setMeta.run(key, value);
    },
    /** Write a consistent copy next to the database; returns its path. */
    backup(nowMs = Date.now()) {
      const dirBackups = join(dir, "backups");
      const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
      let file = join(dirBackups, `collab-${stamp}.sqlite`);
      for (let n = 2; readdirSync(dirBackups).includes(file.split(/[\\/]/).pop()); n++) {
        file = join(dirBackups, `collab-${stamp}-${n}.sqlite`);
      }
      // VACUUM INTO takes a string literal; the path is ours (no user input), quotes escaped anyway.
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const all = readdirSync(dirBackups).filter((f) => /^collab-.*\.sqlite$/.test(f)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - keepBackups))) rmSync(join(dirBackups, old), { force: true });
      return file;
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
