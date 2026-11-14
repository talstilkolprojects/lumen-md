/**
 * The vault integrity check (plan W1.5): finds what a crash, a sync client
 * or another app can leave behind in a vault folder, and repairs what can
 * be repaired, with a backup of every file before it is changed.
 *
 * It reads every file once, through the active `VaultBackend`, so it works
 * the same on every platform. Twelve kinds of damage:
 *
 *   truncated-utf8           the file ends in the middle of a character (a cut write)
 *   invalid-utf8             bytes that are not UTF-8 (e.g. Hebrew saved as Windows-1255)
 *   utf16                    a UTF-16 file (byte-order mark) where UTF-8 is expected
 *   nul-bytes                NUL bytes in a text file (a write that zero-filled)
 *   empty-file               a text file with no bytes at all (a write cut at the start)
 *   bad-data                 JSON / YAML data (.json .canvas .excalidraw .base .yaml) that does not parse
 *   bad-frontmatter          front matter that never closes or is not valid YAML
 *   case-collision           names in one folder that differ only in upper/lower case
 *                            (one hides the other on macOS, Windows and phones)
 *   normalization-collision  names that differ only in Unicode normalisation (NFC / NFD)
 *   broken-link              a [[wiki link]] or relative Markdown link to a note that is not there
 *   orphan-temp              a temporary file of a save that was stopped (ours or another writer's)
 *   interrupted-write        a save stopped between its steps: the note is missing, its versions are there
 *
 * Repairs (all others are reported only): cut characters dropped; Windows-1255
 * and UTF-16 converted to UTF-8; NUL bytes removed; colliding names renamed
 * "name (2).md"; orphan temporary files removed; interrupted saves finished
 * (./atomic.ts). Before any change, each affected file is copied to
 * `.lumen-repair/<time>/<its path>`.
 */

import { isTempName, leftoversOf, parseLeftover, recoverDir, type AtomicFs, type SaveLeftover } from "./atomic";
import { VaultNotFoundError, type VaultBackend } from "./types";

export const INTEGRITY_KINDS = [
  "truncated-utf8",
  "invalid-utf8",
  "utf16",
  "nul-bytes",
  "empty-file",
  "bad-data",
  "bad-frontmatter",
  "case-collision",
  "normalization-collision",
  "broken-link",
  "orphan-temp",
  "interrupted-write",
] as const;
export type IntegrityKind = (typeof INTEGRITY_KINDS)[number];

/** Kinds `repairVault` can fix. */
export const REPAIRABLE: ReadonlySet<IntegrityKind> = new Set<IntegrityKind>([
  "truncated-utf8",
  "invalid-utf8",
  "utf16",
  "nul-bytes",
  "case-collision",
  "normalization-collision",
  "orphan-temp",
  "interrupted-write",
]);

export interface IntegrityFinding {
  kind: IntegrityKind;
  /** The file (for a collision: the name that would be renamed; for interrupted-write: the missing note). */
  path: string;
  /** What exactly: the other name of a collision, the link, the parse error. */
  detail?: string;
}

export interface IntegrityReport {
  /** Files read (temporary files and backups excluded). */
  files: number;
  findings: IntegrityFinding[];
  /** How long the check took, in ms. */
  ms: number;
}

export interface CheckOptions {
  /** A YAML parser that throws on invalid input (default: the `yaml` package, loaded on first use). */
  parseYaml?: (text: string) => unknown;
  /** Folders not to look into, by name (default: .git, .lumen-repair, .trash, node_modules). */
  skipFolders?: ReadonlySet<string>;
  /**
   * Trust the last check's result for a file whose size and mtime have not
   * changed (and that did not change in the seconds before that check).
   * Default true; false reads every file.
   */
  reuse?: boolean;
}

export const BACKUP_FOLDER = ".lumen-repair";
const SKIP = new Set([".git", BACKUP_FOLDER, ".trash", "node_modules"]);
const TEXT = /\.(md|markdown|txt|canvas|excalidraw|base|json|ya?ml|csv)$/i;
const JSON_DATA = /\.(json|canvas|excalidraw)$/i;
const YAML_DATA = /\.(base|ya?ml)$/i;
const NOTE = /\.(md|markdown)$/i;

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * UTF-8 validity: "ok", "truncated" (only the last character is cut) or
 * "invalid" (bad bytes elsewhere). Overlong forms and surrogates are invalid,
 * as in TextDecoder's fatal mode.
 */
export function utf8Status(b: Uint8Array): "ok" | "truncated" | "invalid" {
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    if (c < 0x80) {
      i++;
      continue;
    }
    let n: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) n = 1;
    else if (c >= 0xe0 && c <= 0xef) {
      n = 2;
      if (c === 0xe0) lo = 0xa0;
      if (c === 0xed) hi = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      n = 3;
      if (c === 0xf0) lo = 0x90;
      if (c === 0xf4) hi = 0x8f;
    } else return "invalid";
    for (let k = 1; k <= n; k++) {
      if (i + k >= b.length) return "truncated";
      const x = b[i + k];
      if (x < (k === 1 ? lo : 0x80) || x > (k === 1 ? hi : 0xbf)) return "invalid";
    }
    i += n + 1;
  }
  return "ok";
}

/** The bytes without a cut last character. */
function dropCutTail(b: Uint8Array): Uint8Array {
  let end = b.length;
  // A cut character is at most 3 bytes: a lead byte and up to 2 continuations.
  for (let k = 1; k <= 3 && end - k >= 0; k++) {
    const c = b[end - k];
    if (c >= 0xc0) return b.subarray(0, end - k);
    if (c < 0x80) break;
  }
  return b;
}

const isUtf16 = (b: Uint8Array) => b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));

/** Front matter problems of a note's text, or null. */
function frontmatterProblem(text: string, parseYaml: (s: string) => unknown): string | null {
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const lines = text.split(/\r?\n/);
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  if (close < 0) return "never closed";
  try {
    const v = parseYaml(lines.slice(1, close).join("\n"));
    if (v !== null && v !== undefined && (typeof v !== "object" || Array.isArray(v))) return "not a list of key: value pairs";
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 120);
  }
  return null;
}

async function bytesOf(backend: VaultBackend, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await backend.read(path)).arrayBuffer());
}

/** What the check found in one file, kept for the next check while the file's size and mtime stay the same. */
interface FileResult {
  size: number;
  mtime: number;
  findings: IntegrityFinding[];
  /** A note's text, for the link check. */
  text?: string;
}

/** Results of the last check per backend (path → result); a file whose size and mtime did not change is not read again. */
const lastResults = new WeakMap<VaultBackend, Map<string, FileResult>>();
/** Note text kept for the next check, per backend (UTF-16 code units). Above it notes are read again. */
const KEEP_TEXT = 16 * 1024 * 1024;
/**
 * A file changed less than this long before the check started may change
 * again within the same mtime tick (FAT and some phone folders keep 2 s), so
 * it is read every time (git's "racily clean" rule).
 */
const MTIME_SLACK_MS = 3000;
/**
 * Reads in flight at once. The desktop and phone backends answer each read
 * over an IPC bridge, so several overlap. The browser backends read a Blob,
 * and Chromium serialises Blob reads: 8 at once took 1.7× as long as one at
 * a time for 10,000 notes (offline Chromium harness), so they read one by one.
 */
const readConcurrency = (backend: VaultBackend) => (backend.id === "desktop" || backend.id.startsWith("mobile") ? 4 : 1);

/** Run `task` over `items`, at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Check the whole vault. */
export async function checkVault(backend: VaultBackend, opts: CheckOptions = {}): Promise<IntegrityReport> {
  const started = Date.now();
  const skip = opts.skipFolders ?? SKIP;
  let parseYaml = opts.parseYaml;
  const yaml = async () => (parseYaml ??= ((await import("yaml")) as { parse: (s: string) => unknown }).parse);
  // A caller's own YAML parser may judge differently: its results are not kept.
  const reuse = opts.reuse !== false && !opts.parseYaml;
  const previous = reuse ? lastResults.get(backend) : undefined;
  const results = new Map<string, FileResult>();
  // In walk order: a finding of the listing itself, or a file to read and check.
  const slots: Array<IntegrityFinding | { file: string; name: string; size: number; mtime: number }> = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await backend.list(dir);
    const names = new Set(entries.map((e) => e.name));

    // Collisions: names one case-insensitive or normalising folder cannot hold apart.
    const groups = new Map<string, string[]>();
    for (const e of entries) {
      if (isTempName(e.name)) continue;
      const key = e.name.normalize("NFC").toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), e.name]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [first, ...rest] = [...group].sort();
      for (const other of rest) {
        const kind = other.normalize("NFC") === first.normalize("NFC") ? "normalization-collision" : "case-collision";
        slots.push({ kind, path: inDir(dir, other), detail: inDir(dir, first) });
      }
    }

    // Leftovers of interrupted saves; a short-named one's note is in its journal.
    const fileNames = entries.filter((e) => e.kind === "file").map((e) => e.name);
    const leftovers: Map<string, SaveLeftover> = fileNames.some((n) => parseLeftover(n))
      ? await leftoversOf(fileNames, (n) => bytesOf(backend, inDir(dir, n)))
      : new Map();
    // Notes whose save stopped between its steps: missing, with an old version there.
    const interrupted = new Set<string>();
    for (const l of leftovers.values()) if (l.kind === "old" && l.target !== null && !names.has(l.target)) interrupted.add(l.target);

    for (const e of entries) {
      if (e.kind === "directory") {
        if (!skip.has(e.name)) await walk(e.path);
        continue;
      }
      const leftover = leftovers.get(e.name);
      if (leftover?.target != null && interrupted.has(leftover.target)) {
        // The old version stands for the interrupted save; its temporary file and journal are part of it.
        if (leftover.kind === "old") slots.push({ kind: "interrupted-write", path: inDir(dir, leftover.target), detail: e.path });
        continue;
      }
      if (isTempName(e.name)) {
        slots.push({ kind: "orphan-temp", path: e.path });
        continue;
      }
      if (!TEXT.test(e.name)) continue;
      slots.push({ file: e.path, name: e.name, size: e.size ?? -1, mtime: e.mtime ?? 0 });
    }
  };
  await walk("");

  /** One file's findings, from its bytes. */
  const checkBytes = async (name: string, path: string, bytes: Uint8Array): Promise<Omit<FileResult, "size" | "mtime">> => {
    if (!bytes.length) return { findings: [{ kind: "empty-file", path }] };
    if (isUtf16(bytes)) return { findings: [{ kind: "utf16", path }] };
    const status = utf8Status(bytes);
    if (status !== "ok") return { findings: [{ kind: status === "truncated" ? "truncated-utf8" : "invalid-utf8", path }] };
    if (bytes.includes(0)) return { findings: [{ kind: "nul-bytes", path, detail: String(bytes.reduce((n, x) => n + (x === 0 ? 1 : 0), 0)) }] };
    const text = new TextDecoder().decode(bytes);
    if (JSON_DATA.test(name)) {
      try {
        JSON.parse(text);
      } catch (err) {
        return { findings: [{ kind: "bad-data", path, detail: (err as Error).message.slice(0, 120) }] };
      }
    } else if (YAML_DATA.test(name)) {
      try {
        (await yaml())(text);
      } catch (err) {
        return { findings: [{ kind: "bad-data", path, detail: (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 120) }] };
      }
    } else if (NOTE.test(name)) {
      const problem = text.startsWith("---") ? frontmatterProblem(text, await yaml()) : null;
      return { findings: problem ? [{ kind: "bad-frontmatter", path, detail: problem }] : [], text };
    }
    return { findings: [] };
  };

  // Read the files, several at a time; one that did not change since the last check is not read again.
  const toRead: Array<{ file: string; name: string; size: number; mtime: number }> = [];
  for (const slot of slots) {
    if (!("file" in slot)) continue;
    const before = previous?.get(slot.file);
    if (before && slot.mtime > 0 && before.size === slot.size && before.mtime === slot.mtime && slot.mtime < started - MTIME_SLACK_MS) results.set(slot.file, before);
    else toRead.push(slot);
  }
  await pool(toRead, readConcurrency(backend), async (slot) => {
    let bytes: Uint8Array;
    try {
      bytes = await bytesOf(backend, slot.file);
    } catch (err) {
      if (err instanceof VaultNotFoundError) return; // removed meanwhile
      throw err;
    }
    // The listing's size and mtime describe these bytes only when the size still matches.
    const mtime = bytes.byteLength === slot.size ? slot.mtime : 0;
    results.set(slot.file, { size: bytes.byteLength, mtime, ...(await checkBytes(slot.name, slot.file, bytes)) });
  });

  const findings: IntegrityFinding[] = [];
  const notes: Array<{ path: string; text: string }> = [];
  let files = 0;
  for (const slot of slots) {
    if (!("file" in slot)) {
      findings.push(slot);
      continue;
    }
    const r = results.get(slot.file);
    if (!r) continue;
    files++;
    findings.push(...r.findings);
    if (r.text !== undefined) notes.push({ path: slot.file, text: r.text });
  }

  if (reuse) {
    // Keep what the next check can trust: files with a known mtime, notes only while their text fits.
    const keep = new Map<string, FileResult>();
    let kept = 0;
    for (const [path, r] of results) {
      if (r.mtime <= 0) continue;
      if (r.text !== undefined) {
        if (kept + r.text.length > KEEP_TEXT) continue;
        kept += r.text.length;
      }
      keep.set(path, r);
    }
    lastResults.set(backend, keep);
  }

  if (notes.length) {
    const { runVaultDoctor } = await import("../../lint/vaultDoctor");
    for (const f of runVaultDoctor(notes, { skipDuplicates: true })) {
      if (f.kind === "broken-wiki-link" || f.kind === "broken-md-link") {
        findings.push({ kind: "broken-link", path: f.path, detail: f.kind === "broken-wiki-link" ? `[[${f.detail ?? ""}]]` : (f.detail ?? "") });
      }
    }
  }
  return { files, findings, ms: Date.now() - started };
}

/** Windows-1255 (Hebrew) → text, when the platform has the decoder; else null. */
function decodeLegacy(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("windows-1255", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** A free name next to `path`: "name (2).md", "name (3).md"… */
async function freeName(backend: VaultBackend, path: string): Promise<string> {
  const dir = dirOf(path);
  const base = baseOf(path);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  const taken = new Set((await backend.list(dir)).map((e) => e.name.normalize("NFC").toLowerCase()));
  for (let n = 2; ; n++) {
    const name = `${stem} (${n})${ext}`;
    if (!taken.has(name.normalize("NFC").toLowerCase())) return inDir(dir, name);
  }
}

/** The atomic-save steps over a vault backend, for finishing interrupted saves. */
function backendFs(backend: VaultBackend): AtomicFs {
  return {
    readdir: async (dir) => (await backend.list(dir)).map((e) => ({ name: e.name, type: e.kind })),
    exists: async (p) => (await backend.stat(p)) !== null,
    writeFile: (p, data) => backend.write(p, data),
    size: async (p) => (await backend.stat(p))?.size ?? null,
    rename: (a, b) => backend.rename(a, b),
    remove: (p) => backend.remove(p),
    readFile: (p) => bytesOf(backend, p),
  };
}

export interface RepairResult {
  /** Findings repaired. */
  repaired: IntegrityFinding[];
  /** Findings that were not (not repairable, or the file changed since the check). */
  skipped: IntegrityFinding[];
  /** Where the copies of the changed files are (null when nothing was changed). */
  backup: string | null;
}

/**
 * Repair the repairable `findings`. Every file is copied to the backup
 * folder before it is changed, renamed or removed; a file that no longer
 * shows the problem is left alone.
 */
export async function repairVault(backend: VaultBackend, findings: readonly IntegrityFinding[], opts: { stamp?: string } = {}): Promise<RepairResult> {
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = `${BACKUP_FOLDER}/${stamp}`;
  const repaired: IntegrityFinding[] = [];
  const skipped: IntegrityFinding[] = [];
  let backedUp = false;
  const backup = async (path: string) => {
    const bytes = await bytesOf(backend, path);
    await backend.write(`${backupDir}/${path}`, bytes);
    backedUp = true;
    return bytes;
  };
  const finishedDirs = new Set<string>();

  for (const f of findings) {
    if (!REPAIRABLE.has(f.kind)) {
      skipped.push(f);
      continue;
    }
    try {
      let done = false;
      switch (f.kind) {
        case "truncated-utf8":
        case "invalid-utf8":
        case "utf16":
        case "nul-bytes": {
          const now = await bytesOf(backend, f.path);
          let text: string | null = null;
          if (f.kind === "truncated-utf8" && utf8Status(now) === "truncated") {
            const cut = dropCutTail(now);
            if (utf8Status(cut) === "ok") text = new TextDecoder().decode(cut);
          } else if (f.kind === "invalid-utf8" && utf8Status(now) === "invalid") {
            text = decodeLegacy(now);
          } else if (f.kind === "utf16" && isUtf16(now)) {
            text = new TextDecoder(now[0] === 0xff ? "utf-16le" : "utf-16be").decode(now.subarray(2));
          } else if (f.kind === "nul-bytes" && now.includes(0) && utf8Status(now) === "ok") {
            text = new TextDecoder().decode(now.filter((x) => x !== 0));
          }
          if (text === null) break;
          await backup(f.path);
          await backend.write(f.path, text);
          done = true;
          break;
        }
        case "case-collision":
        case "normalization-collision": {
          if (!(await backend.stat(f.path))) break;
          if ((await backend.stat(f.path))?.kind === "file") await backup(f.path);
          await backend.rename(f.path, await freeName(backend, f.path));
          done = true;
          break;
        }
        case "orphan-temp": {
          const s = await backend.stat(f.path);
          if (!s) break;
          if (s.kind === "file") await backup(f.path);
          await backend.remove(f.path);
          done = true;
          break;
        }
        case "interrupted-write": {
          const dir = dirOf(f.path);
          if (finishedDirs.has(dir)) {
            done = (await backend.stat(f.path)) !== null;
            break;
          }
          for (const e of await backend.list(dir)) {
            const l = parseLeftover(e.name);
            if (l && e.kind === "file") await backup(e.path);
          }
          await recoverDir(backendFs(backend), dir);
          finishedDirs.add(dir);
          done = (await backend.stat(f.path)) !== null;
          break;
        }
        default:
          break;
      }
      (done ? repaired : skipped).push(f);
    } catch {
      skipped.push(f);
    }
  }
  return { repaired, skipped, backup: backedUp ? backupDir : null };
}
