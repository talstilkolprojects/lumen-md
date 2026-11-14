/**
 * The 30 lines of the 9.7 bidi golden set's shape, for plan W5.4: the
 * held-out split when CI provides GOLDEN_SEED, otherwise the same seeded
 * generator (scripts/golden/sets/small.mjs) with a local seed.
 */
// @ts-expect-error -- plain ESM script without types
import { bidi as bidiSet } from "../../../scripts/golden/sets/small.mjs";

export function goldenBidiLines(): string[] {
  const secret = process.env.GOLDEN_SEED || "lumen-w5.4-local-stand-in";
  const { dev, test } = bidiSet.select(bidiSet.pool(), { set: "bidi", part: "lines", nDev: 8, nTest: 22, secret });
  return [...dev, ...test].map((x: { line: string }) => x.line);
}

/** The same line with an unneeded mark in front of every Hebrew and Latin word. */
export function withNoiseMarks(line: string): string {
  return line.replace(/(^|\s)(?=[א-ת])/g, "$1\u200f").replace(/(^|\s)(?=[A-Za-z])/g, "$1\u200e");
}
