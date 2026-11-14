/**
 * "Show direction marks" (plan W5.4): one switch for both editors, kept
 * per device. Risky controls (Trojan Source) are shown whether it is on
 * or not.
 */

const KEY = "lumen.bidiMarks";
const listeners = new Set<(shown: boolean) => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let shown: boolean | null = null;

export function bidiMarksShown(): boolean {
  return (shown ??= read());
}

export function setBidiMarksShown(next: boolean): void {
  shown = next;
  try {
    if (next) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* private mode: on for this session only */
  }
  for (const l of listeners) l(next);
}

export function toggleBidiMarks(): boolean {
  setBidiMarksShown(!bidiMarksShown());
  return bidiMarksShown();
}

/** Subscribe to changes; returns the unsubscribe function. */
export function onBidiMarksChange(fn: (shown: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Dependency-free bridge to the mounted WYSIWYG editor's fix (so palette
 * code does not pull ProseMirror into the main bundle): the editor's
 * plugin registers it while mounted, the newest view first.
 */
export type ProseBidiFixer = () => { removed: number; swapped: number };
const fixers: ProseBidiFixer[] = [];

export function registerProseBidiFixer(fn: ProseBidiFixer): () => void {
  fixers.push(fn);
  return () => {
    const i = fixers.indexOf(fn);
    if (i !== -1) fixers.splice(i, 1);
  };
}

export function proseBidiFixer(): ProseBidiFixer | null {
  return fixers[fixers.length - 1] ?? null;
}
