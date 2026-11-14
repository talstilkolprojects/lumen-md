/**
 * Stand-ins for the phone's native file APIs (plan 4.20): the Capacitor
 * Filesystem plugin (iOS Documents / Android app folder) and Lumen's Android
 * Storage Access Framework plugin (android/app/src/main/java/com/lumen/editor/LumenVaultFolderPlugin.java).
 * Same method names, arguments and shapes (base64 data, `{ files }`
 * listings, "does not exist" rejections), over an in-memory tree that keeps
 * no vault rules of its own — those are the backend's job.
 */
import type { CapacitorFilesystemPlugin, LumenVaultFolderPlugin, MobileBridge, MobileEntry } from "../../storage/vault/mobile";
import { fromBase64, toBase64 } from "../../storage/vault/mobile";

type Node = { type: "file"; data: Uint8Array; mtime: number } | { type: "directory"; children: Map<string, Node> };

/** A folder on the phone. `edit` changes a file the way another app would. */
export class FakePhoneFolder {
  root: Node = { type: "directory", children: new Map() };
  private clock = 0;
  /** Real time, but strictly increasing: two writes never share an mtime. */
  now = () => (this.clock = Math.max(Date.now(), this.clock + 1));

  private parts = (path: string) => path.split("/").filter(Boolean);

  node(path: string): Node | null {
    let cur: Node = this.root;
    for (const p of this.parts(path)) {
      if (cur.type !== "directory") return null;
      const next = cur.children.get(p);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  private dir(path: string, create: boolean): Map<string, Node> {
    let cur: Node = this.root;
    for (const p of this.parts(path)) {
      if (cur.type !== "directory") throw new Error(`Parent is a file: ${path}`);
      let next = cur.children.get(p);
      if (!next) {
        if (!create) throw new Error(`Directory does not exist: ${path}`);
        next = { type: "directory", children: new Map() };
        cur.children.set(p, next);
      }
      cur = next;
    }
    if (cur.type !== "directory") throw new Error(`Not a directory: ${path}`);
    return cur.children;
  }

  readdir(path: string): MobileEntry[] {
    const n = this.node(path);
    if (!n || n.type !== "directory") throw new Error(`Directory does not exist: ${path}`);
    return [...n.children].map(([name, c]): MobileEntry => (c.type === "file" ? { name, type: "file", size: c.data.byteLength, mtime: c.mtime } : { name, type: "directory", size: 0, mtime: 0 }));
  }

  stat(path: string): Omit<MobileEntry, "name"> {
    const n = this.node(path);
    if (!n) throw new Error(`File does not exist: ${path}`);
    return n.type === "file" ? { type: "file", size: n.data.byteLength, mtime: n.mtime } : { type: "directory", size: 0, mtime: 0 };
  }

  read(path: string): Uint8Array {
    const n = this.node(path);
    if (!n || n.type !== "file") throw new Error(`File does not exist: ${path}`);
    return n.data.slice();
  }

  write(path: string, data: Uint8Array): void {
    const parts = this.parts(path);
    const dir = this.dir(parts.slice(0, -1).join("/"), true);
    if (dir.get(parts[parts.length - 1])?.type === "directory") throw new Error(`Is a directory: ${path}`);
    dir.set(parts[parts.length - 1], { type: "file", data: data.slice(), mtime: this.now() });
  }

  mkdir(path: string): void {
    this.dir(path, true);
  }

  rename(from: string, to: string): void {
    const a = this.parts(from);
    const b = this.parts(to);
    const src = this.dir(a.slice(0, -1).join("/"), false);
    const n = src.get(a[a.length - 1]);
    if (!n) throw new Error(`File does not exist: ${from}`);
    const dst = this.dir(b.slice(0, -1).join("/"), true);
    src.delete(a[a.length - 1]);
    dst.set(b[b.length - 1], n);
  }

  remove(path: string): void {
    const a = this.parts(path);
    const dir = this.dir(a.slice(0, -1).join("/"), false);
    if (!dir.delete(a[a.length - 1])) throw new Error(`File does not exist: ${path}`);
  }

  /** Another app (the Files app, an editor) writes the file. */
  edit(path: string, text: string): void {
    this.write(path, new TextEncoder().encode(text));
  }

  text(path: string): string {
    return new TextDecoder().decode(this.read(path));
  }
}

const wrap = async <T,>(f: () => T): Promise<T> => f();

/** @capacitor/filesystem over one folder per `directory` ("DOCUMENTS", "EXTERNAL"…). */
export function fakeCapacitorFilesystem(): { plugin: CapacitorFilesystemPlugin; folders: Map<string, FakePhoneFolder>; folder(dir: string): FakePhoneFolder } {
  const folders = new Map<string, FakePhoneFolder>();
  const folder = (d: string) => {
    let f = folders.get(d);
    if (!f) folders.set(d, (f = new FakePhoneFolder()));
    return f;
  };
  const plugin: CapacitorFilesystemPlugin = {
    readdir: (o) => wrap(() => ({ files: folder(o.directory).readdir(o.path) })),
    stat: (o) => wrap(() => folder(o.directory).stat(o.path)),
    readFile: (o) => wrap(() => ({ data: toBase64(folder(o.directory).read(o.path)) })),
    writeFile: (o) => wrap(() => folder(o.directory).write(o.path, fromBase64(o.data))),
    mkdir: (o) => wrap(() => folder(o.directory).mkdir(o.path)),
    rename: (o) => wrap(() => folder(o.directory).rename(o.from, o.to)),
    deleteFile: (o) =>
      wrap(() => {
        if (folder(o.directory).stat(o.path).type !== "file") throw new Error("Not a file");
        folder(o.directory).remove(o.path);
      }),
    rmdir: (o) => wrap(() => folder(o.directory).remove(o.path)),
  };
  return { plugin, folders, folder };
}

/** Lumen's Android SAF plugin, with the "picker" answering `nextPick`. */
export function fakeSafPlugin(): { plugin: LumenVaultFolderPlugin; trees: Map<string, FakePhoneFolder>; tree(uri: string): FakePhoneFolder; nextPick: { uri: string | null; name: string }; granted: Set<string> } {
  const trees = new Map<string, FakePhoneFolder>();
  const tree = (u: string) => {
    let f = trees.get(u);
    if (!f) trees.set(u, (f = new FakePhoneFolder()));
    return f;
  };
  const self = {
    trees,
    tree,
    nextPick: { uri: "content://com.android.externalstorage.documents/tree/primary%3ANotes" as string | null, name: "Notes" },
    granted: new Set<string>(),
    plugin: {} as LumenVaultFolderPlugin,
  };
  const guard = (uri: string) => {
    if (!self.granted.has(uri)) throw new Error("Permission Denial");
    return tree(uri);
  };
  self.plugin = {
    pickFolder: async () => {
      if (self.nextPick.uri) self.granted.add(self.nextPick.uri);
      return { ...self.nextPick };
    },
    hasAccess: async (o) => ({ granted: self.granted.has(o.uri) }),
    readdir: (o) => wrap(() => ({ files: guard(o.uri).readdir(o.path) })),
    stat: (o) =>
      wrap(() => {
        const n = guard(o.uri).node(o.path);
        return n ? { exists: true, ...guard(o.uri).stat(o.path) } : { exists: false };
      }),
    readFile: (o) => wrap(() => ({ data: toBase64(guard(o.uri).read(o.path)) })),
    writeFile: (o) => wrap(() => guard(o.uri).write(o.path, fromBase64(o.data))),
    mkdir: (o) => wrap(() => guard(o.uri).mkdir(o.path)),
    rename: (o) => wrap(() => guard(o.uri).rename(o.from, o.to)),
    remove: (o) => wrap(() => guard(o.uri).remove(o.path)),
  };
  return self;
}

export function fakeBridge(platform: "ios" | "android", opts: { filesystem?: boolean; folder?: boolean } = {}) {
  const fs = fakeCapacitorFilesystem();
  const saf = fakeSafPlugin();
  const bridge: MobileBridge = {
    platform,
    filesystem: opts.filesystem === false ? null : fs.plugin,
    folder: platform === "android" && opts.folder !== false ? saf.plugin : null,
  };
  return { bridge, fs, saf };
}
