/**
 * Keep links working when a note is renamed or moved (T46).
 *
 * Rewrites, in every note of the vault:
 * - wiki links `[[old]]`, `[[folder/old]]`, `[[old#heading|label]]` whose
 *   target names the moved note (compared by `noteKey`, so case and niqqud
 *   don't matter), keeping the heading and label. A short `[[old]]` is only
 *   rewritten when it resolved to the moved note (another note may share
 *   the name);
 * - Markdown links `[text](old.md)`, `[text](<Old Note.md>)` and reference
 *   definitions `[ref]: old.md` that point at a moved path relative to the
 *   linking note — and, in a note that itself moved, its relative links to
 *   files that stayed.
 *
 * Code spans and fenced code blocks are left alone: they are not links.
 */

import { noteKey } from "../lib/slug";
import { decodeWikiPath, encodeWikiPath } from "../lib/wikiPath";
import { basename, dirname, listWorkspace, readWorkspaceFile, writeWorkspaceFile } from "./workspace";

const MD_EXT = /\.(md|markdown)$/i;
const stem = (p: string) => basename(p).replace(MD_EXT, "");

function resolve(fromDir: string, rel: string): string {
  const parts = (fromDir ? fromDir.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function relative(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

export interface RewriteOptions {
  /** `oldPath` is a folder: everything under it moved along. */
  folder?: boolean;
  /** Where the linking note was before the move (when it moved itself). */
  notePrevPath?: string;
  /** Every note path before the move, in listing order, to resolve short wiki links. */
  vault?: readonly string[];
}

/** Where `p` is after moving `from` → `to`, or undefined when it did not move. */
function moved(p: string, from: string, to: string, folder: boolean): string | undefined {
  if (p === from) return to;
  if (folder && p.startsWith(from + "/")) return to + p.slice(from.length);
  return undefined;
}

/** Apply `fn` to the text outside fenced code blocks and code spans. */
function outsideCode(content: string, fn: (text: string) => string): string {
  let out = "";
  let buf = "";
  let fence: { ch: string; len: number } | null = null;
  for (const line of content.split(/(?<=\n)/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out += line;
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !line.slice(m[0].length).trim()) fence = null;
      continue;
    }
    // A backtick fence's info string may not contain backticks (CommonMark).
    if (m && !(m[1][0] === "`" && line.slice(m[0].length).includes("`"))) {
      out += outsideSpans(buf, fn);
      buf = "";
      out += line;
      fence = { ch: m[1][0], len: m[1].length };
      continue;
    }
    buf += line;
  }
  return out + outsideSpans(buf, fn);
}

/** Code spans: a run of N backticks up to the next run of exactly N. Only the text outside goes through `fn`. */
function outsideSpans(text: string, fn: (t: string) => string): string {
  if (!text) return text;
  let out = "";
  let last = 0;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const close = new RegExp(`(?<!\`)${m[0]}(?!\`)`, "g");
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(text);
    if (!c) continue;
    out += fn(text.slice(last, m.index)) + text.slice(m.index, c.index + m[0].length);
    last = c.index + m[0].length;
    re.lastIndex = last;
  }
  return out + fn(text.slice(last));
}

/** The note a short `[[name]]` opens: a root-level note of that name, else the first note with that base name. */
function resolveShort(t: string, vault: readonly string[]): string | undefined {
  const key = noteKey(t);
  return vault.find((p) => noteKey(p) === key) ?? vault.find((p) => noteKey(basename(p)) === key);
}

/** Rewrite the links in one note. Returns the new text (same string when nothing changed). */
export function rewriteLinks(content: string, notePath: string, oldPath: string, newPath: string, opts: RewriteOptions = {}): string {
  const folder = !!opts.folder;
  const prevPath = opts.notePrevPath ?? notePath;
  const oldKey = noteKey(stem(oldPath));
  const oldParts = oldPath.replace(MD_EXT, "").split("/").map(noteKey);
  const newStem = stem(newPath);
  const newFull = newPath.replace(MD_EXT, "");
  const prevDir = dirname(prevPath);
  const nextDir = dirname(notePath);

  const wiki = (text: string) =>
    text.replace(/\[\[([^\]\r\n|#]+)((?:#[^\]\r\n|]*)?)((?:\|[^\]\r\n]*)?)\]\]/g, (m, target: string, heading: string, label: string) => {
      // A generated link (a PDF highlight, plan 4.14) percent-encodes the
      // characters that are wiki syntax: compare decoded, write back encoded.
      const written = target.trim();
      const t = decodeWikiPath(written);
      const out = (p: string) => (t === written ? p : encodeWikiPath(p));
      if (t.includes("/")) {
        const parts = t.replace(MD_EXT, "").split("/");
        const n = oldParts.length;
        if (folder ? parts.length <= n : parts.length !== n) return m;
        if (!oldParts.every((k, i) => noteKey(parts[i]) === k)) return m;
        return `[[${out([newFull, ...parts.slice(n)].join("/"))}${heading}${label}]]`;
      }
      if (folder || noteKey(t) !== oldKey) return m;
      // `[[Old]]` with two notes called Old: only the one it opens moved?
      if (opts.vault) {
        const target = resolveShort(t, opts.vault);
        if (target && target !== oldPath) return m;
      }
      return `[[${out(newStem)}${heading}${label}]]`;
    });

  /** New destination for `dest` (as written), or null to keep it. */
  const destination = (dest: string): string | null => {
    const angle = dest.startsWith("<") && dest.endsWith(">");
    const href = angle ? dest.slice(1, -1) : dest;
    if (!href || href.startsWith("#") || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    const cut = href.search(/[?#]/);
    const path = cut < 0 ? href : href.slice(0, cut);
    const suffix = cut < 0 ? "" : href.slice(cut);
    if (!MD_EXT.test(path)) return null;
    let decoded = path;
    try {
      decoded = decodeURI(path);
    } catch {
      /* keep as is */
    }
    const before = resolve(prevDir, decoded);
    const after = moved(before, oldPath, newPath, folder) ?? before;
    if (after === before && prevDir === nextDir) return null;
    const rel = relative(nextDir, after);
    if (rel === decoded) return null;
    const written = angle ? rel : path.includes("%") ? encodeURI(rel) : rel.replace(/ /g, "%20");
    return angle ? `<${written}${suffix}>` : `${written}${suffix}`;
  };

  const markdown = (text: string) =>
    text
      .replace(/(\]\(\s*)(<[^>\r\n]*>|[^)\s]+)/g, (m, open: string, dest: string) => {
        const next = destination(dest);
        return next === null ? m : `${open}${next}`;
      })
      .replace(/^( {0,3}\[(?!\^)[^\]\r\n]+\]:[ \t]*)(<[^>\r\n]*>|\S+)/gm, (m, open: string, dest: string) => {
        const next = destination(dest);
        return next === null ? m : `${open}${next}`;
      });

  const out = outsideCode(content, (text) => markdown(wiki(text)));
  return out === content ? content : out;
}

/**
 * After `oldPath` became `newPath`, rewrite every note that linked to it —
 * and the relative links of the notes that moved. For a folder move, every
 * entry inside counts as moved. `vault` is the note listing from before the
 * move (resolves short wiki links). Returns the paths of the notes that changed.
 */
export async function updateLinksAfterMove(
  oldPath: string,
  newPath: string,
  opts: { folder?: boolean; vault?: readonly string[] } = {},
): Promise<string[]> {
  const files = (await listWorkspace()).filter((f) => MD_EXT.test(f.path));
  const folder = !!opts.folder;
  const previous = (p: string) => (folder ? (p.startsWith(newPath + "/") ? oldPath + p.slice(newPath.length) : p) : p === newPath ? oldPath : p);
  const vault = opts.vault ?? files.map((f) => previous(f.path));
  const changed: string[] = [];
  for (const f of files) {
    const text = await readWorkspaceFile(f.path);
    const next = rewriteLinks(text, f.path, oldPath, newPath, { folder, notePrevPath: previous(f.path), vault });
    if (next !== text) {
      await writeWorkspaceFile(f.path, next);
      changed.push(f.path);
    }
  }
  return changed;
}
