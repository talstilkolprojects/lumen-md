/**
 * Kindle's "My Clippings.txt" (plan W2.15). Each clipping is
 *
 *     Title (Author)
 *     - Your Highlight on page 12 | Location 180-182 | Added on Thursday, 10 March 2016 07:45:31
 *
 *     the text
 *     ==========
 *
 * in the Kindle's own language (English, German, French, Spanish, Italian,
 * Portuguese, Dutch, Russian, Japanese, Chinese are recognised). Bookmarks
 * are skipped. An edited highlight is appended again with the same start
 * location: the last one wins. A note is attached to the highlight it
 * ends on (Kindle puts the note at the highlight's last location), or kept
 * on its own.
 */

import { bump, groupBooks, highlightId, type ImportReport, type ImportedHighlight } from "./model";

const BOOKMARK = /bookmark|lesezeichen|signet|marcador|segnalibro|bladwijzer|закладк|ブックマーク|书签/i;
const NOTE = /\bnote\b|notiz|\bnota\b|notitie|заметк|メモ|笔记/i;
const HIGHLIGHT = /highlight|markierung|surlignement|subrayado|evidenziazione|destaque|marcação|markering|выделени|ハイライト|标注/i;
const LOCATION = /(?:location|loc\.|position|emplacement|posici\u00F3n|posizione|posi\u00E7\u00E3o|positie|\u043F\u043E\u0437\u0438\u0446\u0438[\u0438\u044F]|\u4F4D\u7F6E(?:No\.)?)\s*(\d+)(?:\s*[-\u2013]\s*(\d+))?/i;
const PAGE = /(?:page|seite|p\u00E1gina|pagina|pag\.|\u0441\u0442\u0440\u0430\u043D\u0438\u0446[\u0430\u0435\u044B]|\u30DA\u30FC\u30B8|\u7B2C)\s*(\d+)/i;

/** "Title (Author)": the last bracketed part is the author (it may itself contain a comma). */
export function splitTitleAuthor(line: string): { title: string; author: string } {
  const s = line.replace(/^﻿/, "").trim();
  if (!s.endsWith(")")) return { title: s, author: "" };
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ")") depth++;
    else if (s[i] === "(") {
      depth--;
      if (depth === 0) {
        const title = s.slice(0, i).trim();
        return title ? { title, author: s.slice(i + 1, -1).trim() } : { title: s, author: "" };
      }
    }
  }
  return { title: s, author: "" };
}

interface Clip {
  title: string;
  author: string;
  kind: "highlight" | "note";
  start: number;
  end: number;
  page: number | null;
  /** The meta line had a location (not only a page). */
  hasLoc: boolean;
  created: string | null;
  text: string;
  order: number;
}

function parseDate(meta: string): string | null {
  const m = /\|\s*[^|]*?(?:added on|hinzugefügt am|ajouté le|añadido el|aggiunto il|adicionado em|toegevoegd op|добавлено:?)\s*(.+)$/i.exec(meta);
  if (!m) return null;
  const t = Date.parse(m[1].replace(/^[^,]*,\s*/, ""));
  const t2 = Number.isNaN(t) ? Date.parse(m[1]) : t;
  return Number.isNaN(t2) ? null : new Date(t2).toISOString();
}

export function parseKindleClippings(text: string): ImportReport {
  const skipped: Record<string, number> = {};
  const clips: Clip[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/^={5,}\s*$/m);
  blocks.forEach((block, order) => {
    const lines = block.replace(/^﻿/, "").split("\n");
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length < 2) {
      if (lines.some((l) => l.trim())) bump(skipped, "unreadable");
      return;
    }
    const { title, author } = splitTitleAuthor(lines[0]);
    const meta = lines[1].replace(/^\s*-\s*/, "");
    const body = lines.slice(2).join("\n").trim();
    if (BOOKMARK.test(meta)) return bump(skipped, "bookmark");
    const kind = NOTE.test(meta) && !HIGHLIGHT.test(meta) ? "note" : HIGHLIGHT.test(meta) ? "highlight" : null;
    if (!kind) return bump(skipped, "unknown");
    if (!body) return bump(skipped, "empty");
    const loc = LOCATION.exec(meta);
    const page = PAGE.exec(meta);
    const start = loc ? Number(loc[1]) : page ? Number(page[1]) * 1000 : order;
    let end = loc?.[2] ? Number(loc[2]) : start;
    // "180-2" means 180–182.
    if (loc?.[2] && end < start) end = Number(loc[1].slice(0, loc[1].length - loc[2].length) + loc[2]);
    clips.push({ title, author, kind, start, end, page: page ? Number(page[1]) : null, hasLoc: !!loc, created: parseDate(meta), text: body, order });
  });

  // Edited highlights: the last clipping at a start location wins.
  const highlights = new Map<string, Clip>();
  for (const c of clips) if (c.kind === "highlight") highlights.set(`${c.title}\u0000${c.author}\u0000${c.start}`, c);
  const notes = new Map<Clip, string[]>();
  const placed: Array<{ order: number; row: Parameters<typeof groupBooks>[1][number] }> = [];
  for (const n of clips.filter((c) => c.kind === "note")) {
    const host = [...highlights.values()].filter((h) => h.title === n.title && h.author === n.author && n.start >= h.start && n.start <= h.end).pop();
    if (host) notes.set(host, [...(notes.get(host) ?? []), n.text]);
    else placed.push({ order: n.order, row: { title: n.title, author: n.author, h: entry(n, "", n.text) } });
  }
  for (const h of highlights.values()) placed.push({ order: h.order, row: { title: h.title, author: h.author, h: entry(h, h.text, (notes.get(h) ?? []).join("\n\n")) } });
  // Books in the order the file first mentions them.
  const firstSeen = new Map<string, number>();
  for (const c of clips) if (!firstSeen.has(`${c.title}\u0000${c.author}`)) firstSeen.set(`${c.title}\u0000${c.author}`, c.order);
  placed.sort((x, y) => firstSeen.get(`${x.row.title}\u0000${x.row.author}`)! - firstSeen.get(`${y.row.title}\u0000${y.row.author}`)! || x.order - y.order);
  return { books: groupBooks("kindle", placed.map((p) => p.row)), skipped };
}

function entry(c: Clip, text: string, note: string): ImportedHighlight {
  const loc = !c.hasLoc ? null : c.start === c.end ? `loc. ${c.start}` : `loc. ${c.start}–${c.end}`;
  const location = c.page !== null ? (loc ? `p. ${c.page} · ${loc}` : `p. ${c.page}`) : loc;
  return { id: highlightId(c.title, c.author, text, note), text, note, location, sort: c.start, created: c.created, color: null, tags: [], link: null };
}
