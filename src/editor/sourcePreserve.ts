/**
 * Source-preserving save for the WYSIWYG editor (W1.2).
 *
 * Milkdown has no memory of how a file was written. It parses the Markdown,
 * and on every edit it serializes the whole document again in its own style:
 * `*` bullets become `-`, `__bold__` becomes `**bold**`, tables are
 * re-padded, reference definitions vanish, CRLF becomes LF. Fixing one typo
 * rewrote every line of the file.
 *
 * This module maps Milkdown's output back onto the original source, one
 * top-level block at a time:
 *
 * 1. At load, the original body (O) and Milkdown's serialization of it (C) are
 *    both split into top-level blocks, and the blocks are paired by type and
 *    text content (a longest common subsequence). A pair means "Milkdown
 *    shows this source block".
 * 2. On each save, Milkdown's new serialization (M) is split the same way and
 *    paired with C by exact text. A block of M equal to its block in C was
 *    not edited, so the original source of that block is written instead.
 *    Edited and new blocks are written as Milkdown serialized them.
 * 3. Link reference definitions the serialization left out (the editor
 *    folds them into the links) are kept in place. Only those: any other
 *    unpaired block is shown in some changed form, and writing its source
 *    too would duplicate it.
 *
 * So an unedited document saves byte for byte, and an edit changes only the
 * blocks it touched. Whitespace between two original blocks that are still
 * neighbours is kept as it was, and a CRLF file gets CRLF in the new blocks.
 */
import { lineSeparatorFor } from "./lineEndings";

export interface Block {
  start: number;
  end: number;
  /** mdast node type (`paragraph`, `list`, `definition`, …). */
  type: string;
  /** Node type plus text content: what pairs a source block with its serialization. */
  sig: string;
}

/** Split a Markdown document into its top-level blocks, in order. */
export type BlockSplitter = (md: string) => Block[];

/** Block types Milkdown parses but never shows, so they can only come from the source. */
const HIDDEN_TYPES = new Set(["definition"]);

/** Above this many cell comparisons, pair greedily instead of by LCS. */
const LCS_LIMIT = 4_000_000;

/** Index pairs [i, j] of a longest common subsequence of a and b under `eq`. */
function pairUp<A, B>(a: A[], b: B[], eq: (x: A, y: B) => boolean): [number, number][] {
  const n = a.length;
  const m = b.length;
  const pairs: [number, number][] = [];
  if (n === 0 || m === 0) return pairs;
  if (n * m > LCS_LIMIT) {
    let j = 0;
    for (let i = 0; i < n && j < m; i++) {
      let k = j;
      while (k < m && !eq(a[i], b[k])) k++;
      if (k < m) {
        pairs.push([i, k]);
        j = k + 1;
      }
    }
    return pairs;
  }
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = eq(a[i], b[j])
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

interface Piece {
  text: string;
  /** Index of the original block this piece reproduces, if any. */
  o: number | null;
  /** Index of the block of M this piece comes from, if any. */
  m: number | null;
}

export interface SourcePreserver {
  /** Map Milkdown's serialization onto the original source. */
  restore(serialized: string): string;
  /** Original blocks Milkdown shows (paired with its serialization at load). */
  readonly paired: number;
  /** All original blocks. */
  readonly blocks: number;
}

export function createSourcePreserver(
  original: string,
  serializedAtLoad: string,
  split: BlockSplitter,
): SourcePreserver {
  const O = split(original);
  const C = split(serializedAtLoad);
  const cText = C.map((b) => serializedAtLoad.slice(b.start, b.end));
  // C index -> O index
  const cToO = new Map<number, number>();
  for (const [oi, ci] of pairUp(O, C, (x, y) => x.sig === y.sig)) cToO.set(ci, oi);
  const paired = new Set(cToO.values());
  // Original blocks Milkdown dropped; every other block is either paired or shown changed.
  const hidden = new Set(O.map((_, i) => i).filter((i) => !paired.has(i) && HIDDEN_TYPES.has(O[i].type)));
  const crlf = lineSeparatorFor(original) === "\r\n";
  const eol = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);

  const restore = (M: string): string => {
    if (O.length === 0) return eol(M);
    if (M === serializedAtLoad && cToO.size === C.length && paired.size === O.length) return original;
    const Mb = split(M);
    const mText = Mb.map((b) => M.slice(b.start, b.end));
    // M index -> O index, through the unedited blocks of C.
    const mToO = new Map<number, number>();
    for (const [mi, ci] of pairUp(mText, cText, (x, y) => x === y)) {
      const oi = cToO.get(ci);
      if (oi !== undefined) mToO.set(mi, oi);
    }
    const pieces: Piece[] = [];
    let nextHidden = 0;
    const flushHidden = (upTo: number) => {
      for (; nextHidden < upTo; nextHidden++) {
        if (hidden.has(nextHidden)) {
          pieces.push({ text: original.slice(O[nextHidden].start, O[nextHidden].end), o: nextHidden, m: null });
        }
      }
    };
    for (let mi = 0; mi < Mb.length; mi++) {
      const oi = mToO.get(mi);
      if (oi !== undefined) {
        flushHidden(oi);
        nextHidden = Math.max(nextHidden, oi + 1);
        pieces.push({ text: original.slice(O[oi].start, O[oi].end), o: oi, m: mi });
      } else {
        pieces.push({ text: eol(mText[mi]), o: null, m: mi });
      }
    }
    flushHidden(O.length);
    if (pieces.length === 0) return eol(M);

    let out = "";
    const first = pieces[0];
    if (first.o === 0) out += original.slice(0, O[0].start);
    else if (first.m === 0) out += eol(M.slice(0, Mb[0].start));
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      if (k > 0) {
        const prev = pieces[k - 1];
        if (prev.o !== null && p.o !== null && p.o === prev.o + 1) {
          out += original.slice(O[prev.o].end, O[p.o].start);
        } else if (prev.m !== null && p.m !== null && p.m === prev.m + 1) {
          out += eol(M.slice(Mb[prev.m].end, Mb[p.m].start));
        } else {
          out += crlf ? "\r\n\r\n" : "\n\n";
        }
      }
      out += p.text;
    }
    const last = pieces[pieces.length - 1];
    if (last.o === O.length - 1) out += original.slice(O[O.length - 1].end);
    else if (last.m === Mb.length - 1) out += eol(M.slice(Mb[Mb.length - 1].end));
    else out += crlf ? "\r\n" : "\n";
    return out;
  };

  return { restore, paired: cToO.size, blocks: O.length };
}

interface MdNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function textOf(n: MdNode): string {
  if (typeof n.value === "string") return n.value;
  if (n.children) return n.children.map(textOf).join(" ");
  return n.alt ?? "";
}

/** A BlockSplitter over any mdast parser: top-level children with their source offsets. */
export function blocksFromMdast(parse: (md: string) => MdNode): BlockSplitter {
  return (md) => {
    const root = parse(md);
    const out: Block[] = [];
    for (const c of root.children ?? []) {
      const start = c.position?.start.offset;
      const end = c.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      out.push({ start, end, type: c.type, sig: `${c.type}:${textOf(c).replace(/\s+/g, " ").trim()}` });
    }
    return out;
  };
}
