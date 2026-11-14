/**
 * Mixed-direction lines in Hebrew OCR (plan 7.5): Latin words, e-mail
 * addresses, URLs and numbers inside a right-to-left line.
 *
 * tesseract (heb+eng) reads a Hebrew prefix glued to a Latin word as a Latin
 * symbol — "ו-Bluetooth" as "Bluetooth-1", "ה-PDF" as "PDF-A" — and a short
 * Hebrew word between Latin runs as Latin ("או" as "IN"). The Hebrew letter
 * then no longer breaks the left-to-right run, so the whole run comes out in
 * visual order. Only for lines that contain Latin letters, this module
 *  1. re-reads, with a Hebrew-only single-word pass, a lone symbol glued to a
 *     Latin word by a hyphen and short Latin words tesseract was unsure of,
 *     keeping the Hebrew reading only when it is a Hebrew word read with
 *     more confidence;
 *  2. rebuilds the line in logical order from the word boxes: right to left,
 *     each run of left-to-right words read left to right.
 *  3. re-reads, with a Latin-only single-word pass, the word after a Hebrew
 *     prefix and hyphen when tesseract was unsure of it ("ה-PDF" read as
 *     "ה-201" or "ה-זסץ"), on every line: such a line may have no Latin
 *     letter left at all;
 *  4. reads a lone vertical stroke ("1", "l", "I", "|") after "<Latin>-" as
 *     the prefix ו when the Hebrew pass cannot tell: in sans-serif faces ו is
 *     a bare stroke, and it is the only prefix letter that is.
 *  5. (plan W1.18) re-reads, Latin-only, the Latin part of an unsure
 *     "<Latin>-<prefix>" word ("ה-PDF" read as "PDE-7"), and accepts a Latin
 *     reading of a prefixed tail, sure or not, when tesseract's Hebrew reading
 *     of it cannot be a Hebrew word (digits among Hebrew letters, a final
 *     letter inside the word: "ו-ח01סז6טו8"). Sentence marks around a Latin
 *     reading ("." at the visual left of "Bluetooth.") are kept apart. On a
 *     Hebrew page, a glued prefix is looked for on lines with no Hebrew
 *     letter left too, and "ב-Drive" with "Google" at its visual left is
 *     read "ב-Google Drive".
 * Other lines keep tesseract's own text.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrSymbol {
  text: string;
  bbox: Box;
  confidence: number;
}

export interface OcrWord {
  text: string;
  bbox: Box;
  confidence: number;
  symbols: OcrSymbol[];
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
}

/** A Hebrew-only reading of one rectangle of the image. */
export type ReadHebrew = (box: Box) => Promise<{ text: string; confidence: number }>;
/** A Latin-only reading of one rectangle of the image. */
export type ReadLatin = ReadHebrew;

export interface Readers {
  heb: ReadHebrew;
  /** Optional: without it, step 3 is skipped. */
  latin?: ReadLatin;
}

/** Below this word confidence, a prefixed word's tail is re-read as Latin. */
const UNSURE_TAIL = 70;
/** The Latin reading of a tail replaces it only from this confidence. */
const SURE_LATIN = 85;
/** Glyphs a bare vertical stroke is read as. */
const STROKE = /^[1lI|!\[\]]$/;

const MARKS = /[‎‏‪-‮⁦-⁩]/g;
const HEB = /[א-ת]/;
const LATIN = /[A-Za-z]/;
/** The letters that attach to the next word with a hyphen before a foreign word: ו-, ה-, ב-, ל-, מ-, ש-, כ-. */
const PREFIX = "והבלמשכ";

const strip = (s: string) => s.replace(MARKS, "");

function union(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/** Pad a box a little: a single glyph read alone needs some margin. */
function pad(b: Box, by = 3): Box {
  return { x0: Math.max(0, b.x0 - by), y0: Math.max(0, b.y0 - by), x1: b.x1 + by, y1: b.y1 + by };
}

/** A word whose logical form is left-to-right: its first strong letter is Latin, or it has no letters but digits. */
export function isLtrWord(text: string): boolean {
  const t = strip(text);
  const first = /[א-תA-Za-z]/.exec(t)?.[0];
  if (first) return LATIN.test(first);
  return /\d/.test(t);
}

/**
 * Tesseract's reading of what is really a Latin word after a Hebrew prefix:
 * digits among Hebrew letters, a final letter (ך ם ן ף ץ) inside the word,
 * or symbols that are not a number ("50[" for "JSON"). No Hebrew word is
 * written so.
 * @internal exported for tests.
 */
export function implausibleHebrew(text: string): boolean {
  const t = strip(text).replace(/[.,;:!?"'()]/g, "");
  if (LATIN.test(t)) return false;
  if (!HEB.test(t)) {
    // No letters: a number, date, time, amount or percentage is plausible ("ל-04.02.2022"); other symbols are not ("כ-50[").
    return !!t && !/^[\d.,:/%₪$+-]+$/.test(t);
  }
  return /\d/.test(t) || /[ךםןףץ](?=[א-ת])/.test(t);
}

/** A Latin-only reading as a bare word: sentence marks on either side split off. */
function latinWord(r: { text: string; confidence: number } | null): { word: string; confidence: number } | null {
  if (!r) return null;
  const word = strip(r.text).trim().replace(/-+$/, "").replace(/^[.,;:!?]+|[.,;:!?]+$/g, "");
  return /^[A-Za-z]{2,}$/.test(word) ? { word, confidence: r.confidence } : null;
}

interface Piece {
  /** Logical text of the word. */
  text: string;
  bbox: Box;
}

/**
 * One word, fixed: "Bluetooth-1" with its last symbol re-read as Hebrew "ו"
 * becomes "ו-Bluetooth" (the prefix sits at the visual right, logically
 * first); a trailing sentence mark at the visual left moves to the end.
 */
async function fixWord(word: OcrWord, readers: Readers): Promise<Piece> {
  const read = readers.heb;
  const text = strip(word.text);
  if (HEB.test(text)) return { text: await fixPrefixedTail(word, readers), bbox: word.bbox };
  if (!LATIN.test(text)) return { text, bbox: word.bbox };
  const syms = word.symbols.map((s) => ({ ...s, text: strip(s.text) })).filter((s) => s.text);
  // Visual order, left to right (tesseract lists an LTR word's symbols that way; sort to be sure).
  syms.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  // Sentence marks at the visual left of a word in an RTL line end it logically.
  let trail = "";
  while (syms.length > 1 && /^[.,;:!?]$/.test(syms[0].text)) trail += syms.shift()!.text;
  const n = syms.length;
  // "<Latin>-X": X, at the visual right, is a Hebrew prefix letter read as Latin.
  if (n >= 3 && syms[n - 2].text === "-" && !/^[A-Za-z]{2,}$/.test(syms[n - 1].text) && LATIN.test(syms[n - 3].text)) {
    // The glyph's own columns, the word's full height: a tight box loses the letter's shape.
    const glyph = syms[n - 1].bbox;
    const heb = await read(pad({ x0: glyph.x0, x1: glyph.x1, y0: word.bbox.y0, y1: word.bbox.y1 }, 3)).catch(() => null);
    const letter = heb ? strip(heb.text).replace(/[^א-ת]/g, "") : "";
    let latin = syms.slice(0, n - 2).map((s) => s.text).join("");
    const prefix = letter.length === 1 && PREFIX.includes(letter) ? letter : !letter && STROKE.test(syms[n - 1].text) ? "ו" : "";
    if (prefix) {
      // An unsure word: its Latin part ("PDE" for "PDF") re-read Latin-only, kept when that reading is sure.
      if (readers.latin && word.confidence < UNSURE_TAIL) {
        const first = syms[0].bbox;
        const hyphen = syms[n - 2].bbox;
        const box = pad({ x0: first.x0, x1: Math.max(first.x0 + 1, hyphen.x0 - 1), y0: word.bbox.y0, y1: word.bbox.y1 });
        const r = latinWord(await readers.latin(box).catch(() => null));
        if (r && r.confidence >= SURE_LATIN && Math.abs(r.word.length - latin.length) <= 1) latin = r.word;
      }
      // A Hebrew prefix letter came back, or no letter came back and the glyph is a bare stroke: the prefix ו.
      return { text: `${prefix}-${latin}${trail}`, bbox: word.bbox };
    }
  }
  const latin = syms.map((s) => s.text).join("") + trail;
  // A short word tesseract was unsure of: maybe Hebrew ("או" read as "IN").
  if (/^[A-Za-z]{1,3}$/.test(latin) && word.confidence < 80) {
    const heb = await read(pad(word.bbox)).catch(() => null);
    const t = heb ? strip(heb.text).trim() : "";
    if (heb && /^[א-ת]{1,4}$/.test(t) && heb.confidence > word.confidence) return { text: t, bbox: word.bbox };
  }
  return { text: latin, bbox: word.bbox };
}

/**
 * "ה-<tail>" where tesseract was unsure: the tail (the visual left of the
 * hyphen) re-read as Latin replaces it when that reading is all letters and
 * sure. Returns the word's text, fixed or not.
 */
async function fixPrefixedTail(word: OcrWord, readers: Readers): Promise<string> {
  const text = strip(word.text);
  const m = /^([והבלמשכ])-(.+)$/.exec(text);
  if (!m || !readers.latin || word.confidence >= UNSURE_TAIL || LATIN.test(m[2])) return text;
  const hyphen = word.symbols.find((s) => strip(s.text) === "-");
  if (!hyphen || hyphen.bbox.x0 <= word.bbox.x0) return text;
  // Padded on the left and vertically only: the right edge stops short of the hyphen.
  const box = pad({ x0: word.bbox.x0, x1: hyphen.bbox.x0 - 4, y0: word.bbox.y0, y1: word.bbox.y1 });
  const r = latinWord(await readers.latin({ ...box, x1: Math.max(box.x0 + 1, hyphen.bbox.x0 - 1) }).catch(() => null));
  // Sentence marks stay where tesseract put them.
  const tailMarks = /[.,;:!?]+$/.exec(m[2])?.[0] ?? "";
  if (!r) return text;
  if (r.confidence >= SURE_LATIN) return `${m[1]}-${r.word}${tailMarks}`;
  // tesseract's Hebrew reading cannot be a word: an all-letters Latin reading of about its length wins however unsure
  // (a single word read alone gets very uneven confidences: the same "Bluetooth" from 5 to 79 with the margin).
  const glyphs = m[2].replace(/[.,;:!?]+$/, "").length;
  if (implausibleHebrew(m[2]) && Math.abs(r.word.length - glyphs) <= Math.max(1, Math.round(glyphs * 0.4))) return `${m[1]}-${r.word}${tailMarks}`;
  return text;
}

/**
 * The line's text in logical order. Unchanged (tesseract's own) when the
 * line has no Latin letter or no Hebrew one.
 */
export async function fixMixedLine(line: OcrLine, read: ReadHebrew | Readers, opts: LineOptions = {}): Promise<string> {
  const readers: Readers = typeof read === "function" ? { heb: read } : read;
  const own = line.text.replace(/\n$/, "");
  if (!line.words.length) return own;
  const glued = !!opts.hebrewPage && line.words.some((w) => gluedPrefix(w.text));
  if (!LATIN.test(own) || (!HEB.test(own) && !glued)) {
    // Only step 3 applies; tesseract's own order is kept.
    let out = own;
    for (const w of line.words) {
      const before = strip(w.text);
      const after = await fixPrefixedTail(w, readers);
      if (after !== before) out = strip(out).replace(before, after);
    }
    return out;
  }
  const pieces = await Promise.all(line.words.map((w) => fixWord(w, readers)));
  // Right to left; a run of LTR pieces is read left to right.
  const visual = [...pieces].sort((a, b) => b.bbox.x1 - a.bbox.x1);
  const out: string[] = [];
  for (let i = 0; i < visual.length; ) {
    // "ב-Drive" with "Google" at its visual left is "ב-Google Drive": the prefix belongs before the whole
    // left-to-right run, and the word next to the hyphen is the run's last word.
    const prefixed = /^([והבלמשכ])-([A-Za-z].*)$/.exec(visual[i].text);
    if (prefixed && i + 1 < visual.length && isLtrWord(visual[i + 1].text)) {
      const run: string[] = [prefixed[2]];
      i++;
      while (i < visual.length && isLtrWord(visual[i].text)) run.push(visual[i++].text);
      out.push(`${prefixed[1]}-${run.reverse().join(" ")}`);
      continue;
    }
    if (!isLtrWord(visual[i].text)) {
      out.push(visual[i++].text);
      continue;
    }
    const run: Piece[] = [];
    while (i < visual.length && isLtrWord(visual[i].text)) run.push(visual[i++]);
    out.push(...run.reverse().map((p) => p.text));
  }
  return out.join(" ");
}

/** True when a line needs fixMixedLine at all (otherwise tesseract's text is used as is). */
export function needsFix(line: OcrLine, opts: LineOptions = {}): boolean {
  const t = strip(line.text);
  if (LATIN.test(t) && HEB.test(t)) return true;
  if (opts.hebrewPage && line.words.some((w) => gluedPrefix(w.text))) return true;
  return line.words.some((w) => /^[והבלמשכ]-./.test(strip(w.text)) && w.confidence < UNSURE_TAIL);
}

/**
 * "<Latin>-<one glyph>": on a Hebrew page, a prefix letter read as Latin
 * (".WhatsApp-2" for "ב-WhatsApp."), also on a line where no Hebrew letter
 * is left. Only on Hebrew pages: in English text "Model-1" is a model.
 */
const gluedPrefix = (text: string) => /[A-Za-z]-[^A-Za-z\s]$/.test(strip(text).replace(/^[.,;:!?]+/, ""));

export interface LineOptions {
  /** The page is mostly Hebrew (./ocrLayout isRtlPage): a Latin-only line may still hide a Hebrew prefix. */
  hebrewPage?: boolean;
}


export async function fixMixedText(lines: OcrLine[], read: ReadHebrew | Readers, opts: LineOptions = {}): Promise<string> {
  const out: string[] = [];
  for (const l of lines) out.push(await fixMixedLine(l, read, opts));
  return out.join("\n");
}

/** The words' union box (tests). */
export const boxOf = (words: OcrWord[]): Box => union(words.map((w) => w.bbox));
