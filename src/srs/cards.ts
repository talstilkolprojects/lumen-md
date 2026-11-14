/**
 * What can be reviewed (plan W3.3): highlights (W1.15's index — PDF, EPUB,
 * clips) and question::answer lines in notes, and the review file that holds
 * every card's schedule in the vault (`.lumen/review.json`), so it syncs
 * with the vault and moves with it to another device.
 *
 * question::answer: one line, `::` between the two sides. Dataview-style
 * fields (`status:: done`) are not cards: the question must have a space in
 * it or end with "?". Lines in fenced code are skipped.
 *
 * Pure.
 */
import { newCard, type Card, type Rating, type Scheduler } from "./fsrs";
import type { HighlightItem } from "../highlights/hub";
import { encodeWikiPath } from "../pdf/annotations";

export const REVIEW_PATH = ".lumen/review.json";

export interface Source {
  id: string;
  kind: "qa" | "highlight";
  front: string;
  back: string;
  /** Wiki-link target to the card's place (the note, or the highlight). */
  link: string;
  /** The note or document it came from. */
  source: string;
}

export interface Entry extends Source {
  added: string;
  card: Card;
  /** The source is gone from the vault: kept (with its history), not reviewed. */
  gone?: boolean;
  /** The last ratings, newest last (at most 20). */
  log: Array<{ at: string; rating: Rating }>;
  /** When the card was first reviewed (counts against the day's new cards). */
  introduced?: string;
}

export interface ReviewFile {
  version: 1;
  cards: Record<string, Entry>;
}

/** A short stable hash (FNV-1a, 32 bit, hex) for ids. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** question::answer cards in one note. */
export function qaCards(path: string, md: string): Source[] {
  const out: Source[] = [];
  let fence: string | null = null;
  for (const line of md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^\s*(?:[-*+]\s+)?(.+?)\s*::\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const q = m[1].replace(/^#+\s*/, "").trim();
    const a = m[2].trim();
    if (!a || q.length < 3 || !(/\s/.test(q) || /[?？؟]$/.test(q))) continue;
    out.push({ id: `qa:${path}#${hash(q)}`, kind: "qa", front: q, back: a, link: encodeWikiPath(path), source: path });
  }
  return out;
}

/** A highlight as a card: the passage to recall, with its note and source on the back. */
export function highlightCard(it: HighlightItem): Source {
  const id = it.id ? `hl:${it.notePath}#${it.id}` : `hl:${it.notePath}#${hash(it.text)}`;
  return { id, kind: "highlight", front: it.text, back: it.note, link: it.link, source: it.source };
}

export function emptyReviewFile(): ReviewFile {
  return { version: 1, cards: {} };
}

/** Parse the review file; a damaged file is null (never overwritten blindly). */
export function parseReviewFile(text: string | null): ReviewFile | null {
  if (!text) return emptyReviewFile();
  try {
    const v = JSON.parse(text) as Partial<ReviewFile>;
    if (v.version !== 1 || !v.cards || typeof v.cards !== "object") return null;
    return v as ReviewFile;
  } catch {
    return null;
  }
}

export const serializeReviewFile = (f: ReviewFile) => JSON.stringify(f, null, 1) + "\n";

/**
 * The review file after the vault's current sources: new sources become new
 * cards, existing ones get their current text, and cards whose source is
 * gone are marked (kept, not reviewed). Schedules are never touched.
 */
export function syncSources(file: ReviewFile, sources: readonly Source[], now: Date): ReviewFile {
  const cards: Record<string, Entry> = {};
  const seen = new Set<string>();
  for (const s of sources) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const old = file.cards[s.id];
    cards[s.id] = old ? { ...old, ...s, gone: undefined } : { ...s, added: now.toISOString(), card: newCard(now), log: [] };
    if (!cards[s.id].gone) delete cards[s.id].gone;
  }
  for (const [id, e] of Object.entries(file.cards)) if (!seen.has(id)) cards[id] = { ...e, gone: true };
  return { version: 1, cards };
}

export interface QueueOpts {
  /** New cards per day. */
  newPerDay?: number;
  /** Cards in one review. */
  max?: number;
}

/**
 * Today's review: due cards (most overdue first), then new cards (oldest
 * first) up to `newPerDay`, `max` in all — 5–10 items with the defaults.
 */
export function dailyQueue(file: ReviewFile, now: Date, opts: QueueOpts = {}): Entry[] {
  const max = opts.max ?? 10;
  const newPerDay = opts.newPerDay ?? 5;
  const live = Object.values(file.cards).filter((e) => !e.gone);
  const today = now.toISOString().slice(0, 10);
  const newToday = live.filter((e) => e.introduced?.slice(0, 10) === today).length;
  const due = live.filter((e) => e.card.state !== "new" && e.card.due <= now.toISOString()).sort((a, b) => a.card.due.localeCompare(b.card.due));
  const fresh = live.filter((e) => e.card.state === "new").sort((a, b) => a.added.localeCompare(b.added) || a.id.localeCompare(b.id));
  return [...due, ...fresh.slice(0, Math.max(0, newPerDay - newToday))].slice(0, max);
}

/** The file after rating one card. */
export function rate(file: ReviewFile, id: string, rating: Rating, now: Date, scheduler: Scheduler): ReviewFile {
  const e = file.cards[id];
  if (!e) return file;
  const log = [...e.log, { at: now.toISOString(), rating }].slice(-20);
  const introduced = e.introduced ?? (e.card.state === "new" ? now.toISOString() : undefined);
  return { ...file, cards: { ...file.cards, [id]: { ...e, card: scheduler.next(e.card, rating, now), log, ...(introduced ? { introduced } : {}) } } };
}
