/**
 * Keys for open documents (plan 5.11, `docKey.ts`): one per document while
 * it is open, the same across tab switches and saving it into the
 * workspace, a new one when a different document is loaded.
 *
 * Derived from the store's own events, so the store keeps no extra state:
 *  - the same load (`doc.loadId` unchanged: typing, saving, the document
 *    taking a workspace name) keeps the document's key;
 *  - a load seen before keeps that load's key (switching back to a tab
 *    whose load is kept);
 *  - a new load of a tab that was open with exactly this text is that tab's
 *    document focused again (`openTab` mints a new load when it focuses an
 *    open tab): its key;
 *  - anything else is a different document: a new key. A tab that closes
 *    loses its key, so a document opened later under the same name is a
 *    different one.
 */

import { tabIdOf } from "../store/useStore";

export interface KeyedState {
  doc: { name: string; workspaceName?: string | null; content: string; loadId?: number };
  openTabs: ReadonlyArray<{ id: string; content: string }>;
}

export interface DocumentKeys {
  /** Bring the keys up to date with the store's state (call on every change). */
  observe(state: KeyedState): void;
  /** The active document's key. */
  active(): string | undefined;
  /** The key of the document in an open tab. */
  tab(id: string): string | undefined;
}

const MAX_LOADS = 500;

export function createDocumentKeys(): DocumentKeys {
  let seq = 0;
  let last: KeyedState | null = null;
  const byLoad = new Map<number, string>();
  const byTab = new Map<string, string>();
  const fresh = () => `doc${++seq}`;

  function observe(state: KeyedState): void {
    if (state === last) return;
    const prev = last;
    last = state;
    const id = tabIdOf(state.doc);
    const load = state.doc.loadId;
    let key: string | undefined;
    if (prev && prev.doc.loadId === load) {
      key = byTab.get(tabIdOf(prev.doc));
    } else {
      key = load !== undefined ? byLoad.get(load) : undefined;
      if (!key && prev) {
        const prevId = tabIdOf(prev.doc);
        const held = prevId === id ? prev.doc.content : prev.openTabs.find((t) => t.id === id)?.content;
        if (held === state.doc.content) key = byTab.get(id);
      }
    }
    key ??= fresh();
    if (load !== undefined) {
      byLoad.set(load, key);
      if (byLoad.size > MAX_LOADS) byLoad.delete(byLoad.keys().next().value!);
    }
    byTab.set(id, key);
    for (const tabId of [...byTab.keys()]) {
      if (tabId !== id && !state.openTabs.some((t) => t.id === tabId)) byTab.delete(tabId);
    }
  }

  return {
    observe,
    active: () => (last ? byTab.get(tabIdOf(last.doc)) : undefined),
    tab: (id) => byTab.get(id),
  };
}
