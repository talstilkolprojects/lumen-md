/**
 * Vitest global test setup.
 * Polyfills browser APIs that jsdom doesn't provide.
 */
import "fake-indexeddb/auto";

// jsdom doesn't implement scrollIntoView; CommandPalette uses it for keyboard nav.
if (typeof window !== "undefined" && typeof Element !== "undefined") {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {
      /* test stub */
    };
  }
}

// jsdom's window.localStorage exists but Zustand's persist middleware may
// look up `storage.setItem` as a free function. Wrap it in a minimal in-memory
// shim if it's missing to keep persisted-store tests stable across versions.
// Node 25 has its own Web Storage: without --localstorage-file its
// localStorage is unusable, and it shadows jsdom's. The shim is then a real
// Storage-like class, installed as the global Storage with sessionStorage too,
// so `vi.spyOn(Storage.prototype, "setItem")` reaches both, as in a browser
// (the "storage refuses to save" tests rely on it).
if (typeof window !== "undefined") {
  const ls = window.localStorage;
  if (!ls || typeof ls.setItem !== "function") {
    class MemoryStorage {
      #mem = new Map<string, string>();
      getItem(k: string): string | null {
        return this.#mem.get(String(k)) ?? null;
      }
      setItem(k: string, v: string): void {
        this.#mem.set(String(k), String(v));
      }
      removeItem(k: string): void {
        this.#mem.delete(String(k));
      }
      clear(): void {
        this.#mem.clear();
      }
      key(i: number): string | null {
        return Array.from(this.#mem.keys())[i] ?? null;
      }
      get length(): number {
        return this.#mem.size;
      }
    }
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    for (const target of new Set<object>([window, globalThis])) {
      try {
        Object.defineProperty(target, "Storage", { configurable: true, writable: true, value: MemoryStorage });
        Object.defineProperty(target, "localStorage", { configurable: true, value: local });
        Object.defineProperty(target, "sessionStorage", { configurable: true, value: session });
      } catch {
        // why: a non-configurable global (some Node builds) keeps its own; window still gets the shim
      }
    }
  }
}
