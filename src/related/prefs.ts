/**
 * Where related notes and link hints are off (plan W2.2): a note with
 * `related: false` in its front matter, or any note under a folder the
 * user turned off (stored on this device).
 */
const KEY = "lumen.related.offFolders";

export function offFolders(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setFolderOff(folder: string, off: boolean): string[] {
  const f = folder.replace(/^\/+|\/+$/g, "");
  const list = offFolders().filter((x) => x !== f);
  if (off) list.push(f);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage denied: for this session only */
  }
  return list;
}

/** `related: false` (or `no` / `off`) in the note's front matter. */
export function noteOptsOut(text: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return !!fm && /^related\s*:\s*["']?(false|no|off)["']?\s*$/im.test(fm);
}

export function folderOff(path: string | null | undefined, folders: readonly string[] = offFolders()): boolean {
  if (!path) return false;
  return folders.some((f) => f === "" || path === f || path.startsWith(`${f}/`));
}

/** Off for this note: by its front matter or its folder. */
export function relatedOff(path: string | null | undefined, text: string, folders: readonly string[] = offFolders()): boolean {
  return noteOptsOut(text) || folderOff(path, folders);
}
