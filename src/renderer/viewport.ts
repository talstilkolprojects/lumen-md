/**
 * Viewport-first rendering of long notes (plan 8.1 step 3).
 *
 * A long note renders block by block (./incrementalPreview.ts). Which
 * blocks go first: the ones the reader sees — from the block at the
 * preview's focus (the top of the note, or the place the editor shows)
 * down to about a screen and a half — then, while the browser is idle,
 * every other block in document order. A block the reader scrolls to
 * while it is still pending jumps the queue. Until it renders, a pending
 * block is a placeholder about as tall as its text will be, so the
 * scrollbar and the scroll position stay where they will end up.
 */

/** Height of a block's placeholder, estimated from its text (px). */
export function estimateBlockHeight(text: string, { lineHeight = 24, charsPerLine = 80, gap = 16 } = {}): number {
  let lines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lines += Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  return Math.max(lineHeight, lines * lineHeight + gap);
}

/** The index of the block that holds character `offset` (the last block for an offset past the end). */
export function blockAt(blocks: readonly { start: number; end: number }[], offset: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/**
 * The blocks to render first: from the block at `focusOffset` on, until
 * their estimated height covers `viewportPx` (at least one block).
 */
export function firstScreen(heights: readonly number[], from: number, viewportPx: number): number[] {
  const out: number[] = [];
  let covered = 0;
  for (let i = from; i < heights.length && (covered < viewportPx || out.length === 0); i++) {
    out.push(i);
    covered += heights[i];
  }
  return out;
}

/**
 * The order to render the `pending` blocks in: the first screen first,
 * then the rest in document order. `jump` (the blocks the reader scrolled
 * to) is asked before every pick, so a block in view goes next.
 */
export class RenderQueue {
  private readonly rest: number[];
  private readonly left: Set<number>;

  constructor(pending: readonly number[], first: readonly number[]) {
    this.left = new Set(pending);
    const head = first.filter((i) => this.left.has(i));
    const headSet = new Set(head);
    this.rest = [...head, ...pending.filter((i) => !headSet.has(i))];
  }

  get size(): number {
    return this.left.size;
  }

  has(i: number): boolean {
    return this.left.has(i);
  }

  /** The next block to render, or undefined when none is left. */
  next(jump: Iterable<number> = []): number | undefined {
    for (const i of jump) {
      if (this.left.delete(i)) return i;
    }
    while (this.rest.length) {
      const i = this.rest.shift()!;
      if (this.left.delete(i)) return i;
    }
    return undefined;
  }
}
