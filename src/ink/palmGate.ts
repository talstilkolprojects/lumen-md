/**
 * Which pointers may draw (plan W5.27): palm rejection for a pen or an
 * Apple Pencil on a touch screen.
 *
 * - A pen always draws (its eraser end erases, see `isEraser`).
 * - While a pen touches the screen, and for `PALM_MS` after it lifts, every
 *   touch is a resting palm: ignored. A touch stroke already in progress
 *   when the pen comes down was the palm landing first: it is cancelled.
 * - Once a pen has been used on this surface, fingers stop drawing (like
 *   the "only Apple Pencil draws" setting of note apps) unless the user
 *   turns "draw with a finger" back on.
 * - A second finger means a pinch or a scroll, not a stroke: the touch
 *   stroke in progress is cancelled and neither finger draws.
 * - Mouse always draws.
 *
 * Pure state machine; the caller passes the time (`event.timeStamp`).
 */
export const PALM_MS = 500;

export interface GatePointer {
  pointerId: number;
  pointerType: string;
}

export interface GateDecision {
  draw: boolean;
  /** Strokes in progress (by pointer id) to throw away. */
  cancel: number[];
}

export class PalmGate {
  private pens = new Set<number>();
  private touches = new Set<number>();
  /** The touch pointer currently drawing, if any. */
  private drawingTouch: number | null = null;
  private lastPenUp = -Infinity;
  penSeen = false;
  /** User choice: fingers draw even after a pen was used. */
  fingerDraws = false;

  down(e: GatePointer, now: number): GateDecision {
    if (e.pointerType === "pen") {
      this.pens.add(e.pointerId);
      this.penSeen = true;
      const cancel = this.drawingTouch !== null ? [this.drawingTouch] : [];
      this.drawingTouch = null;
      return { draw: true, cancel };
    }
    if (e.pointerType !== "touch") return { draw: true, cancel: [] };
    this.touches.add(e.pointerId);
    if (this.pens.size > 0 || now - this.lastPenUp < PALM_MS) return { draw: false, cancel: [] };
    if (this.penSeen && !this.fingerDraws) return { draw: false, cancel: [] };
    if (this.touches.size > 1) {
      const cancel = this.drawingTouch !== null ? [this.drawingTouch] : [];
      this.drawingTouch = null;
      return { draw: false, cancel };
    }
    this.drawingTouch = e.pointerId;
    return { draw: true, cancel: [] };
  }

  up(e: GatePointer, now: number): void {
    if (this.pens.delete(e.pointerId)) {
      this.lastPenUp = now;
      return;
    }
    this.touches.delete(e.pointerId);
    if (this.drawingTouch === e.pointerId) this.drawingTouch = null;
  }
}

/** The pen's eraser end (or its barrel button held as eraser), per Pointer Events. */
export function isEraser(e: { pointerType: string; buttons: number; button: number }): boolean {
  return e.pointerType === "pen" && ((e.buttons & 32) !== 0 || e.button === 5);
}
