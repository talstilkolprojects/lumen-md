/**
 * Where a workspace note came from, for the prompt-injection guard (plan
 * 2.7; `untrusted.ts`). Kept tiny and free of imports: the git sync, the
 * archive import and workspace renames update it on the startup path.
 *
 * A note is outside content when:
 *  - it is in the clip library (`Library/`, `ספרייה/`);
 *  - its frontmatter has `source: https://…` (a clipped page) or
 *    `untrusted: true`;
 *  - it is under `Imported/`, where every archive import writes;
 *  - it, or a folder above it, was recorded by `markUntrustedNote` (git
 *    clone / pull, archive import). Clones made before the guard existed
 *    are recorded once by `ensureProvenanceBackfill`. Renames and moves carry the record
 *    along (`moveUntrustedNotes`), and a note moved out of the library
 *    keeps that provenance.
 */

/**
 * The clip library (`research/clipper.ts` LIBRARY_DIR), repeated here so
 * nothing on the startup path pulls the clipper's HTML converter; a unit
 * test keeps the two in step.
 */
export const isClipLibraryPath = (p: string) => p.startsWith("Library/") || p.startsWith("ספרייה/");

/** Where every archive import writes (`storage/exportAll.ts`), also imports made before the guard existed. */
const isImportedPath = (p: string) => p.startsWith("Imported/");

/** An origin known from the path alone. */
function pathOrigin(p: string): string | null {
  if (isClipLibraryPath(p)) return "clipped page";
  if (isImportedPath(p)) return "imported";
  return null;
}

const REGISTRY_KEY = "lumen.agents.untrustedNotes";
const MAX_ENTRIES = 5000;

type Registry = Record<string, { reason: string; at: number }>;

/** Thrown when a record can't be stored: the write it guards must not happen (fail closed). */
export class ProvenanceStorageError extends Error {
  constructor(cause: unknown) {
    super(`Can't record where these notes came from (${(cause as Error)?.message ?? cause}), so they are not written: free some browser storage and try again`);
    this.name = "ProvenanceStorageError";
  }
}

/** The records, or null when they can't be read (blocked storage, a damaged value): then every note counts as outside content. */
function readRegistry(): Registry | null {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Registry) : null;
  } catch {
    return null;
  }
}

function loadRegistry(): Registry {
  const r = readRegistry();
  if (!r) throw new ProvenanceStorageError("the stored records can't be read");
  return r;
}

/** Store the records or throw `ProvenanceStorageError`: callers record before they write, so a failure stops the write. */
function saveRegistry(r: Registry): void {
  const keys = Object.keys(r);
  if (keys.length > MAX_ENTRIES) for (const k of keys.sort((a, b) => r[a].at - r[b].at).slice(0, keys.length - MAX_ENTRIES)) delete r[k];
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(r));
  } catch (e) {
    throw new ProvenanceStorageError(e);
  }
}

/** Record that `path` (a file or a folder) was written from outside: an import, a git pull or clone. */
export function markUntrustedNote(path: string, reason: string): void {
  markUntrustedNotes([path], reason);
}

export function markUntrustedNotes(paths: string[], reason: string): void {
  if (!paths.length) return;
  const r = loadRegistry();
  const at = Date.now();
  for (const p of paths) r[p] = { reason, at };
  saveRegistry(r);
}

/** The records as they are now (to undo a move whose files did not move). */
export function snapshotRecords(): Readonly<Registry> {
  return { ...loadRegistry() };
}

/** Put a snapshot's records back, keeping any added since: undoing never drops a record (fail closed). */
export function restoreRecords(snapshot: Readonly<Registry>): void {
  saveRegistry({ ...loadRegistry(), ...snapshot });
}

/** The user said a note is theirs now ("trust this note"). */
export function clearUntrustedNote(path: string): void {
  const r = loadRegistry();
  if (!(path in r)) return;
  delete r[path];
  saveRegistry(r);
}

/**
 * A file or folder moved from `from` to `to`: its records (and those of
 * everything inside a folder) move with it. Leaving the clip library
 * records the library origin, so a moved clip stays outside content.
 */
export function moveUntrustedNotes(from: string, to: string): void {
  const r = loadRegistry();
  let changed = false;
  // A record inherited from a folder above `from` (an imported vault, a
  // cloned repo) goes along when the move leaves that folder.
  const parts = from.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const anc = parts.slice(0, i).join("/");
    const rec = r[anc];
    if (!rec) continue;
    if (to !== anc && !to.startsWith(`${anc}/`)) {
      r[to] = { reason: rec.reason, at: Date.now() };
      changed = true;
    }
    break;
  }
  for (const k of Object.keys(r)) {
    if (k === from || k.startsWith(`${from}/`)) {
      r[to + k.slice(from.length)] = r[k];
      delete r[k];
      changed = true;
    }
  }
  // Origins known by path alone (the clip library, Imported/) are written
  // down when the move leaves them, unless a record above already says so.
  const origin = pathOrigin(from) ?? pathOrigin(`${from}/`);
  if (origin && !pathOrigin(to) && !pathOrigin(`${to}/`) && !r[to]) {
    r[to] = { reason: `${origin} (moved from ${from})`, at: Date.now() };
    changed = true;
  }
  if (changed) saveRegistry(r);
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/;

/**
 * Why a note counts as outside content (empty: it doesn't). `content` is
 * optional; without it only the path and the records are checked.
 */
export function untrustedSourcesOfNote(path: string | null | undefined, content?: string | null): string[] {
  const out: string[] = [];
  if (path) {
    if (isClipLibraryPath(path)) out.push(`clipped page (${path})`);
    const r = readRegistry();
    if (!r) return [...out, `unknown origin: provenance records unreadable (${path})`];
    // The note itself, or a folder above it (a cloned repo, an imported folder, a moved library).
    const parts = path.split("/");
    let recorded = false;
    for (let i = parts.length; i > 0; i--) {
      const rec = r[parts.slice(0, i).join("/")];
      if (rec) {
        out.push(`${rec.reason} (${path})`);
        recorded = true;
        break;
      }
    }
    if (!recorded && isImportedPath(path)) out.push(`imported (${path})`);
  }
  if (content) {
    const fm = FRONTMATTER.exec(content)?.[1];
    if (fm) {
      const src = /^source:\s*["']?(https?:\/\/[^\s"']+)/im.exec(fm)?.[1];
      if (src && !out.some((s) => s.startsWith("clipped page"))) out.push(`page from ${src}`);
      if (/^(?:lumen-)?untrusted:\s*(?:true|yes)\s*$/im.test(fm)) out.push(`marked untrusted${path ? ` (${path})` : ""}`);
    }
  }
  return out;
}

/* ─── Backfill ─────────────────────────────────────────────────────────── */

const BACKFILL_KEY = "lumen.agents.provenanceBackfill.v1";
let backfill: Promise<void> | null = null;

/**
 * Once per browser: record the git clones made before the guard existed
 * (the folders under the `lumen-git` volume, which are also their workspace
 * folders). Imports need nothing: `Imported/` is recognised by its path.
 * Awaited before provenance is first used (agent runs, the link catalogue,
 * style profiles); a failure is retried next time.
 */
export function ensureProvenanceBackfill(): Promise<void> {
  try {
    if (localStorage.getItem(BACKFILL_KEY)) return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
  backfill ??= (async () => {
    try {
      // Only open the git volume when it exists (it pulls isomorphic-git).
      let hasGit = typeof indexedDB !== "undefined";
      if (hasGit && typeof indexedDB.databases === "function") hasGit = (await indexedDB.databases()).some((d) => d.name === "lumen-git");
      if (hasGit) {
        const { listGitRepos } = await import("../sync/git");
        const r = loadRegistry();
        const repos = (await listGitRepos()).filter((p) => !r[p]);
        markUntrustedNotes(repos, "cloned from git");
      }
      localStorage.setItem(BACKFILL_KEY, "1");
    } catch (e) {
      // Fail closed: without the backfill an old clone would pass as the
      // user's own notes, so whatever awaited it stops too (and retries next time).
      backfill = null;
      throw e;
    }
  })();
  return backfill;
}
