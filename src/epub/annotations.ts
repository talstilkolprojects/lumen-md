/**
 * EPUB highlights (plan W1.14): the same W3C Web Annotation model as the PDF
 * reader (4.14). A highlight targets a chapter of the book — a
 * FragmentSelector `chapter=N` (1-based spine position) — refined by a
 * TextQuoteSelector (the words and a little context, which is what finds it
 * again) and a TextPositionSelector (offsets in the chapter's text, a tie
 * breaker). Re-anchoring is the PDF module's: exact, then modulo spacing /
 * case / niqqud, then approximate.
 *
 * Stored in a companion note `<book>.epub.md`, between our own markers: a
 * readable list with `[[book.epub#chapter=N&highlight=ID|…]]` links and a
 * fenced JSON block. The rest of the note is the user's.
 *
 * Pure.
 */
import { ANNO_CONTEXT, anchorTextQuote, createTextQuoteSelector, encodeWikiPath, shortId, type Anchor, type TextPositionSelector, type TextQuoteSelector, type TextualBody } from "../pdf/annotations";

export const CHAPTER_SCHEME = "lumen:epub-chapter";

export interface EpubFragmentSelector {
  type: "FragmentSelector";
  conformsTo: typeof CHAPTER_SCHEME;
  /** `chapter=N` (1-based). */
  value: string;
  refinedBy: TextQuoteSelector | TextPositionSelector;
}

export interface EpubAnnotation {
  "@context": typeof ANNO_CONTEXT;
  id: string;
  type: "Annotation";
  motivation: "highlighting" | "commenting";
  created: string;
  modified?: string;
  body?: TextualBody[];
  target: { source: string; selector: EpubFragmentSelector[] };
}

export function createEpubAnnotation(opts: { id: string; source: string; chapter: number; text: string; start: number; end: number; note?: string; now?: Date }): EpubAnnotation {
  const chapter = Math.max(1, Math.floor(opts.chapter));
  const s = Math.min(opts.start, opts.end);
  const e = Math.max(opts.start, opts.end);
  const a: EpubAnnotation = {
    "@context": ANNO_CONTEXT,
    id: opts.id.startsWith("urn:") ? opts.id : `urn:uuid:${opts.id}`,
    type: "Annotation",
    motivation: opts.note ? "commenting" : "highlighting",
    created: (opts.now ?? new Date()).toISOString(),
    target: {
      source: opts.source,
      selector: [
        { type: "FragmentSelector", conformsTo: CHAPTER_SCHEME, value: `chapter=${chapter}`, refinedBy: createTextQuoteSelector(opts.text, s, e) },
        { type: "FragmentSelector", conformsTo: CHAPTER_SCHEME, value: `chapter=${chapter}`, refinedBy: { type: "TextPositionSelector", start: s, end: e } },
      ],
    },
  };
  if (opts.note?.trim()) a.body = [{ type: "TextualBody", value: opts.note.trim(), format: "text/plain", purpose: "commenting" }];
  return a;
}

export function withEpubNote(a: EpubAnnotation, note: string, now = new Date()): EpubAnnotation {
  const value = note.trim();
  const next: EpubAnnotation = { ...a, modified: now.toISOString(), motivation: value ? "commenting" : "highlighting" };
  // Tags (W1.15) are kept; only the note changes.
  const body: TextualBody[] = [...(value ? [{ type: "TextualBody" as const, value, format: "text/plain" as const, purpose: "commenting" as const }] : []), ...(a.body ?? []).filter((b) => b.purpose === "tagging")];
  if (body.length) next.body = body;
  else delete next.body;
  return next;
}

/** `chapter=3&highlight=ab12cd34` (a leading # is fine). */
export function parseEpubFragment(fragment: string | null | undefined): { chapter: number | null; highlight: string | null } {
  const out = { chapter: null as number | null, highlight: null as string | null };
  for (const part of (fragment ?? "").replace(/^#/, "").split("&")) {
    const [k, v = ""] = part.split("=");
    if (k === "chapter" && /^\d+$/.test(v) && Number(v) > 0) out.chapter = Number(v);
    if (k === "highlight" && /^[\w-]+$/.test(v)) out.highlight = v;
  }
  return out;
}

export function describeEpubAnnotation(a: EpubAnnotation): { chapter: number; quote: TextQuoteSelector | null; position: TextPositionSelector | null; note: string } {
  let chapter = 1;
  let quote: TextQuoteSelector | null = null;
  let position: TextPositionSelector | null = null;
  for (const s of a.target.selector) {
    const f = parseEpubFragment(s.value);
    if (f.chapter) chapter = f.chapter;
    if (s.refinedBy?.type === "TextQuoteSelector" && !quote) quote = s.refinedBy;
    if (s.refinedBy?.type === "TextPositionSelector" && !position) position = s.refinedBy;
  }
  return { chapter, quote, position, note: a.body?.find((b) => b.type === "TextualBody" && b.purpose !== "tagging")?.value ?? "" };
}

/** Find the highlight again in its chapter's current text. */
export function anchorEpubAnnotation(a: EpubAnnotation, chapterText: string): Anchor | null {
  const d = describeEpubAnnotation(a);
  if (!d.quote) return d.position && d.position.end <= chapterText.length ? { start: d.position.start, end: d.position.end, match: "exact" } : null;
  return anchorTextQuote(chapterText, d.quote, d.position?.start);
}

/* ─── Companion note ──────────────────────────────────────────────── */

export const EPUB_NOTE_START = "<!-- lumen:epub-annotations:start -->";
export const EPUB_NOTE_END = "<!-- lumen:epub-annotations:end -->";
const JSON_INFO = "json lumen-epub-annotations";

export const epubCompanionPath = (bookPath: string) => `${bookPath}.md`;

export function epubHighlightLink(bookPath: string, a: EpubAnnotation): string {
  return `${encodeWikiPath(bookPath)}#chapter=${describeEpubAnnotation(a).chapter}&highlight=${shortId(a.id)}`;
}

function isEpubAnnotation(x: unknown): x is EpubAnnotation {
  const a = x as Partial<EpubAnnotation> | null;
  return !!a && a.type === "Annotation" && typeof a.id === "string" && !!a.target && typeof a.target.source === "string" && Array.isArray(a.target.selector) && a.target.selector.every((s) => !!s && s.type === "FragmentSelector" && typeof s.value === "string");
}

/** Strict read: null when a highlights block exists but can't be read whole (never save over it). */
export function readEpubNote(md: string | null | undefined): EpubAnnotation[] | null {
  if (!md) return [];
  const start = md.indexOf(EPUB_NOTE_START);
  const end = start === -1 ? -1 : md.indexOf(EPUB_NOTE_END, start);
  const hasInfo = /^[ \t]*(`{3,}|~{3,})[ \t]*json[ \t]+lumen-epub-annotations/m.test(md);
  if (start === -1 && !hasInfo) return [];
  if (start !== -1 && end === -1) return null;
  const region = start === -1 ? md : md.slice(start, end);
  const fence = /(`{3,}|~{3,})[ \t]*json[ \t]+lumen-epub-annotations[^\n]*\n([\s\S]*?)\n\1/.exec(region);
  if (!fence) return null;
  try {
    const data = JSON.parse(fence[2]) as unknown;
    return Array.isArray(data) && data.every(isEpubAnnotation) ? data : null;
  } catch {
    return null;
  }
}

const inline = (s: string) => s.replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>|#~])/g, "\\$1");

export interface EpubNoteLabels {
  title: string;
  chapter: (n: number, label: string) => string;
  empty: string;
}

export function renderEpubBlock(bookPath: string, annotations: readonly EpubAnnotation[], labels: EpubNoteLabels, chapterLabel: (n: number) => string = (n) => String(n)): string {
  const sorted = [...annotations].sort((a, b) => {
    const da = describeEpubAnnotation(a);
    const db = describeEpubAnnotation(b);
    return da.chapter - db.chapter || (da.position?.start ?? 0) - (db.position?.start ?? 0) || a.created.localeCompare(b.created);
  });
  const lines = sorted.map((a) => {
    const d = describeEpubAnnotation(a);
    return `- [[${epubHighlightLink(bookPath, a)}|${inline(labels.chapter(d.chapter, chapterLabel(d.chapter)))}]] “${inline(d.quote?.exact ?? "")}”${d.note ? ` — ${inline(d.note)}` : ""}`;
  });
  const json = JSON.stringify(sorted, null, 2).replace(/</g, "\\u003c");
  const fence = "`".repeat(Math.max(2, ...Array.from(json.matchAll(/`+/g), (m) => m[0].length)) + 1);
  return [EPUB_NOTE_START, "", ...(lines.length ? lines : [labels.empty]), "", `${fence}${JSON_INFO}`, json, fence, "", EPUB_NOTE_END].join("\n");
}

export function upsertEpubNote(existing: string | null | undefined, bookPath: string, annotations: readonly EpubAnnotation[], labels: EpubNoteLabels, chapterLabel?: (n: number) => string): string {
  const block = renderEpubBlock(bookPath, annotations, labels, chapterLabel);
  if (!existing || !existing.trim()) return `# ${labels.title}\n\n${block}\n`;
  const start = existing.indexOf(EPUB_NOTE_START);
  const end = start === -1 ? -1 : existing.indexOf(EPUB_NOTE_END, start);
  if (start !== -1 && end !== -1) return existing.slice(0, start) + block + existing.slice(end + EPUB_NOTE_END.length);
  return `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
}
