/**
 * The PDF reader's props, constants and small helpers (plan W6.25: moved out
 * of PdfReader.tsx unchanged).
 */
import { type PdfAnnotation } from "./annotations";
import { type PageBox, type PositionsIO } from "./readingPosition";

export interface Props {
  /** Vault path of the PDF. */
  path: string;
  /** `page=N&highlight=ID` from the link that opened it (re-applied when it changes). */
  fragment?: string | null;
  /** Bumped by the opener for every open, so the same link opened twice flashes twice. */
  openSeq?: number;
  onClose: () => void;
  /** Open the companion note in the editor. */
  onOpenNotes: (notePath: string) => void;
  /**
   * Receives the reader's save gate (null on unmount): whoever replaces the
   * reader (another PDF opened) runs through it, so pending or failed
   * highlight writes are saved first.
   */
  registerSaveGate?: (gate: ((then: () => void) => void) | null) => void;
}

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 4;
/** Pages kept rendered beyond the viewport, in viewport heights. */
export const ROOT_MARGIN = "150% 0px";

/** A random RFC 4122 v4 uuid (crypto.randomUUID is missing in insecure contexts). */
export function newUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A file (or folder on its path) that isn't there — as opposed to a read that failed. */
export function isMissing(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "NotFoundError";
}

export function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

export const EMPTY: PdfAnnotation[] = [];

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
