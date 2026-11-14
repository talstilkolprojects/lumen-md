/**
 * Other vault-wide actions Ctrl+Z outside an editor can undo, besides a
 * delete (plan 3.1): a bulk property edit (plan W7.4) registers here once its
 * chunk has loaded. Dependency-free, so the startup bundle stays as it was.
 */

export interface AppUndo {
  /** When its newest undoable action happened (ms), or 0 when there is none. */
  at(): number;
  /** Undo that action (its own toasts report the result). */
  undo(): void;
}

const sources = new Set<AppUndo>();

export function registerAppUndo(source: AppUndo): () => void {
  sources.add(source);
  return () => sources.delete(source);
}

/** The source with the newest undoable action, if it is newer than `than`. */
export function newestAppUndo(than: number): AppUndo | null {
  let best: AppUndo | null = null;
  let at = than;
  for (const s of sources) {
    const t = s.at();
    if (t > at) {
      at = t;
      best = s;
    }
  }
  return best;
}
