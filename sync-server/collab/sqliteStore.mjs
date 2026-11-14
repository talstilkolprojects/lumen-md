/**
 * SQLite storage for the Hocuspocus collab server (plan 3.6.1), on Node's
 * built-in `node:sqlite` (no native addon to compile). One row per room:
 * the full Yjs state as a single update. In end-to-end encrypted rooms that
 * state is the ciphertext transport document, so the server never stores
 * readable text.
 *
 * Backups: `backup()` writes a consistent copy with `VACUUM INTO` into
 * `<dir>/backups/collab-<timestamp>.sqlite` and keeps the newest `keep`.
 *
 * Sharing (plan W1.19): `room_owners` holds a SHA-256 of each claimed room's
 * owner secret (the secret itself stays on the owner's devices); `shares`
 * holds the share links — role, expiry, revocation. Nothing in either table
 * is document content.
 *
 * Sealed rooms (plan W2.20): `meta` holds `sealed:<room>` for each room the
 * server holds to ciphertext only (collab/sealed.mjs). Sealing is never undone.
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
    CREATE TABLE IF NOT EXISTS room_owners (
      room TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      claimed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      role TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS shares_room ON shares (room);
  `);
  const ownerGet = db.prepare("SELECT owner_hash FROM room_owners WHERE room = ?");
  const ownerSet = db.prepare("INSERT INTO room_owners (room, owner_hash, claimed_at) VALUES (?, ?, ?) ON CONFLICT(room) DO NOTHING");
  const shareInsert = db.prepare("INSERT INTO shares (id, room, role, label, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)");
  const shareGet = db.prepare("SELECT id, room, role, label, created_at, expires_at, revoked_at FROM shares WHERE id = ?");
  const shareList = db.prepare("SELECT id, room, role, label, created_at, expires_at, revoked_at FROM shares WHERE room = ? ORDER BY created_at DESC");
  const shareRevoke = db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ? AND room = ? AND revoked_at IS NULL");
  const toShare = (row) =>
    row && {
      id: row.id,
      room: row.room,
      role: row.role,
      label: row.label,
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    };
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const select = db.prepare("SELECT state FROM documents WHERE name = ?");
  const upsert = db.prepare(
    "INSERT INTO documents (name, state, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
  );
  let closed = false;
  const sealedCache = new Map();

  return {
    /** The stored state of `name`, or null for a new room. */
    load(name) {
      const row = select.get(name);
      return row ? new Uint8Array(row.state) : null;
    },
    save(name, state, nowMs = Date.now()) {
      upsert.run(name, state, nowMs);
    },
    /** The owner secret's hash for `room`, or null when nobody claimed it. */
    roomOwner(room) {
      return ownerGet.get(room)?.owner_hash ?? null;
    },
    /** Claim `room` for the secret with this hash; false when someone already did (the first claim wins). */
    claimRoom(room, ownerHash, nowMs = Date.now()) {
      return Number(ownerSet.run(room, ownerHash, nowMs).changes) === 1;
    },
    addShare(share) {
      shareInsert.run(share.id, share.room, share.role, share.label ?? "", share.createdAt, share.expiresAt ?? null);
      return toShare(shareGet.get(share.id));
    },
    getShare(id) {
      return toShare(shareGet.get(id)) ?? null;
    },
    listShares(room) {
      return shareList.all(room).map(toShare);
    },
    /** Revoke a share of `room`; false when there is no such live share. */
    revokeShare(room, id, nowMs = Date.now()) {
      return Number(shareRevoke.run(nowMs, id, room).changes) === 1;
    },
    /** Is `room` held to ciphertext only? */
    isSealed(room) {
      if (!sealedCache.has(room)) sealedCache.set(room, getMeta.get(`sealed:${room}`)?.value === "1");
      return sealedCache.get(room);
    },
    sealRoom(room) {
      setMeta.run(`sealed:${room}`, "1");
      sealedCache.set(room, true);
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
