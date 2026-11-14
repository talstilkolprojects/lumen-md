/**
 * Selective sync (plan W1.8): what this device keeps out of the encrypted
 * sync. Per device, saved on the device only (localStorage), never in the
 * vault: a phone can skip `Videos/` and large PDFs while the laptop syncs
 * everything.
 *
 * An excluded path is invisible to the round in both directions: the local
 * file is never read for upload and never leaves the device, a newer version
 * from the vault is not downloaded, and neither side's deletion is applied.
 * The default excludes nothing (as before this feature).
 */

import type { ExcludeRule } from "./status";

export interface SyncRules {
  /** Folder paths (relative to the vault root), each with everything inside it. */
  folders: string[];
  /** File extensions without the dot, lower case ("mp4", "pdf"). */
  extensions: string[];
  /** Largest attachment (any file that is not a note) to sync, in bytes; null for no limit. */
  maxAttachmentBytes: number | null;
}

export const NO_RULES: SyncRules = { folders: [], extensions: [], maxAttachmentBytes: null };

const KEY = "lumen.sync.rules.v1";

/** Note files: always synced whatever their size (the size limit is for attachments). */
const NOTE_EXT = new Set(["md", "markdown", "mdx", "txt", "canvas", "base"]);

const extOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function isAttachment(path: string): boolean {
  return !NOTE_EXT.has(extOf(path));
}

const cleanFolder = (f: string) =>
  f
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");

/** Normalise rules typed by the user (or read back from storage); drops what can't be a rule. */
/** Strings of a list read from storage or typed by the user (anything else is dropped). */
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function normalizeRules(r: Partial<SyncRules> | null | undefined): SyncRules {
  const folders = [...new Set(strings(r?.folders).map(cleanFolder).filter((f) => f && !f.split("/").some((s) => s === "." || s === "..")))].sort();
  const extensions = [...new Set(strings(r?.extensions).map((e) => e.trim().replace(/^\*?\.+/, "").toLowerCase()).filter((e) => /^[\p{L}\p{N}_-]{1,16}$/u.test(e)))].sort();
  const max: unknown = r?.maxAttachmentBytes;
  return { folders, extensions, maxAttachmentBytes: typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : null };
}

/** Parse the form: folders one per line (or comma separated), extensions separated by commas or spaces, the limit in MB. */
export function parseRulesForm(folders: string, extensions: string, maxMb: string): SyncRules {
  const mb = maxMb.trim() === "" ? null : Number(maxMb.replace(",", "."));
  return normalizeRules({
    folders: folders.split(/[\n,]/),
    extensions: extensions.split(/[\s,;]+/),
    maxAttachmentBytes: mb !== null && Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : null,
  });
}

/** The rule as one predicate for the engine: the reason a path is excluded, or null. */
export function compileRules(rules: SyncRules): ExcludeRule {
  const r = normalizeRules(rules);
  const exts = new Set(r.extensions);
  return (path, size) => {
    const folder = r.folders.find((f) => path === f || path.startsWith(`${f}/`));
    if (folder) return `folder:${folder}`;
    const ext = extOf(path);
    if (ext && exts.has(ext)) return `type:${ext}`;
    if (r.maxAttachmentBytes !== null && size !== null && size > r.maxAttachmentBytes && isAttachment(path)) return `size:${r.maxAttachmentBytes}`;
    return null;
  };
}

/** The saved rules can't be read: the round does not run, so nothing excluded can leave by accident. */
export class SyncRulesUnreadableError extends Error {
  constructor() {
    super("This device's selective-sync rules can't be read, so nothing is synced: open Sync → What syncs on this device and save them again");
    this.name = "SyncRulesUnreadableError";
  }
}

/** This device's rules; NO_RULES when none were saved. Throws `SyncRulesUnreadableError` when they can't be read (fail closed). */
export function loadRules(): SyncRules {
  let raw: string | null;
  let parsed: unknown;
  try {
    raw = localStorage.getItem(KEY);
    if (raw === null) return NO_RULES;
    parsed = JSON.parse(raw);
  } catch {
    throw new SyncRulesUnreadableError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyncRulesUnreadableError();
  return normalizeRules(parsed as Partial<SyncRules>);
}

/** Save this device's rules; throws when storage refuses (the form shows it). */
export function saveRules(rules: SyncRules): SyncRules {
  const r = normalizeRules(rules);
  localStorage.setItem(KEY, JSON.stringify(r));
  return r;
}

export function hasRules(r: SyncRules): boolean {
  return r.folders.length > 0 || r.extensions.length > 0 || r.maxAttachmentBytes !== null;
}
