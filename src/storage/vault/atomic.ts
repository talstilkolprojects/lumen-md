/**
 * Atomic saves (plan W1.5): a save either lands whole or not at all.
 *
 * A note is never written in place. The new bytes go to a hidden sibling,
 * and only once they are all there does the sibling take the note's name:
 *
 *   1. write   `.lumen-tmp~<name>~<id>`            (the new version, complete)
 *   2. rename  `<name>` → `.lumen-old~<name>~<id>`  (only when it existed)
 *   3. rename  `.lumen-tmp~…` → `<name>`
 *   4. remove  `.lumen-old~…`
 *
 * A file name holds at most 255 bytes on every file system the app writes
 * to (ext4, f2fs, APFS, exFAT; OPFS in WebKit). When the names above would
 * be longer — a long Hebrew title takes two bytes a letter — the save uses
 * short names instead, `.lumen-tmp-<16 hex>` and `.lumen-old-<16 hex>`, and
 * first writes a journal `.lumen-jnl-<16 hex>` that holds the note's name.
 * The journal is removed last, so every leftover of such a save can be
 * traced back to its note; a leftover whose journal cannot be read is never
 * used to replace a note (its old version is kept for the integrity check).
 *
 * A crash (power loss, the app killed) can stop this anywhere. Whatever is on
 * disk afterwards, `recoverDir` turns it back into "the old version or the
 * new one, whole":
 *
 *   - a temporary file with the note still in place: the save never got to
 *     step 2, so the note is the old version and the temporary file goes;
 *   - an `.lumen-old~` file with the note missing: the crash fell between
 *     steps 2 and 3; the temporary file is complete (step 2 only starts
 *     after step 1 finished), so it takes the name — or, if it is gone too,
 *     the old version comes back;
 *   - an `.lumen-old~` file with the note in place: step 4 did not run; it goes.
 *
 * Platforms with an atomic replace do not need the dance: the desktop app
 * writes a temporary file, fsyncs it and renames it over the note in Rust
 * (src-tauri/vault), and Chromium's `createWritable()` writes a swap file
 * that replaces the file on `close()`. The phone folders (Capacitor
 * Filesystem, Android's Storage Access Framework) and the OPFS write worker
 * for Safari have no such call, so they use the steps above. The vault
 * integrity check (./integrity.ts) reports and cleans up anything left over.
 *
 * This module imports nothing at runtime, so the crash test can load it in
 * a plain Node child process (scripts/vault-crash-test.mjs).
 */

/** The few calls the steps above need, over paths relative to the vault folder. */
export interface AtomicFs {
  /** Names in folder `dir` ("" = the root); files and folders. */
  readdir(dir: string): Promise<Array<{ name: string; type: "file" | "directory" }>>;
  /** Is something at `path`? */
  exists(path: string): Promise<boolean>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Size of the file at `path`, or null when it is not there. */
  size(path: string): Promise<number | null>;
  /** Move `from` to `to`; nothing is at `to`. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /**
   * The bytes of the file at `path`. Recovery reads the journal of a save
   * that used short names with it; without it such leftovers are kept as
   * they are (the integrity check reports them).
   */
  readFile?(path: string): Promise<Uint8Array>;
}

const TMP_PREFIX = ".lumen-tmp~";
const OLD_PREFIX = ".lumen-old~";
/** The short names of a save whose long names would not fit (see the module comment). */
const SHORT = /^\.lumen-(tmp|old|jnl)-([0-9a-f]{16})$/;
/** Bytes a file name may hold (one path component, UTF-8). */
export const NAME_MAX = 255;
const JOURNAL_HEAD = /^lumen-save 1 (\d{1,3})\n/;

/**
 * Names of temporary files other writers leave behind when they are stopped
 * half way: the desktop app's (`.lumen-tmp-<pid>-<n>`), a folder rename's
 * staging name (`.lumen-rename-…`), and Chromium's swap files (`*.crswap`).
 */
const FOREIGN_TEMP = [/^\.lumen-tmp-\d+-\d+$/, /^\.lumen-rename-[0-9a-z]+$/, /\.crswap$/];

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

const utf8Length = (s: string) => new TextEncoder().encode(s).byteLength;

let counter = 0;
/**
 * An id no other save running now shares: 16 hex digits (the time in ms,
 * a counter and two random digits), so later saves sort after earlier ones.
 */
export function saveId(): string {
  counter = (counter + 1) % 0x1000;
  const random = Math.floor(Math.random() * 0x100);
  return Date.now().toString(16).padStart(11, "0").slice(-11) + counter.toString(16).padStart(3, "0") + random.toString(16).padStart(2, "0");
}

/** The 16 hex digits of the short names: the id itself when it is a `saveId()`, else a hash of it. */
export function shortKey(id: string): string {
  if (/^[0-9a-f]{16}$/.test(id)) return id;
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** Do the long names of a save of `name` (`.lumen-tmp~<name>~<id>`) fit in a file name? Both prefixes have the same length. */
const fitsLong = (name: string, id: string) => utf8Length(`${TMP_PREFIX}${name}~${id}`) <= NAME_MAX;

export const tempNameFor = (name: string, id: string) => (fitsLong(name, id) ? `${TMP_PREFIX}${name}~${id}` : `.lumen-tmp-${shortKey(id)}`);
export const oldNameFor = (name: string, id: string) => (fitsLong(name, id) ? `${OLD_PREFIX}${name}~${id}` : `.lumen-old-${shortKey(id)}`);
/** The journal of a save of `name`, or null when its long names fit and it needs none. */
export const journalNameFor = (name: string, id: string) => (fitsLong(name, id) ? null : `.lumen-jnl-${shortKey(id)}`);

/** The journal's bytes: a header line with the name's length in bytes (so a cut journal shows), then the note's name. */
export const journalBytes = (name: string) => new TextEncoder().encode(`lumen-save 1 ${utf8Length(name)}\n${name}`);

/** The note a journal names, or null when it is not a whole, valid journal. */
export function journalTarget(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const head = JOURNAL_HEAD.exec(text);
  if (!head) return null;
  const name = text.slice(head[0].length);
  if (utf8Length(name) !== Number(head[1])) return null;
  if (!name || name === "." || name === ".." || /[/\0]/.test(name) || utf8Length(name) > NAME_MAX || parseLeftover(name)) return null;
  return name;
}

/** A leftover of an atomic save: which note it belongs to, and which step it is. */
export interface SaveLeftover {
  /** "jnl": the journal of a save with short names. */
  kind: "tmp" | "old" | "jnl";
  /**
   * The note's name (in the same folder). null for a short name, whose note
   * only its journal knows (see `leftoversOf`).
   */
  target: string | null;
  id: string;
}

/** `.lumen-tmp~<name>~<id>` / `.lumen-old~<name>~<id>` / `.lumen-(tmp|old|jnl)-<16 hex>` → its parts; null for any other name. */
export function parseLeftover(name: string): SaveLeftover | null {
  const short = SHORT.exec(name);
  if (short) return { kind: short[1] as SaveLeftover["kind"], target: null, id: short[2] };
  const kind = name.startsWith(TMP_PREFIX) ? "tmp" : name.startsWith(OLD_PREFIX) ? "old" : null;
  if (!kind) return null;
  const rest = name.slice(TMP_PREFIX.length); // both prefixes have the same length
  const cut = rest.lastIndexOf("~");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { kind, target: rest.slice(0, cut), id: rest.slice(cut + 1) };
}

/**
 * The leftovers in folder listing `names` (name → leftover), with the note of
 * each short-named one taken from its save's journal, read with `read`
 * (a name in the same folder). It stays null when there is no whole journal.
 */
export async function leftoversOf(names: Iterable<string>, read?: (name: string) => Promise<Uint8Array>): Promise<Map<string, SaveLeftover>> {
  const out = new Map<string, SaveLeftover>();
  for (const n of names) {
    const l = parseLeftover(n);
    if (l) out.set(n, l);
  }
  const journals = new Map<string, string | null>();
  for (const [n, l] of out) {
    if (l.kind !== "jnl") continue;
    let target: string | null = null;
    if (read) {
      try {
        target = journalTarget(await read(n));
      } catch {
        target = null;
      }
    }
    journals.set(l.id, target);
  }
  for (const [n, l] of out) if (l.target === null) out.set(n, { ...l, target: journals.get(l.id) ?? null });
  return out;
}

/** Is `name` a temporary file of an interrupted save (ours or another writer's)? */
export function isTempName(name: string): boolean {
  return parseLeftover(name) !== null || FOREIGN_TEMP.some((re) => re.test(name));
}

/**
 * Save `data` at `path` with the four steps above. The temporary file is
 * checked for its full size before it takes the note's name, so a write the
 * platform cut short never replaces a good note.
 */
export async function atomicWrite(fs: AtomicFs, path: string, data: Uint8Array, id: string = saveId()): Promise<void> {
  const dir = dirOf(path);
  const name = baseOf(path);
  const tmp = inDir(dir, tempNameFor(name, id));
  const journalName = journalNameFor(name, id);
  const journal = journalName === null ? null : inDir(dir, journalName);
  // The journal goes last: while any other file of this save is left, it says whose it is.
  const dropJournal = async () => {
    if (journal) await fs.remove(journal).catch(() => undefined);
  };
  if (journal) {
    const bytes = journalBytes(name);
    try {
      await fs.writeFile(journal, bytes);
      if ((await fs.size(journal)) !== bytes.byteLength) throw new Error(`Saving "${path}" was cut short (its journal).`);
    } catch (e) {
      await dropJournal();
      throw e;
    }
  }
  try {
    await fs.writeFile(tmp, data);
    const written = await fs.size(tmp);
    if (written !== data.byteLength) throw new Error(`Saving "${path}" was cut short (${written ?? 0} of ${data.byteLength} bytes).`);
  } catch (e) {
    await fs.remove(tmp).catch(() => undefined);
    await dropJournal();
    throw e;
  }
  if (await fs.exists(path)) {
    const old = inDir(dir, oldNameFor(name, id));
    await fs.rename(path, old);
    try {
      await fs.rename(tmp, path);
    } catch (e) {
      // Put the old version back under its name; the new one stays in the
      // temporary file only until the next recovery removes it.
      const back = await fs.rename(old, path).then(
        () => true,
        () => false,
      );
      await fs.remove(tmp).catch(() => undefined);
      if (back) await dropJournal();
      throw e;
    }
    const gone = await fs.remove(old).then(
      () => true,
      () => false,
    );
    if (gone) await dropJournal();
  } else {
    await fs.rename(tmp, path);
    await dropJournal();
  }
}

/** What `recoverDir` did, per note. */
export interface RecoveryAction {
  /** The note, relative to the vault root. */
  path: string;
  /** "promoted": the new version took the name; "restored": the old one came back; "cleaned": only leftovers were removed. */
  action: "promoted" | "restored" | "cleaned";
}

/**
 * Finish or undo the interrupted saves in folder `dir` (see the module
 * comment). Never touches a note that is in place, except to remove its
 * leftovers. `names` is the folder's listing, when the caller has it;
 * `busy` holds the ids of saves still running in this process, whose files
 * are not leftovers yet.
 */
export async function recoverDir(fs: AtomicFs, dir: string, opts: { names?: string[]; busy?: ReadonlySet<string> } = {}): Promise<RecoveryAction[]> {
  const listing = opts.names ?? (await fs.readdir(dir)).map((e) => e.name);
  const present = new Set(listing);
  const busy = new Set([...(opts.busy ?? [])].flatMap((id) => [id, shortKey(id)]));
  const live = listing.filter((n) => {
    const l = parseLeftover(n);
    return l !== null && !busy.has(l.id);
  });
  const read = fs.readFile ? fs.readFile.bind(fs) : undefined;
  const leftovers = await leftoversOf(live, read ? (n) => read(inDir(dir, n)) : undefined);
  type Group = { tmp: string[]; old: string[]; jnl: string[] };
  const byTarget = new Map<string, Group>();
  // Short names whose journal is missing or unreadable, by save.
  const unknown = new Map<string, Group>();
  for (const [n, l] of leftovers) {
    const groups = l.target === null ? unknown : byTarget;
    const key = l.target ?? l.id;
    const entry = groups.get(key) ?? { tmp: [], old: [], jnl: [] };
    entry[l.kind].push(n);
    groups.set(key, entry);
  }
  const removeAll = async (names: string[]) => {
    for (const n of names) {
      const p = inDir(dir, n);
      if (await fs.exists(p)) await fs.remove(p);
    }
  };
  const out: RecoveryAction[] = [];
  for (const [target, { tmp, old, jnl }] of byTarget) {
    const path = inDir(dir, target);
    let action: RecoveryAction["action"] = "cleaned";
    if (!present.has(target) && old.length) {
      // Between steps 2 and 3: the temporary file of the same save is complete.
      const ids = new Set(old.map((n) => leftovers.get(n)!.id));
      const complete = tmp.filter((n) => ids.has(leftovers.get(n)!.id)).sort();
      const pick = complete[complete.length - 1];
      if (pick) {
        await fs.rename(inDir(dir, pick), path);
        action = "promoted";
      } else {
        await fs.rename(inDir(dir, old.sort()[old.length - 1]), path);
        action = "restored";
      }
    }
    await removeAll([...tmp, ...old]);
    await removeAll(jnl);
    out.push({ path, action });
  }
  // Fail closed: without its journal nothing says which note an old version
  // belongs to, so it stays (the integrity check reports it). A temporary
  // file of such a save never replaced anything and can go.
  for (const { tmp, old, jnl } of unknown.values()) {
    if (old.length) continue;
    await removeAll(tmp);
    await removeAll(jnl);
  }
  return out;
}

/** Does folder listing `names` hold the leftovers of an interrupted save? */
export function hasLeftovers(names: Iterable<string>): boolean {
  for (const n of names) if (parseLeftover(n)) return true;
  return false;
}

/** What the directory-handle backend lends `recoverHandleDir` (its own internals, so nothing here touches handles). */
export interface HandleOps<F> {
  lookup(parts: string[]): Promise<F | null>;
  move(src: string[], dst: string[], source: F, target: null): Promise<void>;
  removeAt(parts: string[], path: string): Promise<void>;
  writeAt(parts: string[], data: Uint8Array, path: string): Promise<void>;
  segments(path: string): string[];
  /** Size of a file entry; null for a folder. */
  fileSize(found: F): Promise<number | null>;
  /** The bytes of a file entry (a save's journal). */
  fileBytes?(found: F): Promise<Uint8Array>;
}

/** `recoverDir` over a directory-handle backend (the OPFS write worker's leftovers); loaded only when there are some. */
export async function recoverHandleDir<F>(o: HandleOps<F>, dir: string, names: string[]): Promise<void> {
  await recoverDir(
    {
      readdir: async () => names.map((name) => ({ name, type: "file" as const })),
      exists: async (p) => (await o.lookup(o.segments(p))) !== null,
      writeFile: (p, data) => o.writeAt(o.segments(p), data, p),
      size: async (p) => {
        const f = await o.lookup(o.segments(p));
        return f === null ? null : o.fileSize(f);
      },
      rename: async (from, to) => {
        const f = await o.lookup(o.segments(from));
        if (!f) throw new Error(`"${from}" not found`);
        await o.move(o.segments(from), o.segments(to), f, null);
      },
      remove: (p) => o.removeAt(o.segments(p), p),
      readFile: async (p) => {
        const f = await o.lookup(o.segments(p));
        if (!f || !o.fileBytes) throw new Error(`"${p}" cannot be read`);
        return o.fileBytes(f);
      },
    },
    dir,
    { names },
  );
}
