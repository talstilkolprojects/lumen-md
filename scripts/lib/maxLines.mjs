/**
 * Max-lines ratchet (plan W6.25, closes E26 of the 12.11 evening report).
 *
 * No production file under src/ may be longer than MAX_LINES (800). The
 * files that already were when the gate came in are listed, with their line
 * count, in scripts/max-lines-baseline.json. The baseline can only go down:
 *
 *   - a file that is not in the baseline fails once it passes MAX_LINES;
 *   - a file in the baseline fails once it grows past its recorded count;
 *   - a file in the baseline that shrank (or was split, renamed or deleted)
 *     fails too, until the baseline is lowered to match:
 *     `node scripts/check-max-lines.mjs --shrink` (only ever lowers counts
 *     and drops entries; it never raises one or adds a file);
 *   - `npm run pr:check` fails a diff that raises an entry or adds a file to
 *     the baseline (baselineRaises below, against the merge base).
 *
 * Lines are counted the way ESLint's `max-lines` counts them (blank lines
 * and comments included; a final newline does not open a line), so this is
 * the same number `wc -l` prints for a file that ends with a newline.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const MAX_LINES = 800;

/** The committed baseline, relative to the repo root. */
export const BASELINE_PATH = "scripts/max-lines-baseline.json";

/** Production = src/**\/*.{ts,tsx}, without __tests__/, *.test.* / *.spec.* and *.d.ts (as check-code-hygiene.mjs). */
export function isProductionFile(path) {
  if (!/\.(ts|tsx)$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/(^|[\\/])__tests__([\\/]|$)/.test(path)) return false;
  return true;
}

/** Repo-relative path (forward slashes) → line count, for every production file under `root`/src. */
export function productionLineCounts(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "__tests__" && name !== "node_modules") walk(full);
      } else if (isProductionFile(full)) {
        out[relative(root, full).split("\\").join("/")] = countLines(readFileSync(full, "utf8"));
      }
    }
  };
  walk(join(root, "src"));
  return out;
}

/** ESLint's line breaks: CRLF, CR, LF, U+2028 and U+2029. */
const LINE_BREAK = new RegExp(`\\r\\n|[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]`);

/** Lines in `text`, as ESLint `max-lines` counts them. */
export function countLines(text) {
  if (text === "") return 0;
  const lines = text.split(LINE_BREAK);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** The `files` map of a parsed baseline (`{ files: { path: count } }`). */
export function baselineFiles(baseline) {
  const files = baseline && typeof baseline === "object" ? baseline.files : undefined;
  return files && typeof files === "object" ? files : {};
}

/**
 * Check line counts against the baseline.
 * `counts`: repo-relative path → current line count, for every production file.
 * Returns `{ grown, tooLong, shrunk, invalid }`:
 *   grown    — in the baseline and longer than recorded:  { file, lines, baseline }
 *   tooLong  — not in the baseline and over MAX_LINES:     { file, lines }
 *   shrunk   — in the baseline and shorter than recorded, or gone: { file, lines | null, baseline }
 *   invalid  — a baseline entry at or under MAX_LINES, or not a positive integer: { file, baseline }
 */
export function checkMaxLines(counts, baseline, max = MAX_LINES) {
  const recorded = baselineFiles(baseline);
  const grown = [];
  const tooLong = [];
  const shrunk = [];
  const invalid = [];
  for (const [file, n] of Object.entries(recorded)) {
    if (!Number.isInteger(n) || n <= max) invalid.push({ file, baseline: n });
  }
  for (const [file, lines] of Object.entries(counts)) {
    if (Object.hasOwn(recorded, file)) {
      const b = recorded[file];
      if (lines > b) grown.push({ file, lines, baseline: b });
      else if (lines < b) shrunk.push({ file, lines, baseline: b });
    } else if (lines > max) tooLong.push({ file, lines });
  }
  for (const [file, b] of Object.entries(recorded)) {
    if (!Object.hasOwn(counts, file)) shrunk.push({ file, lines: null, baseline: b });
  }
  const byFile = (a, b) => a.file.localeCompare(b.file);
  return { grown: grown.sort(byFile), tooLong: tooLong.sort(byFile), shrunk: shrunk.sort(byFile), invalid: invalid.sort(byFile) };
}

/**
 * The baseline lowered to the current counts: an entry whose file shrank
 * takes the new count, an entry whose file is at or under `max` (or gone) is
 * dropped. An entry is never raised and no file is ever added, so a file that
 * grew keeps its old count (and keeps failing). Returns a new object.
 */
export function shrinkBaseline(baseline, counts, max = MAX_LINES) {
  const recorded = baselineFiles(baseline);
  const files = {};
  for (const file of Object.keys(recorded).sort((a, b) => a.localeCompare(b))) {
    const b = recorded[file];
    const now = counts[file];
    if (now === undefined || now <= max) continue;
    files[file] = Math.min(b, now);
  }
  return { ...baseline, files };
}

/**
 * Entries that `after` raises or adds compared with `before` (both parsed
 * baselines): `{ file, before: number | null, after }`. pr:check fails when
 * this is not empty — the one way left to let a file grow is to edit the
 * baseline, and that is what this catches.
 */
export function baselineRaises(before, after) {
  const a = baselineFiles(before);
  const b = baselineFiles(after);
  const out = [];
  for (const [file, n] of Object.entries(b)) {
    if (!Object.hasOwn(a, file)) out.push({ file, before: null, after: n });
    else if (!(n <= a[file])) out.push({ file, before: a[file], after: n });
  }
  return out.sort((x, y) => x.file.localeCompare(y.file));
}

/** One line per problem, for the terminal and the test's failure message. */
export function describeProblems({ grown, tooLong, shrunk, invalid }, max = MAX_LINES) {
  return [
    ...grown.map((g) => `${g.file}: ${g.lines} lines, grew past its baseline of ${g.baseline} (split it; the baseline never goes up)`),
    ...tooLong.map((t) => `${t.file}: ${t.lines} lines, over ${max} (split it into smaller modules)`),
    ...shrunk.map((s) => `${s.file}: ${s.lines === null ? "gone" : `${s.lines} lines`}, baseline still says ${s.baseline} (lower it: node scripts/check-max-lines.mjs --shrink)`),
    ...invalid.map((i) => `${i.file}: baseline entry ${JSON.stringify(i.baseline)} is not a count over ${max} (remove it)`),
  ];
}
