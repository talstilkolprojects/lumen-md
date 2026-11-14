/**
 * W2.22 — the vault index survives a restart. After the index changes, the
 * notes it holds (path, mtime, text) are written to IndexedDB while the
 * browser is idle. The next open lists the vault and takes every note whose
 * mtime still matches from the snapshot, reading only the rest: a 100,000-
 * note vault opens without 100,000 file reads.
 *
 * The snapshot is a cache, never the truth: a note's text is used only if
 * the vault still lists it with the same mtime, and a missing, old-format or
 * unreadable snapshot just means a full build, as before.
 *
 * W6.36: in an encrypted vault the snapshot is sealed and signed with the
 * snapshot subkeys (./snapshotSeal.ts) — given `keys`, only a sealed record
 * is written or accepted. Without `keys` (a plain vault) only a plain one
 * is. A record of the other kind, or one that fails its checks, is refused
 * and deleted: the open builds in full, as with no snapshot. A sealed record
 * has two parts (round 2): a manifest (every note's path, name, mtime and
 * summary) and a body (the texts), so the open can answer from the manifest
 * and index the texts right after.
 */
import { createStore, get, set, del } from "idb-keyval";
import type { SnapshotKeys } from "./snapshotSeal";
import { summarize, type NoteSummary } from "./noteSummary";

// The seal (./snapshotSeal.ts) loads with the first snapshot read or write, not with the
// file tree at start-up (W4.9 startup budget); every use below is already async.
const seal = () => import("./snapshotSeal");

export const SNAPSHOT_VERSION = 1;

export interface SnapshotFile {
  path: string;
  name: string;
  modified: number;
  content: string;
  /** UTF-8 bytes of `content` (review 14.11 S3): checked with the mtime. A snapshot always records it (V1). */
  size?: number;
}

/**
 * UTF-8 length of `s` in bytes, without encoding it: what the vault lists as
 * the note's size (review 14.11 S3). A lone surrogate counts 3, as
 * TextEncoder writes U+FFFD for it.
 */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Whether a note the snapshot (or the index) recorded is the one the vault lists: same mtime, and same size when both are known. */
export function sameNote(known: { modified: number; size?: number }, listed: { modified: number; size?: number }): boolean {
  if (!listed.modified || known.modified !== listed.modified) return false;
  return known.size === undefined || listed.size === undefined || known.size === listed.size;
}

interface Stored {
  v: number;
  /** Which vault (workspace name), so two vaults never share one snapshot. */
  vault: string;
  /** Columns rather than objects: a third less to clone at 100,000 notes. */
  paths: string[];
  names: string[];
  modified: number[];
  contents: string[];
  /** UTF-8 sizes (S3). A record without them is refused (V1). */
  sizes?: number[];
}

let store: ReturnType<typeof createStore> | null = null;
const db = () => (store ??= createStore("lumen-vault-index", "snapshot"));
const KEY = "notes";

export function encodeSnapshot(vault: string, files: Iterable<SnapshotFile>): Stored {
  const s: Stored = { v: SNAPSHOT_VERSION, vault, paths: [], names: [], modified: [], contents: [], sizes: [] };
  for (const f of files) {
    s.paths.push(f.path);
    s.names.push(f.name);
    s.modified.push(f.modified);
    s.contents.push(f.content);
    s.sizes!.push(utf8Length(f.content));
  }
  return s;
}

/** The snapshot as a path → file map, or null if it is missing, for another vault or malformed. */
export function decodeSnapshot(raw: unknown, vault: string): Map<string, SnapshotFile> | null {
  const s = raw as Stored | undefined;
  if (!s || s.v !== SNAPSHOT_VERSION || s.vault !== vault) return null;
  const n = s.paths?.length;
  if (!Array.isArray(s.paths) || ![s.names, s.modified, s.contents].every((c) => Array.isArray(c) && c.length === n)) return null;
  // Review 15 V1: a record without sizes (written before them) is refused like any other old format: its notes are
  // read again once, so no note is trusted on its mtime alone.
  if (!(Array.isArray(s.sizes) && s.sizes.length === n && s.sizes.every((x) => typeof x === "number"))) return null;
  const out = new Map<string, SnapshotFile>();
  for (let i = 0; i < n; i++) {
    const path = s.paths[i];
    const content = s.contents[i];
    if (typeof path !== "string" || typeof content !== "string" || typeof s.modified[i] !== "number") return null;
    const f: SnapshotFile = { path, name: String(s.names[i]), modified: s.modified[i], content };
    if (s.sizes) f.size = s.sizes[i];
    out.set(path, f);
  }
  return out;
}

/** What the last `loadSnapshot` found: for tests and the perf receipt. */
export type SnapshotOutcome = "none" | "restored" | "refused";
export let lastSnapshotOutcome: SnapshotOutcome = "none";

/** A note as the manifest of a sealed snapshot records it: no text. */
export interface SnapshotEntry extends NoteSummary {
  path: string;
  name: string;
  modified: number;
  /** UTF-8 bytes of the note's text (S3). */
  size: number;
}

interface Manifest {
  v: number;
  vault: string;
  paths: string[];
  names: string[];
  modified: number[];
  sizes: number[];
  summaries: NoteSummary[];
}

interface Body {
  v: number;
  vault: string;
  contents: string[];
}

const utf8 = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const parseUtf8 = (u: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(u));
const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === "string");

/** The two parts of a sealed snapshot, encoded (W6.36). */
export function encodeSnapshotParts(vault: string, files: Iterable<SnapshotFile>): { manifest: Uint8Array; body: Uint8Array } {
  const m: Manifest = { v: SNAPSHOT_VERSION, vault, paths: [], names: [], modified: [], sizes: [], summaries: [] };
  const b: Body = { v: SNAPSHOT_VERSION, vault, contents: [] };
  for (const f of files) {
    m.paths.push(f.path);
    m.names.push(f.name);
    m.modified.push(f.modified);
    m.sizes.push(utf8Length(f.content));
    m.summaries.push(summarize(f.content));
    b.contents.push(f.content);
  }
  return { manifest: utf8(m), body: utf8(b) };
}

function isSummary(v: unknown): v is NoteSummary {
  const s = v as NoteSummary | null;
  return (
    !!s &&
    typeof s === "object" &&
    strings(s.wikiTargets) &&
    !!s.meta &&
    typeof s.meta === "object" &&
    strings(s.meta.tags) &&
    !!s.meta.props &&
    typeof s.meta.props === "object" &&
    (s.frontmatter === null || typeof s.frontmatter === "string") &&
    strings(s.noteTags) &&
    typeof s.chars === "number" &&
    strings(s.aliases)
  );
}

function decodeManifest(raw: unknown, vault: string): SnapshotEntry[] | null {
  const m = raw as Manifest | null;
  if (!m || m.v !== SNAPSHOT_VERSION || m.vault !== vault || !strings(m.paths)) return null;
  const n = m.paths.length;
  if (!strings(m.names) || m.names.length !== n || !Array.isArray(m.modified) || m.modified.length !== n || !Array.isArray(m.summaries) || m.summaries.length !== n || !Array.isArray(m.sizes) || m.sizes.length !== n) return null;
  const out: SnapshotEntry[] = [];
  for (let i = 0; i < n; i++) {
    const modified = m.modified[i];
    const summary = m.summaries[i];
    const size = m.sizes[i];
    if (typeof modified !== "number" || typeof size !== "number" || !isSummary(summary)) return null;
    out.push({ ...summary, path: m.paths[i], name: m.names[i], modified, size });
  }
  return out;
}

function decodeBody(raw: unknown, vault: string, n: number): string[] | null {
  const b = raw as Body | null;
  return b && b.v === SNAPSHOT_VERSION && b.vault === vault && strings(b.contents) && b.contents.length === n ? b.contents : null;
}

/** The manifest of a sealed record (W6.36): every note without its text. Refused like a whole snapshot. */
export async function readSnapshotManifest(raw: unknown, vault: string, keys: SnapshotKeys): Promise<{ entries: SnapshotEntry[] | null; refused: boolean }> {
  if (raw === undefined) return { entries: null, refused: false };
  try {
    const entries = decodeManifest(parseUtf8(await (await seal()).openSnapshot(keys, vault, raw, "manifest")), vault);
    return { entries, refused: !entries };
  } catch {
    return { entries: null, refused: true };
  }
}

/** The texts of a sealed record, in its manifest's order; null when the body is refused. */
export async function readSnapshotBody(raw: unknown, vault: string, keys: SnapshotKeys, n: number): Promise<string[] | null> {
  try {
    return decodeBody(parseUtf8(await (await seal()).openSnapshot(keys, vault, raw, "body")), vault, n);
  } catch {
    return null;
  }
}

/**
 * The stored record as a snapshot. Given `keys` it must be sealed by them
 * for this vault (both parts); without, it must be plain. Anything else is
 * refused (null), and `refused` is set when a record was there but not taken.
 */
export async function readSnapshotRecord(raw: unknown, vault: string, keys?: SnapshotKeys): Promise<{ snap: Map<string, SnapshotFile> | null; refused: boolean }> {
  if (raw === undefined) return { snap: null, refused: false };
  if (!keys) {
    const { isSealedSnapshot } = await seal();
    const snap = isSealedSnapshot(raw) ? null : decodeSnapshot(raw, vault);
    return { snap, refused: !snap };
  }
  const { entries } = await readSnapshotManifest(raw, vault, keys);
  const contents = entries && (await readSnapshotBody(raw, vault, keys, entries.length));
  if (!entries || !contents) return { snap: null, refused: true };
  const snap = new Map<string, SnapshotFile>();
  entries.forEach((e, i) => snap.set(e.path, { path: e.path, name: e.name, modified: e.modified, size: e.size, content: contents[i] }));
  return { snap, refused: false };
}

/** The stored record, as it is (the worker opens its parts itself). */
export async function snapshotRaw(): Promise<unknown> {
  try {
    return await get(KEY, db());
  } catch {
    return undefined;
  }
}

export async function loadSnapshot(vault: string, keys?: SnapshotKeys): Promise<Map<string, SnapshotFile> | null> {
  lastSnapshotOutcome = "none";
  try {
    const { snap, refused } = await readSnapshotRecord(await get(KEY, db()), vault, keys);
    if (refused) {
      lastSnapshotOutcome = "refused";
      // A tampered, foreign or wrong-kind record is never tried again.
      await del(KEY, db()).catch(() => {});
    } else if (snap) lastSnapshotOutcome = "restored";
    return snap;
  } catch {
    return null;
  }
}

/** The record to store: plain, or sealed with `keys` (W6.36). */
export async function snapshotRecord(vault: string, files: Iterable<SnapshotFile>, keys?: SnapshotKeys): Promise<unknown> {
  if (!keys) return encodeSnapshot(vault, files);
  const parts = encodeSnapshotParts(vault, files);
  return (await seal()).sealSnapshot(keys, vault, parts.manifest, parts.body);
}

export async function saveSnapshot(vault: string, files: Iterable<SnapshotFile>, keys?: SnapshotKeys): Promise<void> {
  try {
    await set(KEY, await snapshotRecord(vault, files, keys), db());
  } catch {
    // Quota or private mode: the next open builds in full, as before.
    await del(KEY, db()).catch(() => {});
  }
}

export async function dropSnapshot(): Promise<void> {
  await del(KEY, db()).catch(() => {});
}

/** Test hooks (W6.36): the stored record as it is, and a record put in its place. */
export async function __snapshotRecord(): Promise<unknown> {
  return get(KEY, db());
}
export async function __putSnapshotRecord(v: unknown): Promise<void> {
  await set(KEY, v, db());
}
