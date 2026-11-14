/**
 * In-memory Origin Private File System for unit tests: enough of
 * FileSystemDirectoryHandle / FileSystemFileHandle for the vault's
 * directory-handle backend (src/storage/vault/handleBackend.ts), which the
 * OPFS backend behind src/storage/workspace.ts is.
 */
class FakeFile {
  constructor(public name: string, public data: Blob = new Blob([""]), public lastModified = Date.now()) {}
}

class FakeFileHandle {
  readonly kind = "file";
  constructor(readonly name: string, private file: FakeFile) {}
  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof FakeFileHandle && other.file === this.file;
  }
  async getFile(): Promise<File> {
    return new File([this.file.data], this.name, { lastModified: this.file.lastModified });
  }
  async createWritable() {
    const chunks: BlobPart[] = [];
    return {
      write: async (d: BlobPart) => void chunks.push(d),
      close: async () => {
        this.file.data = new Blob(chunks);
        this.file.lastModified = Date.now();
      },
    };
  }
}

export class FakeDir {
  readonly kind = "directory";
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Map<string, FakeFile>();
  constructor(readonly name = "") {}
  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeDir> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts.create || this.files.has(name)) throw new DOMException(`${name} not found`, "NotFoundError");
      d = new FakeDir(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFileHandle> {
    let f = this.files.get(name);
    if (!f) {
      if (!opts.create || this.dirs.has(name)) throw new DOMException(`${name} not found`, "NotFoundError");
      f = new FakeFile(name);
      this.files.set(name, f);
    }
    return new FakeFileHandle(name, f);
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw new DOMException(`${name} not found`, "NotFoundError");
  }
  async *entries(): AsyncGenerator<[string, FakeDir | FakeFileHandle]> {
    for (const [n, d] of this.dirs) yield [n, d];
    for (const [n, f] of this.files) yield [n, new FakeFileHandle(n, f)];
  }
}

/** Install a fresh in-memory OPFS on `navigator.storage`; returns its root. */
export function installFakeOpfs(): FakeDir {
  const root = new FakeDir();
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { ...(navigator.storage ?? {}), getDirectory: async () => root },
  });
  return root;
}
