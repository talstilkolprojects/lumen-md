/**
 * Which attachments a deleted note leaves behind (plan W7.3, Obsidian 1.12's
 * "delete attachments too"). Pure: the caller gives the notes' text and the
 * vault's file list.
 *
 * The rule is conservative, so a file another note may link to is never
 * offered for deletion:
 *  - a deleted note's link picks one file (the same folder first, then the
 *    shortest path, as Obsidian does);
 *  - a surviving note's link keeps every file it could mean (every file with
 *    that name when the link has no folder), and a surviving note that only
 *    names the file in its text (a canvas card, a code span) keeps it too.
 */

/** Notes and the other text files whose links count. */
const NOTE = /\.(md|markdown|canvas|base)$/i;

/** `[[target]]`, `![[target|300]]`, `[[target#heading|label]]`. */
const WIKI = /!?\[\[([^\]\r\n|#^]+)(?:[#^][^\]\r\n|]*)?(?:\|[^\]\r\n]*)?\]\]/g;
/** `![alt](path)`, `[text](<path with spaces> "title")`. */
const MD_LINK = /!?\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^)\s]+)(?:\s+"[^"\r\n]*")?\s*\)/g;

export interface AttachmentRef {
  /** The link's target, decoded, without `#…` or `|…`. */
  target: string;
  /** Wiki-links resolve by name; Markdown links are relative to the note. */
  kind: "wiki" | "markdown";
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Every link in a note that points at a file that is not a note. */
export function attachmentRefsOf(content: string): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  for (const m of content.matchAll(WIKI)) {
    const target = m[1].trim();
    if (target && hasExtension(target) && !NOTE.test(target)) out.push({ target, kind: "wiki" });
  }
  for (const m of content.matchAll(MD_LINK)) {
    let target = m[1].trim();
    if (target.startsWith("<")) target = target.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//")) continue;
    target = decode(target.replace(/[#?].*$/, ""));
    if (target && hasExtension(target) && !NOTE.test(target)) out.push({ target, kind: "markdown" });
  }
  return out;
}

function hasExtension(p: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(p.split("/").pop() ?? "");
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function normalise(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** The files a link from `notePath` could mean; with `one`, only the file it resolves to. */
export function candidatesFor(ref: AttachmentRef, notePath: string, files: ReadonlySet<string>, byName: ReadonlyMap<string, string[]>, one: boolean): string[] {
  const fromDir = dirOf(notePath);
  const hits: string[] = [];
  const add = (p: string) => {
    if (files.has(p) && !hits.includes(p)) hits.push(p);
  };
  if (ref.target.startsWith("/")) add(normalise(ref.target));
  else {
    add(normalise(fromDir ? `${fromDir}/${ref.target}` : ref.target));
    add(normalise(ref.target));
  }
  if (one && hits.length) return hits.slice(0, 1);
  // A bare name (or a path that matched nothing): every file with that name.
  const named = (byName.get(baseOf(ref.target).toLowerCase()) ?? []).filter((p) => ref.target.includes("/") ? p.endsWith(normalise(ref.target)) : true);
  if (one) {
    const best = [...named].sort((a, b) => Number(dirOf(b) === fromDir) - Number(dirOf(a) === fromDir) || a.length - b.length || a.localeCompare(b))[0];
    return hits.length ? hits.slice(0, 1) : best ? [best] : [];
  }
  for (const p of named) add(p);
  return hits;
}

export interface OrphanInput {
  /** The paths being deleted (files or folders). */
  deleted: readonly string[];
  /** Every note (and canvas or base file) with its text, deleted ones included. */
  notes: ReadonlyArray<{ path: string; content: string }>;
  /** Every file in the vault. */
  files: readonly string[];
}

/**
 * The attachments that only deleted notes link to, sorted. Files already
 * inside a deleted folder are not listed (they go anyway).
 */
export function orphanAttachments({ deleted, notes, files }: OrphanInput): string[] {
  const gone = (p: string) => deleted.some((d) => p === d || p.startsWith(d + "/"));
  const fileSet = new Set(files);
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const k = baseOf(f).toLowerCase();
    const list = byName.get(k);
    if (list) list.push(f);
    else byName.set(k, [f]);
  }
  const wanted = new Set<string>();
  for (const n of notes) {
    if (!gone(n.path) || !NOTE.test(n.path)) continue;
    for (const ref of attachmentRefsOf(n.content)) for (const p of candidatesFor(ref, n.path, fileSet, byName, true)) wanted.add(p);
  }
  for (const p of [...wanted]) if (gone(p) || NOTE.test(p)) wanted.delete(p);
  if (!wanted.size) return [];
  const kept = new Set<string>();
  for (const n of notes) {
    if (gone(n.path)) continue;
    for (const ref of attachmentRefsOf(n.content)) for (const p of candidatesFor(ref, n.path, fileSet, byName, false)) kept.add(p);
    // A name in the text with no link syntax (a canvas card's "file", a code span): keep it.
    const lower = n.content.toLowerCase();
    for (const p of wanted) if (lower.includes(baseOf(p).toLowerCase())) kept.add(p);
  }
  return [...wanted].filter((p) => !kept.has(p)).sort();
}
