/**
 * All highlights in one place (plan W1.15): an index of every highlight and
 * its note — PDF (`<file>.pdf.md`, 4.14), EPUB (`<book>.epub.md`, W1.14) and
 * clipped pages (`==…==` in a note whose front matter says it was clipped,
 * 4.15) — with search over the highlighted text and the note, filters by
 * kind, source and tag, tags written back into the sidecar note as W3C
 * `tagging` bodies, and an export to a note whose links go back to each
 * highlight.
 *
 * Pure: it works on (path, text) pairs, so it can run on the main thread or
 * in the vault worker (8.4) unchanged. Search folds case, spacing and niqqud
 * once per item, then is a substring scan (5,000 highlights well under
 * 100 ms; pinned by the tests).
 */
import { describeAnnotation, encodeWikiPath, highlightLinkTarget, normalizeWithMap, readAnnotationsNote, type PdfAnnotation, type TextualBody } from "../pdf/annotations";
import { describeEpubAnnotation, epubHighlightLink, readEpubNote, type EpubAnnotation } from "../epub/annotations";
import { isImportNote, readImportNote } from "./import/notes";

export type HighlightKind = "pdf" | "epub" | "clip" | "import";

export interface HighlightItem {
  /** Stable within the index: kind + note path + annotation id (or position for clips). */
  key: string;
  kind: HighlightKind;
  /** The document read: the PDF, the book, or the clip note. */
  source: string;
  /** Where the highlight is stored (the sidecar note, or the clip note itself). */
  notePath: string;
  /** The annotation id (PDF / EPUB). */
  id: string | null;
  text: string;
  note: string;
  tags: string[];
  /** Page (PDF), chapter (EPUB) or null. */
  location: number | null;
  /** Imported highlights (W2.15): where the source app put it ("p. 12 · loc. 180–182"). */
  where?: string | null;
  /** Wiki-link target that opens the highlight. */
  link: string;
  created: string | null;
  /** Folded text + note + tags, for search. */
  haystack: string;
}

const fold = (s: string) => normalizeWithMap(s).text;

export function tagsOf(a: { body?: TextualBody[] }): string[] {
  return (a.body ?? []).filter((b) => b.purpose === "tagging").map((b) => b.value);
}

/** A tag as stored: trimmed, no leading #, inner spaces as dashes. Empty → null. */
export function cleanTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, "").replace(/\s+/g, "-");
  return t ? t : null;
}

/** A copy of an annotation with exactly `tags` as its tagging bodies (the note kept). */
export function withTags<T extends { body?: TextualBody[]; modified?: string }>(a: T, tags: readonly string[], now = new Date()): T {
  const clean = [...new Set(tags.map(cleanTag).filter((t): t is string => !!t))];
  const body: TextualBody[] = [...(a.body ?? []).filter((b) => b.purpose !== "tagging"), ...clean.map((value) => ({ type: "TextualBody" as const, value, format: "text/plain" as const, purpose: "tagging" as const }))];
  const next = { ...a, modified: now.toISOString() };
  if (body.length) next.body = body;
  else delete next.body;
  return next;
}

function item(p: Omit<HighlightItem, "haystack">): HighlightItem {
  return { ...p, haystack: fold([p.text, p.note, ...p.tags.map((t) => `#${t}`)].join(" \u0001 ")) };
}

/** The same item with other tags (its search text rebuilt). */
export function retagItem(it: HighlightItem, tags: readonly string[]): HighlightItem {
  const { haystack: _old, ...rest } = it;
  void _old;
  return item({ ...rest, tags: [...tags] });
}

function pdfItems(notePath: string, md: string): HighlightItem[] {
  const list: PdfAnnotation[] = readAnnotationsNote(md) ?? [];
  return list.map((a) => {
    const d = describeAnnotation(a);
    return item({ key: `pdf:${notePath}:${a.id}`, kind: "pdf", source: a.target.source, notePath, id: a.id, text: d.quote?.exact ?? "", note: d.note, tags: tagsOf(a), location: d.page, link: highlightLinkTarget(a.target.source, a), created: a.created });
  });
}

function epubItems(notePath: string, md: string): HighlightItem[] {
  const list: EpubAnnotation[] = readEpubNote(md) ?? [];
  return list.map((a) => {
    const d = describeEpubAnnotation(a);
    return item({ key: `epub:${notePath}:${a.id}`, kind: "epub", source: a.target.source, notePath, id: a.id, text: d.quote?.exact ?? "", note: d.note, tags: tagsOf(a), location: d.chapter, link: epubHighlightLink(a.target.source, a), created: a.created });
  });
}

/** Is this note a clipped page (front matter with `clipped:` or both `source:` and a URL)? */
export function isClip(md: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1];
  if (!fm) return false;
  return /^clipped:/m.test(fm) || /^source:\s*["']?https?:\/\//m.test(fm);
}

function clipItems(path: string, md: string): HighlightItem[] {
  if (!isClip(md)) return [];
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const tags = [...new Set([...(/^tags:\s*\[([^\]]*)\]/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "")?.[1] ?? "").split(",")].map((s) => cleanTag(s.replace(/["']/g, ""))).filter((t): t is string => !!t))];
  const out: HighlightItem[] = [];
  let n = 0;
  for (const m of body.matchAll(/(^|[^{=])==(?!\s)([^=\n]+?)(?<!\s)==(?!})/g)) {
    n++;
    out.push(item({ key: `clip:${path}:${n}`, kind: "clip", source: path, notePath: path, id: null, text: m[2], note: "", tags, location: null, link: encodeWikiPath(path), created: null }));
  }
  return out;
}

/** Highlights imported from Kindle, Kobo, Readwise or Zotero (W2.15): one note per book. */
function importItems(path: string, md: string): HighlightItem[] {
  if (!isImportNote(md)) return [];
  const { entries } = readImportNote(md);
  return entries.map((e) => item({ key: `import:${path}:${e.id}`, kind: "import", source: path, notePath: path, id: e.id, text: e.text || e.note, note: e.text ? e.note : "", tags: e.tags, location: null, where: e.location, link: encodeWikiPath(path), created: e.created }));
}

/** The index of every highlight in `files` (vault-relative paths with their text). */
export function buildIndex(files: Iterable<{ path: string; content: string }>): HighlightItem[] {
  const out: HighlightItem[] = [];
  for (const f of files) {
    if (/\.pdf\.md$/i.test(f.path)) out.push(...pdfItems(f.path, f.content));
    else if (/\.epub\.md$/i.test(f.path)) out.push(...epubItems(f.path, f.content));
    else if (/\.(md|markdown)$/i.test(f.path)) out.push(...(isImportNote(f.content) ? importItems(f.path, f.content) : clipItems(f.path, f.content)));
  }
  return out;
}

/** Which files the index reads (the rest of the vault is skipped). */
export const isIndexed = (path: string) => /\.(md|markdown)$/i.test(path);

export interface Query {
  text?: string;
  kind?: HighlightKind | null;
  /** A document path (exact). */
  source?: string | null;
  tag?: string | null;
}

/** Items matching every given filter; the text matches the highlight, its note or a tag (case / spacing / niqqud-insensitive). */
export function search(items: readonly HighlightItem[], q: Query): HighlightItem[] {
  const needle = q.text ? fold(q.text) : "";
  const tag = q.tag ? cleanTag(q.tag) : null;
  return items.filter(
    (it) =>
      (!q.kind || it.kind === q.kind) &&
      (!q.source || it.source === q.source) &&
      (!tag || it.tags.includes(tag)) &&
      (!needle || it.haystack.includes(needle)),
  );
}

/** Every tag in the index, most used first. */
export function allTags(items: readonly HighlightItem[]): Array<{ tag: string; count: number }> {
  const m = new Map<string, number>();
  for (const it of items) for (const t of it.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Every source in the index with its kind and count, by name. */
export function allSources(items: readonly HighlightItem[]): Array<{ source: string; kind: HighlightKind; count: number }> {
  const m = new Map<string, { kind: HighlightKind; count: number }>();
  for (const it of items) {
    const e = m.get(it.source) ?? { kind: it.kind, count: 0 };
    e.count++;
    m.set(it.source, e);
  }
  return [...m].map(([source, e]) => ({ source, ...e })).sort((a, b) => a.source.localeCompare(b.source));
}

const inline = (s: string) => s.replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>|#~])/g, "\\$1");

export interface ExportLabels {
  title: string;
  /** "p. 3", "ch. 2", or the clip's name. */
  where: (it: HighlightItem) => string;
}

/**
 * The highlights as a note: a section per document, a quote per highlight
 * with its note and tags, and a link that opens the highlight (the page /
 * chapter and flash; for a clip, the clip note).
 */
export function exportNote(items: readonly HighlightItem[], labels: ExportLabels): string {
  const bySource = new Map<string, HighlightItem[]>();
  for (const it of items) bySource.set(it.source, [...(bySource.get(it.source) ?? []), it]);
  const parts = [`# ${labels.title}`, ""];
  for (const [source, list] of [...bySource].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(`## [[${encodeWikiPath(source)}]]`, "");
    for (const it of [...list].sort((a, b) => (a.location ?? 0) - (b.location ?? 0))) parts.push(quoteBlock(it, labels.where(it)), "");
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

/** One highlight as Markdown: a quote with its link (what dragging a highlight into a note inserts). */
export function quoteBlock(it: HighlightItem, where: string): string {
  const lines = [`> ${inline(it.text)}`, `> — [[${it.link}|${inline(where)}]]${it.tags.length ? " " + it.tags.map((t) => `#${t}`).join(" ") : ""}`];
  if (it.note) lines.splice(1, 0, `>`, `> ${inline(it.note)}`);
  return lines.join("\n");
}
