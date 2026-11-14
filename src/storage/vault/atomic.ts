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
}

const TMP_PREFIX = ".lumen-tmp~";
const OLD_PREFIX = ".lumen-old~";

/**
 * Names of temporary files other writers leave behind when they are stopped
 * half way: the desktop app's (`.lumen-tmp-<pid>-<n>`), a folder rename's
 * staging name (`.lumen-rename-…`), and Chromium's swap files (`*.crswap`).
 */
const FOREIGN_TEMP = [/^\.lumen-tmp-\d+-\d+$/, /^\.lumen-rename-[0-9a-z]+$/, /\.crswap$/];

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

let counter = 0;
/** A short id no other save running now shares. */
export function saveId(): string {
  counter = (counter + 1) % 0x10000;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const tempNameFor = (name: string, id: string) => `${TMP_PREFIX}${name}~${id}`;
export const oldNameFor = (name: string, id: string) => `${OLD_PREFIX}${name}~${id}`;

/** A leftover of an atomic save: which note it belongs to, and which step it is. */
export interface SaveLeftover {
  kind: "tmp" | "old";
  /** The note's name (in the same folder). */
  target: string;
  id: string;
}

/** `.lumen-tmp~<name>~<id>` / `.lumen-old~<name>~<id>` → its parts; null for any other name. */
export function parseLeftover(name: string): SaveLeftover | null {
  const kind = name.startsWith(TMP_PREFIX) ? "tmp" : name.startsWith(OLD_PREFIX) ? "old" : null;
  if (!kind) return null;
  const rest = name.slice(TMP_PREFIX.length); // both prefixes have the same length
  const cut = rest.lastIndexOf("~");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { kind, target: rest.slice(0, cut), id: rest.slice(cut + 1) };
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
  try {
    await fs.writeFile(tmp, data);
    const written = await fs.size(tmp);
    if (written !== data.byteLength) throw new Error(`Saving "${path}" was cut short (${written ?? 0} of ${data.byteLength} bytes).`);
  } catch (e) {
    await fs.remove(tmp).catch(() => undefined);
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
      await fs.rename(old, path).catch(() => undefined);
      await fs.remove(tmp).catch(() => undefined);
      throw e;
    }
    await fs.remove(old).catch(() => undefined);
  } else {
    await fs.rename(tmp, path);
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
  const byTarget = new Map<string, { tmp: string[]; old: string[] }>();
  for (const n of listing) {
    const l = parseLeftover(n);
    if (!l || opts.busy?.has(l.id)) continue;
    const entry = byTarget.get(l.target) ?? { tmp: [], old: [] };
    entry[l.kind].push(n);
    byTarget.set(l.target, entry);
  }
  const out: RecoveryAction[] = [];
  for (const [target, { tmp, old }] of byTarget) {
    const path = inDir(dir, target);
    let action: RecoveryAction["action"] = "cleaned";
    if (!present.has(target) && old.length) {
      // Between steps 2 and 3: the temporary file of the same save is complete.
      const ids = new Set(old.map((n) => parseLeftover(n)!.id));
      const complete = tmp.filter((n) => ids.has(parseLeftover(n)!.id)).sort();
      const pick = complete[complete.length - 1];
      if (pick) {
        await fs.rename(inDir(dir, pick), path);
        action = "promoted";
      } else {
        await fs.rename(inDir(dir, old.sort()[old.length - 1]), path);
        action = "restored";
      }
    }
    for (const n of [...tmp, ...old]) {
      const p = inDir(dir, n);
      if (await fs.exists(p)) await fs.remove(p);
    }
    out.push({ path, action });
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
    },
    dir,
    { names },
  );
}
