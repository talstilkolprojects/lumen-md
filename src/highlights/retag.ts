/**
 * Tags on a PDF or EPUB highlight, written into its sidecar note as W3C
 * `tagging` bodies (plan W1.15), so they sync with the note. Clip highlights
 * live as ==marks== in the clip itself and take the clip's own `tags:`.
 */
import { readAnnotationsNote, upsertAnnotationsNote, type NoteLabels } from "../pdf/annotations";
import { readEpubNote, upsertEpubNote, type EpubNoteLabels } from "../epub/annotations";
import { withTags, type HighlightItem } from "./hub";

/** The chapter labels a highlights note already shows (`|ch. 2: Title]]`), by chapter, unescaped. */
export function existingChapterLabels(md: string | null): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of (md ?? "").matchAll(/#chapter=(\d+)&highlight=[\w-]+\|((?:\\.|[^\]\\])*)\]\]/g)) {
    if (!out.has(Number(m[1]))) out.set(Number(m[1]), m[2].replace(/\\(.)/g, "$1"));
  }
  return out;
}

export interface RetagLabels {
  pdf: NoteLabels;
  epub: EpubNoteLabels;
}

/** The sidecar text with `item`'s tags set to `tags`. Throws when the note's block can't be read or the highlight isn't in it. */
export function retagSidecar(existing: string | null, item: HighlightItem, tags: readonly string[], labels: RetagLabels, now = new Date()): string {
  if (item.kind === "pdf") {
    const list = readAnnotationsNote(existing);
    if (!list) throw new Error("unreadable highlights block");
    if (!list.some((a) => a.id === item.id)) throw new Error("highlight not found");
    return upsertAnnotationsNote(existing, item.source, list.map((a) => (a.id === item.id ? withTags(a, tags, now) : a)), labels.pdf);
  }
  if (item.kind === "epub") {
    const list = readEpubNote(existing);
    if (!list) throw new Error("unreadable highlights block");
    if (!list.some((a) => a.id === item.id)) throw new Error("highlight not found");
    const shown = existingChapterLabels(existing);
    // Keep the chapter labels the reader wrote (from the book's TOC, not available here).
    const keep: EpubNoteLabels = { ...labels.epub, chapter: (n, label) => shown.get(n) ?? labels.epub.chapter(n, label) };
    return upsertEpubNote(existing, item.source, list.map((a) => (a.id === item.id ? withTags(a, tags, now) : a)), keep);
  }
  throw new Error("clip highlights take the clip's own tags");
}
