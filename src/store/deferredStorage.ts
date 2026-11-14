/**
 * localStorage for the persisted app state, written later when it is big
 * (plan 8.4).
 *
 * The open document is part of the persisted state, so with a 2 MB note
 * every keystroke used to serialise megabytes into localStorage on the
 * main thread (and could throw QuotaExceededError right in the keystroke).
 * Small states are still written at once, exactly as before; a big one is
 * written once typing pauses for `delayMs`, and at the latest when the page
 * is hidden or unloads. Reads see the pending value, so nothing is lost
 * between the two.
 */

import type { PersistStorage, StorageValue } from "zustand/middleware";
import { log } from "../lib/logger";

/**
 * Like zustand's `createJSONStorage(() => localStorage)` — undefined when
 * localStorage cannot be reached (a sandboxed frame), so the store simply
 * does not persist — but `isLarge` values are written later.
 */
export function deferredJSONStorage<S>(
  isLarge: (value: StorageValue<S>) => boolean,
  opts: { delayMs?: number; storage?: () => Storage } = {},
): PersistStorage<S> | undefined {
  const delayMs = opts.delayMs ?? 1000;
  let store: Storage;
  try {
    store = (opts.storage ?? (() => localStorage))();
  } catch {
    return undefined;
  }
  const storage = () => store;
  let pending: { name: string; value: StorageValue<S> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hooked = false;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const p = pending;
    pending = null;
    if (!p) return;
    try {
      storage().setItem(p.name, JSON.stringify(p.value));
    } catch (err) {
      log.warn("saving the app state failed", err);
    }
  };

  const hookPageHide = () => {
    if (hooked || typeof window === "undefined") return;
    hooked = true;
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  };

  return {
    getItem: (name) => {
      if (pending?.name === name) return pending.value;
      const raw = storage().getItem(name);
      return raw === null ? null : (JSON.parse(raw) as StorageValue<S>);
    },
    setItem: (name, value) => {
      if (!isLarge(value)) {
        if (pending?.name === name) {
          if (timer) clearTimeout(timer);
          timer = null;
          pending = null;
        }
        storage().setItem(name, JSON.stringify(value));
        return;
      }
      pending = { name, value };
      hookPageHide();
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    removeItem: (name) => {
      if (pending?.name === name) {
        if (timer) clearTimeout(timer);
        timer = null;
        pending = null;
      }
      storage().removeItem(name);
    },
  };
}

/** Characters of document text in a persisted state (the open document and the open tabs). */
export function persistedTextLength(state: unknown): number {
  if (!state || typeof state !== "object") return 0;
  const s = state as { doc?: { content?: unknown }; openTabs?: unknown };
  let n = typeof s.doc?.content === "string" ? s.doc.content.length : 0;
  if (Array.isArray(s.openTabs)) {
    for (const t of s.openTabs) {
      const c = (t as { content?: unknown } | null)?.content;
      if (typeof c === "string") n += c.length;
    }
  }
  return n;
}
