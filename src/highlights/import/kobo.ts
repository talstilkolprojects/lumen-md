/**
 * Kobo's KoboReader.sqlite (plan W2.15, from the reader's .kobo folder):
 * the Bookmark table holds highlights and notes, the content table the
 * books (Title, Attribution) and their chapters. Read on this device with
 * sql.js (already the app's SQLite, for SQL blocks). Dog-ears (bookmarks
 * without text) and hidden entries are skipped.
 */

import { bump, groupBooks, highlightId, type ImportReport } from "./model";

/** One row of KOBO_QUERY. */
export interface KoboRow {
  BookmarkID: string;
  Text: string | null;
  Annotation: string | null;
  DateCreated: string | null;
  ChapterProgress: number | null;
  Type: string | null;
  Hidden: string | null;
  BookTitle: string | null;
  Author: string | null;
  Chapter: string | null;
  ChapterIndex: number | null;
}

export const KOBO_QUERY = `
SELECT b.BookmarkID, b.Text, b.Annotation, b.DateCreated, b.ChapterProgress, b.Type, b.Hidden,
       book.Title AS BookTitle, book.Attribution AS Author,
       ch.Title AS Chapter, ch.VolumeIndex AS ChapterIndex
FROM Bookmark b
JOIN content book ON book.ContentID = b.VolumeID
LEFT JOIN content ch ON ch.ContentID = b.ContentID
ORDER BY book.Title, ch.VolumeIndex, b.ChapterProgress, b.DateCreated`;

export function koboRowsToReport(rows: readonly KoboRow[]): ImportReport {
  const skipped: Record<string, number> = {};
  const out: Parameters<typeof groupBooks>[1] = [];
  for (const r of rows) {
    const text = (r.Text ?? "").replace(/\s+/g, " ").trim();
    const note = (r.Annotation ?? "").trim();
    if (String(r.Hidden).toLowerCase() === "true") {
      bump(skipped, "hidden");
      continue;
    }
    if (!text && !note) {
      bump(skipped, r.Type === "dogear" ? "bookmark" : "empty");
      continue;
    }
    const title = (r.BookTitle ?? "").trim();
    if (!title) {
      bump(skipped, "no-title");
      continue;
    }
    const author = (r.Author ?? "").trim();
    const pct = typeof r.ChapterProgress === "number" ? Math.round(r.ChapterProgress * 100) : null;
    const chapter = (r.Chapter ?? "").trim();
    const location = [chapter || null, pct !== null ? `${pct}%` : null].filter(Boolean).join(" · ") || null;
    const at = r.DateCreated ? Date.parse(r.DateCreated.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(r.DateCreated) ? r.DateCreated : `${r.DateCreated}Z`) : NaN;
    out.push({
      title,
      author,
      h: { id: highlightId(title, author, text, note), text, note, location, sort: (r.ChapterIndex ?? 0) * 1000 + (pct ?? 0) * 10, created: Number.isNaN(at) ? null : new Date(at).toISOString(), color: null, tags: [], link: null },
    });
  }
  return { books: groupBooks("kobo", out), skipped };
}

interface SqlDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
}

type SqlStatic = { Database: new (data: Uint8Array) => SqlDb };

/** sql.js with its wasm from the app's own build (as SQL blocks load it). */
async function appSql(): Promise<SqlStatic> {
  const [mod, wasm] = await Promise.all([import("sql.js"), import("sql.js/dist/sql-wasm.wasm?url")]);
  const init = mod.default as unknown as (cfg: { locateFile: (f: string) => string }) => Promise<SqlStatic>;
  return init({ locateFile: () => wasm.default });
}

/** Open the database file with sql.js (loaded on use) and read it. `loadSql` is for tests (sql.js in Node). */
export async function parseKoboDatabase(bytes: Uint8Array, loadSql: () => Promise<SqlStatic> = appSql): Promise<ImportReport> {
  const SQL = await loadSql();
  const db = new SQL.Database(bytes);
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Bookmark', 'content')")[0]?.values.flat() ?? [];
    if (tables.length < 2) throw new Error("not a Kobo database (no Bookmark / content tables)");
    const res = db.exec(KOBO_QUERY)[0];
    const rows = (res?.values ?? []).map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])) as unknown as KoboRow);
    return koboRowsToReport(rows);
  } finally {
    db.close();
  }
}
