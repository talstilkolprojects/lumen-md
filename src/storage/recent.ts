import { get, set } from "idb-keyval";
import { readText } from "./textCodec";

const KEY = "lumen.recents.v1";
const MAX = 10;

export interface RecentFile {
  id: string;
  name: string;
  openedAt: number;
  /** FileSystemFileHandle is structured-cloneable into IndexedDB. */
  handle?: FileSystemFileHandle;
}

export async function getRecents(): Promise<RecentFile[]> {
  const raw = (await get(KEY)) as RecentFile[] | undefined;
  if (!Array.isArray(raw)) return [];
  return raw;
}

export async function pushRecent(entry: Omit<RecentFile, "id" | "openedAt"> & {
  id?: string;
}): Promise<void> {
  const id = entry.id ?? hashName(entry.name);
  const now = Date.now();
  const list = await getRecents();
  const filtered = list.filter((r) => r.id !== id);
  const next: RecentFile[] = [
    { id, name: entry.name, openedAt: now, handle: entry.handle },
    ...filtered,
  ].slice(0, MAX);
  await set(KEY, next);
}

export async function removeRecent(id: string): Promise<void> {
  const list = await getRecents();
  await set(
    KEY,
    list.filter((r) => r.id !== id),
  );
}

export async function reopenRecent(
  entry: RecentFile,
): Promise<{ name: string; content: string; handle?: FileSystemFileHandle } | null> {
  if (!entry.handle) return null;
  // We need to ask the user for permission again on each session.
  const handle = entry.handle;
  if (handle.queryPermission) {
    let state = await handle.queryPermission({ mode: "readwrite" });
    if (state !== "granted" && handle.requestPermission) {
      state = await handle.requestPermission({ mode: "readwrite" });
    }
    if (state !== "granted") return null;
  }
  try {
    const file = await handle.getFile();
    const content = await readText(file);
    return { name: file.name, content, handle };
  } catch {
    return null;
  }
}

export function hashName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return `${name}.${h}`;
}
