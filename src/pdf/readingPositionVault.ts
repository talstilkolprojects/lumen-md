/**
 * The PDF reader's reading position in the vault (plan W6.47), moved out of
 * PdfReader.tsx verbatim: where positions are stored and how the page boxes
 * are measured.
 */
import type { PageBox, PositionsIO } from "./readingPosition";

/** W6.47: the place is saved this long after scrolling stops. */
export const POSITION_SAVE_MS = 1_000;

/** Reading positions live in the vault (`.lumen/reading-positions.json`), so the vault's sync carries them. */
export const positionsIO: PositionsIO = {
  read: async (p) => {
    const ws = await import("../storage/workspace");
    try {
      return await ws.readWorkspaceFile(p);
    } catch {
      return null;
    }
  },
  write: async (p, text) => {
    const ws = await import("../storage/workspace");
    await ws.createWorkspaceFolder(".lumen").catch(() => undefined);
    await ws.writeWorkspaceFile(p, text);
  },
};

/** The pages' boxes in the scroll container, page 1 first. */
export function pageBoxes(els: Map<number, HTMLDivElement>): PageBox[] {
  return [...els.entries()].sort(([a], [b]) => a - b).map(([, el]) => ({ top: el.offsetTop, height: el.offsetHeight }));
}
