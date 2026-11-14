/**
 * The app side of the Ben-Yehuda library (plan W7.7): the vault as storage,
 * the gated, ledgered fetch for the one-time download, and highlights that
 * go to the highlights hub (Highlights/<work> — <author>.md, plan W2.15).
 * Loaded on first use, so none of it is in the startup bundle.
 */
import "./strings";
import { isOPFSAvailable, listWorkspace, readWorkspaceFile, workspaceHasFile, writeWorkspaceFile } from "../../storage/workspace";
import { isSourceEnabled, withGate } from "../open/gate";
import { bookNotePath, mergeBookNote } from "../../highlights/import/notes";
import { highlightId } from "../../highlights/import/model";
import { authorsOf, catalogue, downloadAuthors, loadLibrary, type LibraryStore } from "./core";
import { parseWorkNote, plain, quoteBlock, workUrl, type Library, type Work } from "./library";

export { authorsOf, plain, quoteBlock };

export const LEDGER_REASON = "Project Ben-Yehuda public-domain dump (GitHub): the catalogue and the chosen authors' works";

const vault: LibraryStore = {
  async read(path) {
    if (!isOPFSAvailable()) return null;
    try {
      return (await workspaceHasFile(path)) ? await readWorkspaceFile(path) : null;
    } catch {
      return null;
    }
  },
  write: (path, content) => writeWorkspaceFile(path, content),
  async list(dir) {
    if (!isOPFSAvailable()) return [];
    return (await listWorkspace()).map((f) => f.path).filter((p) => p.startsWith(`${dir}/`));
  },
};

const gate = (confirm: () => Promise<boolean>) => ({ source: "benyehuda", reason: LEDGER_REASON, confirm, enabled: () => isSourceEnabled("benyehuda") });

/** The catalogue: saved, or downloaded after `confirm`. null when declined. */
export function getCatalogue(confirm: () => Promise<boolean>): Promise<Work[] | null> {
  return withGate(gate(confirm), (f) => catalogue({ store: vault, fetch: f }));
}

export async function download(authors: string[], confirm: () => Promise<boolean>, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<{ works: number; skipped: number } | null> {
  const r = await withGate(gate(confirm), (f) => downloadAuthors(authors, { store: vault, fetch: f, onProgress, signal }));
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  return r;
}

let cached: Promise<Library> | null = null;
/** The library from the vault only (no request); rebuilt after a download. */
export function library(fresh = false): Promise<Library> {
  if (fresh || !cached) cached = loadLibrary(vault);
  return cached;
}

/** The saved note of a work, if it was downloaded. */
export async function workNote(w: Work): Promise<{ path: string; content: string } | null> {
  const { workNotePath } = await import("./library");
  const path = workNotePath(w);
  const content = await vault.read(path);
  return content ? { path, content } : null;
}

/** The work an open note is (its frontmatter), or null. */
export async function workOfNote(markdown: string): Promise<Work | null> {
  const parsed = parseWorkNote(markdown);
  if (!parsed) return null;
  const works = await catalogue({ store: vault });
  return works.find((w) => w.id === parsed.id) ?? null;
}

/** Keep a passage of a work in the highlights hub. Returns the note's path. */
export async function highlight(w: Work, passage: string): Promise<string> {
  const title = plain(w.title);
  const text = passage.trim();
  const book = {
    source: "benyehuda" as const,
    title,
    author: w.authors,
    link: workUrl(w),
    highlights: [{ id: highlightId(title, w.authors, text), text, note: "", location: null, sort: 0, created: new Date().toISOString(), color: null, tags: [], link: workUrl(w) }],
  };
  const path = bookNotePath(book);
  const merged = mergeBookNote(await vault.read(path), book);
  await vault.write(path, merged.content);
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  return path;
}
