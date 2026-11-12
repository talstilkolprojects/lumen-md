/**
 * The app side of book-writing mode (plan W5.8): the vault, the renderer,
 * the fonts and the downloads. Loaded with a dynamic import from the palette.
 */
import "./bookStrings";
import { t } from "../i18n";
import { firstRtlLanguage, markdownBaseDirection } from "../lib/textDirection";
import { safeSetHtml } from "../lib/trustedTypes";
import { downloadBytes } from "../storage/exportFormats";
import { listWorkspace, readWorkspaceBlob, readWorkspaceFile, workspaceHasFile, writeWorkspaceFile } from "../storage/workspace";
import { addChapter, bookProgress, chapterBody, chapterTitle, dailyProgress, logPathFor, moveChapter, newBookIndex, parseBookIndex, recordWords, type BookIndex, type BookProgress, type DailyProgress, type WordLog } from "./book";
import { buildEpub, imageMediaType, type EpubFont } from "./epub";
import { bookPrintBody, bookPrintCss } from "./print";
import frankHebrew400 from "@fontsource/frank-ruhl-libre/files/frank-ruhl-libre-hebrew-400-normal.woff2?url";
import frankHebrew700 from "@fontsource/frank-ruhl-libre/files/frank-ruhl-libre-hebrew-700-normal.woff2?url";
import frankLatin400 from "@fontsource/frank-ruhl-libre/files/frank-ruhl-libre-latin-400-normal.woff2?url";

export { moveChapter, addChapter, newBookIndex, parseBookIndex };
export type { BookIndex, BookProgress, DailyProgress };

const FONT_FAMILY = "Frank Ruhl Libre";
const FONT_FILES = [
  { url: frankHebrew400, weight: 400 },
  { url: frankHebrew700, weight: 700 },
  { url: frankLatin400, weight: 400 },
];

const readOrNull = async (path: string) => ((await workspaceHasFile(path).catch(() => false)) ? await readWorkspaceFile(path) : null);

/** The book the note at `path` belongs to: the note itself when it is an index, else an index that lists it. */
export async function findBook(path: string, text?: string): Promise<BookIndex | null> {
  const own = parseBookIndex(path, text ?? (await readOrNull(path)) ?? "");
  if (own) return own;
  for (const f of await listWorkspace()) {
    if (!f.path.endsWith(".md") || f.path === path) continue;
    const body = await readWorkspaceFile(f.path).catch(() => "");
    if (!body.includes("longform:")) continue;
    const book = parseBookIndex(f.path, body);
    if (book?.chapters.some((c) => c.path === path)) return book;
  }
  return null;
}

/** A new book index in `folder`, its chapters the folder's notes in name order. */
export async function createBook(folder: string, title: string, lang: string): Promise<string> {
  const prefix = folder ? `${folder}/` : "";
  const names = (await listWorkspace())
    .map((f) => f.path)
    .filter((p) => p.startsWith(prefix) && p.endsWith(".md") && !p.slice(prefix.length).includes("/"))
    .map((p) => p.slice(prefix.length, -3))
    .filter((n) => n !== title)
    .sort((a, b) => a.localeCompare(b, lang, { numeric: true }));
  const path = `${prefix}${title}.md`;
  if (await workspaceHasFile(path)) throw new Error(t("book.exists", { path }));
  await writeWorkspaceFile(path, newBookIndex({ title, chapters: names, lang }));
  return path;
}

export interface BookState {
  book: BookIndex;
  progress: BookProgress;
  daily: DailyProgress;
}

/** Words per chapter, the book total and today's words (recorded in the book's log). */
export async function loadBookState(book: BookIndex, now = new Date()): Promise<BookState> {
  const texts = new Map<string, string | null>();
  for (const c of book.chapters) texts.set(c.path, await readOrNull(c.path));
  const progress = bookProgress(book, (p) => texts.get(p) ?? null);
  const logPath = logPathFor(book.path);
  let log: WordLog = {};
  try {
    const raw = await readOrNull(logPath);
    if (raw) log = JSON.parse(raw) as WordLog;
  } catch {
    log = {};
  }
  const next = recordWords(log, progress.words, now);
  if (JSON.stringify(next) !== JSON.stringify(log)) await writeWorkspaceFile(logPath, JSON.stringify(next, null, 1) + "\n").catch(() => undefined);
  return { book, progress, daily: dailyProgress(next, now, book.dailyGoal) };
}

async function renderChapterHtml(markdown: string): Promise<string> {
  const { renderMarkdown } = await import("../renderer/pipeline");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { StaticRenderContext } = await import("../renderer/components");
  const tree = await renderMarkdown(markdown, () => false);
  return renderToStaticMarkup(createElement(StaticRenderContext.Provider, { value: true }, tree as React.ReactElement));
}

export interface AssembledChapter {
  title: string;
  html: string;
  lang: string;
  dir: "rtl" | "ltr";
}

/** Every chapter rendered, in order (a missing note is skipped and reported). */
export async function assembleChapters(book: BookIndex): Promise<{ chapters: AssembledChapter[]; missing: string[] }> {
  const chapters: AssembledChapter[] = [];
  const missing: string[] = [];
  const bookDir = bookDirection(book);
  for (const ref of book.chapters) {
    const text = await readOrNull(ref.path);
    if (text === null) {
      missing.push(ref.path);
      continue;
    }
    // A chapter's direction is its own text's (an English chapter in a Hebrew book reads left to right).
    const dir = /\p{L}/u.test(text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/, "")) ? markdownBaseDirection(text) : bookDir;
    chapters.push({ title: chapterTitle(ref.name, text), html: await renderChapterHtml(chapterBody(text)), lang: (dir === "rtl" ? firstRtlLanguage(text) : null) ?? (dir === bookDir ? bookLang(book) : "en"), dir });
  }
  return { chapters, missing };
}

const bookLang = (book: BookIndex) => book.lang ?? "he";
const bookDirection = (book: BookIndex): "rtl" | "ltr" => (/^(he|ar|fa|ur|yi)\b/.test(bookLang(book)) ? "rtl" : "ltr");

async function fontBytes(): Promise<EpubFont | undefined> {
  try {
    const files = await Promise.all(FONT_FILES.map(async (f) => ({ bytes: new Uint8Array(await (await fetch(f.url)).arrayBuffer()), weight: f.weight })));
    return { family: FONT_FAMILY, files };
  } catch {
    return undefined; // no font in the EPUB: readers fall back to their own Hebrew font
  }
}

/** The stable id of a book: kept in its index so every export is the same book to a reader. */
async function bookIdentifier(book: BookIndex): Promise<string> {
  const data = new TextEncoder().encode(`lumen-book:${book.path}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Assemble and download `<title>.epub`. Returns the chapter count and the notes that were missing. */
export async function exportEpub(book: BookIndex): Promise<{ chapters: number; missing: string[]; ms: number }> {
  const start = performance.now();
  const { chapters, missing } = await assembleChapters(book);
  const dirOfIndex = book.path.includes("/") ? book.path.slice(0, book.path.lastIndexOf("/") + 1) : "";
  const bytes = await buildEpub({
    title: book.title,
    author: book.author,
    lang: bookLang(book),
    dir: bookDirection(book),
    identifier: await bookIdentifier(book),
    modified: new Date(),
    chapters,
    font: await fontBytes(),
    labels: { contents: t("book.toc"), titlePage: t("book.titlePage") },
    assets: async (src) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
      const path = decodeURIComponent(src.replace(/^\.\//, "")).replace(/^\/+/, "");
      for (const p of [path, dirOfIndex + path]) {
        const type = imageMediaType(p);
        if (!type || !(await workspaceHasFile(p).catch(() => false))) continue;
        return { bytes: new Uint8Array(await (await readWorkspaceBlob(p)).arrayBuffer()), mediaType: type };
      }
      return null;
    },
  });
  downloadBytes(`${book.title}.epub`, bytes, "application/epub+zip");
  return { chapters: chapters.length, missing, ms: performance.now() - start };
}

/** Open the book's print document; the browser's print dialog offers "Save as PDF". */
export async function printBook(book: BookIndex): Promise<{ chapters: number; missing: string[] }> {
  const { chapters, missing } = await assembleChapters(book);
  const win = window.open("", "_blank");
  if (!win) throw new Error(t("book.popupBlocked"));
  const doc = win.document;
  doc.open();
  doc.close();
  doc.documentElement.lang = bookLang(book);
  doc.documentElement.dir = bookDirection(book);
  doc.title = book.title;
  const style = doc.createElement("style");
  style.textContent = bookPrintCss({ dir: bookDirection(book), fonts: FONT_FILES.map((f) => ({ family: FONT_FAMILY, url: new URL(f.url, location.href).href, weight: f.weight })) });
  doc.head.appendChild(style);
  safeSetHtml(doc.body, bookPrintBody({ title: book.title, author: book.author, lang: bookLang(book), dir: bookDirection(book), chapters, labels: { contents: t("book.toc") } }));
  await doc.fonts?.ready.catch(() => undefined);
  win.focus();
  win.print();
  return { chapters: chapters.length, missing };
}

/** Write a reordered index back. */
export async function saveIndex(path: string, text: string): Promise<void> {
  await writeWorkspaceFile(path, text);
}

export const readIndex = (path: string) => readWorkspaceFile(path);
