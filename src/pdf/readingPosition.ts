/**
 * W6.47 — where the reader was in each PDF, kept in the vault so that it
 * travels with the vault's sync to the user's other devices.
 *
 * A position is device-independent: the page and how far down that page the
 * top of the view is (0 = the page's top, 1 = its bottom), never pixels or
 * the zoom. A phone at 80% and a desktop at 150% open the same PDF at the
 * same line.
 *
 * `.lumen/reading-positions.json` holds one entry per PDF path with the time
 * it was written. Two devices that wrote it before syncing: `mergePositions`
 * keeps the newer entry per PDF, so neither device's reading is lost.
 */

export const POSITIONS_FILE = ".lumen/reading-positions.json";

export interface ReadingPosition {
  page: number;
  /** How far down `page` the top of the view is, 0–1. */
  offset: number;
  /** When it was saved (ms since 1970), for merging two devices' files. */
  updated: number;
}

export interface PositionsFile {
  v: 1;
  docs: Record<string, ReadingPosition>;
}

const empty = (): PositionsFile => ({ v: 1, docs: {} });

function validPosition(p: unknown): p is ReadingPosition {
  const o = p as Partial<ReadingPosition> | null;
  return !!o && Number.isInteger(o.page) && (o.page as number) >= 1 && typeof o.offset === "number" && o.offset >= 0 && o.offset <= 1 && typeof o.updated === "number";
}

/** The file's text as positions; anything unreadable is left out (never throws). */
export function parsePositions(text: string | null): PositionsFile {
  if (!text) return empty();
  try {
    const o = JSON.parse(text) as Partial<PositionsFile>;
    if (o.v !== 1 || !o.docs || typeof o.docs !== "object") return empty();
    const docs: Record<string, ReadingPosition> = {};
    for (const [path, p] of Object.entries(o.docs)) if (validPosition(p)) docs[path] = { page: p.page, offset: p.offset, updated: p.updated };
    return { v: 1, docs };
  } catch {
    return empty();
  }
}

export function serializePositions(f: PositionsFile): string {
  const docs: Record<string, ReadingPosition> = {};
  for (const path of Object.keys(f.docs).sort()) docs[path] = f.docs[path];
  return JSON.stringify({ v: 1, docs }, null, 2) + "\n";
}

/** Both devices' positions: per PDF, the one saved last. */
export function mergePositions(a: PositionsFile, b: PositionsFile): PositionsFile {
  const docs = { ...a.docs };
  for (const [path, p] of Object.entries(b.docs)) if (!docs[path] || p.updated > docs[path].updated) docs[path] = p;
  return { v: 1, docs };
}

/** A page's box in the scroll container: its top and height, in the container's pixels. */
export interface PageBox {
  top: number;
  height: number;
}

/** The position of a view whose top is at `scrollTop`, over pages laid out as `pages` (page 1 first). */
export function positionAt(pages: readonly PageBox[], scrollTop: number): { page: number; offset: number } {
  if (!pages.length) return { page: 1, offset: 0 };
  let i = 0;
  while (i + 1 < pages.length && pages[i + 1].top <= scrollTop) i++;
  const p = pages[i];
  const offset = p.height > 0 ? Math.min(1, Math.max(0, (scrollTop - p.top) / p.height)) : 0;
  return { page: i + 1, offset: Math.round(offset * 10_000) / 10_000 };
}

/** The scrollTop that shows `pos` over pages laid out as `pages`. */
export function scrollTopFor(pages: readonly PageBox[], pos: { page: number; offset: number }): number {
  if (!pages.length) return 0;
  const p = pages[Math.min(pages.length, Math.max(1, pos.page)) - 1];
  return Math.round(p.top + p.height * Math.min(1, Math.max(0, pos.offset)));
}

/** What reading and writing the file needs (the workspace; a fake in tests). */
export interface PositionsIO {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}

/** The saved position for `pdf`, or null. */
export async function loadPosition(io: PositionsIO, pdf: string): Promise<ReadingPosition | null> {
  return parsePositions(await io.read(POSITIONS_FILE).catch(() => null)).docs[pdf] ?? null;
}

/** Save `pos` for `pdf`, keeping every other PDF's entry (read, merge, write). */
export async function savePosition(io: PositionsIO, pdf: string, pos: { page: number; offset: number }, now = Date.now()): Promise<void> {
  const cur = parsePositions(await io.read(POSITIONS_FILE).catch(() => null));
  const prev = cur.docs[pdf];
  if (prev && prev.page === pos.page && Math.abs(prev.offset - pos.offset) < 0.0005) return;
  cur.docs[pdf] = { page: pos.page, offset: pos.offset, updated: now };
  await io.write(POSITIONS_FILE, serializePositions(cur));
}
