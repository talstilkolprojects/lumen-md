/**
 * Copy vault files into the git mirror (lightning-fs) before a commit
 * (plan 3.3), without ever forcing a shape change: where the mirror holds a
 * folder at a path the vault has as a file — or a file where the vault needs
 * a folder (a clone into an existing folder keeps the local shape) — that
 * path is skipped and reported, and neither side is deleted. The rest of the
 * commit goes ahead.
 *
 * A Git LFS pointer in the mirror is kept too (Codex P1 on #269): a pull
 * that met a pointer where the vault holds the real file left the file alone
 * (`lfsSkipped`); copying the real bytes over the pointer would commit the
 * whole object as an ordinary blob and undo the repository's LFS tracking.
 */
import { isLfsPointer } from "./gitMerge";

/** The part of a promise-based fs the mirror uses (lightning-fs, node's fs.promises). */
export interface MirrorFs {
  promises: {
    writeFile: (path: string, data: Uint8Array) => Promise<unknown>;
    readFile: (path: string) => Promise<Uint8Array | string>;
    mkdir: (path: string) => Promise<unknown>;
    stat: (path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>;
  };
}

async function kindAt(fs: MirrorFs, path: string): Promise<"file" | "directory" | null> {
  try {
    const st = await fs.promises.stat(path);
    return st.isDirectory() ? "directory" : "file";
  } catch {
    return null; // nothing there
  }
}

export interface MirrorWriteResult {
  /** Relative paths skipped because the mirror has the other shape there. */
  skipped: string[];
  /** Relative paths kept as the mirror's LFS pointer: the vault holds the real file, which is never committed as a blob. */
  lfsKept: string[];
}

/**
 * Write `files` (paths relative to the repository) under `dir`. Reports the
 * paths skipped because the mirror has the other shape there, and the LFS
 * pointers kept in place of the vault's real file.
 */
export async function writeIntoMirror(fs: MirrorFs, dir: string, files: Array<{ relative: string; bytes: Uint8Array }>): Promise<MirrorWriteResult> {
  const skipped: string[] = [];
  const lfsKept: string[] = [];
  outer: for (const { relative, bytes } of files) {
    const parts = relative.split("/");
    let cur = dir;
    for (const part of parts.slice(0, -1)) {
      cur += `/${part}`;
      const kind = await kindAt(fs, cur);
      if (kind === "file") {
        skipped.push(relative);
        continue outer;
      }
      if (kind === null) await fs.promises.mkdir(cur);
    }
    const full = `${dir}/${relative}`;
    const kind = await kindAt(fs, full);
    if (kind === "directory") {
      skipped.push(relative);
      continue;
    }
    if (kind === "file" && !isLfsPointer(bytes) && (await isPointerFile(fs, full))) {
      lfsKept.push(relative);
      continue;
    }
    await fs.promises.writeFile(full, bytes);
  }
  return { skipped, lfsKept };
}

async function isPointerFile(fs: MirrorFs, path: string): Promise<boolean> {
  try {
    const data = await fs.promises.readFile(path);
    return isLfsPointer(typeof data === "string" ? data : new Uint8Array(data));
  } catch {
    return false;
  }
}
