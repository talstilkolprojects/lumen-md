/**
 * Readwise's CSV export (plan W2.15): Highlight, Book Title, Book Author,
 * Amazon Book ID, Note, Color, Tags, Location Type, Location, Highlighted
 * at, Document tags. Highlights that came to Readwise from a Kindle get the
 * same ids as when the Kindle file is imported, so the two never duplicate.
 */

import { csvRecords } from "./csv";
import { bump, groupBooks, highlightId, type ImportReport } from "./model";

const LOC_LABEL: Record<string, string> = { page: "p.", location: "loc.", order: "#", time: "" };

export function parseReadwiseCsv(text: string): ImportReport {
  const skipped: Record<string, number> = {};
  const recs = csvRecords(text);
  if (recs.length && !("Highlight" in recs[0] && "Book Title" in recs[0])) throw new Error("not a Readwise export (no Highlight / Book Title columns)");
  const rows: Parameters<typeof groupBooks>[1] = [];
  recs.forEach((r, i) => {
    const text = (r["Highlight"] ?? "").trim();
    const note = (r["Note"] ?? "").trim();
    const title = (r["Book Title"] ?? "").trim();
    if (!text && !note) return bump(skipped, "empty");
    if (!title) return bump(skipped, "no-title");
    const author = (r["Book Author"] ?? "").trim();
    const type = (r["Location Type"] ?? "").trim().toLowerCase();
    const loc = (r["Location"] ?? "").trim();
    const location = loc ? (type === "time" ? loc : `${LOC_LABEL[type] ?? type} ${loc}`.trim()) : null;
    const at = Date.parse((r["Highlighted at"] ?? "").trim());
    const tags = (r["Tags"] ?? "")
      .split(/[,;]/)
      .map((t) => t.trim().replace(/^#/, "").replace(/\s+/g, "-"))
      .filter(Boolean);
    rows.push({
      title,
      author,
      h: { id: highlightId(title, author, text, note), text, note, location, sort: Number(loc) || i, created: Number.isNaN(at) ? null : new Date(at).toISOString(), color: (r["Color"] ?? "").trim() || null, tags, link: null },
    });
  });
  return { books: groupBooks("readwise", rows), skipped };
}
