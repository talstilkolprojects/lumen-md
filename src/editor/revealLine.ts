/**
 * Readiness check for `lumen-reveal-line` (vault citations, T29). The event
 * is sent right after a note is opened, before its text has reached
 * CodeMirror; the previous note may already have enough lines, so a line
 * count alone would select a line of the wrong document. With `expected`
 * (the opened note's text) the reveal waits until the editor shows it.
 */
export function readyToReveal(
  doc: { lines: number; length: number; toString(): string },
  line: number,
  expected?: string,
): boolean {
  if (doc.lines < line) return false;
  if (expected === undefined) return true;
  // CodeMirror stores line breaks as "\n".
  const want = expected.replace(/\r\n?/g, "\n");
  return doc.length === want.length && doc.toString() === want;
}
