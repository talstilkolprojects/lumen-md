/**
 * Highlights by address (plan 4.15.4). Passages the user highlighted on a
 * page are kept per URL (the extension sends them with the clip; the
 * "Highlights" command lists them), and clipping the same page again puts
 * them back at the top of the note. Stored in localStorage: a few KB of text
 * per page, on this device only.
 */

export interface Highlight {
  text: string;
  /** When it was highlighted (ISO). */
  at: string;
}

const KEY = "lumen.clip.highlights";
const MAX_PAGES = 500;

/** The page's identity: no fragment, no tracking parameters. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch {
    return url;
  }
}

function load(): Record<string, Highlight[]> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function save(all: Record<string, Highlight[]>): void {
  const keys = Object.keys(all);
  // Oldest pages go first once the store is full.
  if (keys.length > MAX_PAGES) {
    keys
      .sort((a, b) => (all[a].at(-1)?.at ?? "").localeCompare(all[b].at(-1)?.at ?? ""))
      .slice(0, keys.length - MAX_PAGES)
      .forEach((k) => delete all[k]);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* why: storage full or blocked: the highlights still go into this clip */
  }
}

export function highlightsFor(url: string): Highlight[] {
  return load()[pageKey(url)] ?? [];
}

/** Add highlights for a page; duplicates (same text) are kept once. */
export function addHighlights(url: string, texts: string[], now = new Date()): Highlight[] {
  const all = load();
  const key = pageKey(url);
  const list = all[key] ?? [];
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (text && !list.some((h) => h.text === text)) list.push({ text, at: now.toISOString() });
  }
  if (list.length) all[key] = list;
  save(all);
  return list;
}

export function pagesWithHighlights(): Array<{ url: string; count: number }> {
  return Object.entries(load()).map(([url, l]) => ({ url, count: l.length }));
}

/** Markdown for the top of the note: each highlight as a ==marked== quote. */
export function highlightsMarkdown(list: Highlight[]): string {
  return list.map((h) => `> ==${h.text.replace(/==/g, "=")}==`).join("\n>\n");
}
