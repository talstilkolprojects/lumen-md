/**
 * Hebrew pasted from a PDF (plan W5.5): text copied out of many Hebrew
 * PDFs (court rulings, government forms, articles) comes out in the
 * order the glyphs were drawn, left to right, not the order they are read:
 * "קובץ ה-PDF בשנת 2024" arrives as "2024 תנשב PDF-ה ץבוק". Some PDFs also
 * map final letters to the wrong form ("שלומ", "םלש").
 *
 * analyzePdfHebrew() decides, from evidence that correct Hebrew never shows:
 *   - a final letter (ך ם ן ף ץ) at the start of a word, and a regular
 *     כ מ נ פ צ at its end;
 *   - frequent words read backwards ("לש", "םע", "אוה", "ןיא", …);
 *   - sentence punctuation at the start of a line instead of its end.
 * Counter-evidence (final letters at the end, function words read
 * forwards, a full stop at the end) has to be absent or far weaker, so
 * correct Hebrew is left alone — a false fix is worse than none.
 *
 * fixVisualLine() turns one line from visual into logical order the way a
 * right-to-left paragraph is laid out (UAX #9), in reverse: the line is
 * split into left-to-right runs (Latin words and numbers, with the spaces
 * and punctuation between them when a Latin word leads) and single
 * characters; the order of those pieces is reversed, the runs keep their
 * own order, and brackets outside the runs are mirrored back.
 *
 * fixFinalForms() puts final letters where they belong: the last letter
 * of a word in its final form, a final form inside a word in its regular
 * one. Words with a geresh, gershayim or quote (acronyms such as מ״מ) are
 * left alone.
 */

const HEB_LETTER = /[א-ת]/;
// A maqaf (U+05BE, "בן־יהודה") joins two words; it is not part of either, so a final letter before it
// is a word end, not a final letter inside a word (train 5: the Ben Yehuda strings were taken for wrong finals).
const HEB_WORD = /[א-ת][א-ת\u0591-\u05bd\u05bf-\u05c7]*/g;
const POINTS = /[\u0591-\u05c7]/g;
const FINAL = "ךםןףץ";
const REGULAR = "כמנפצ";
const TO_FINAL: Record<string, string> = { כ: "ך", מ: "ם", נ: "ן", פ: "ף", צ: "ץ" };
const TO_REGULAR: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
/**
 * A word touching one of these is an acronym, a quote, a transliteration
 * or a prefix joined by a hyphen ("כ-35%", "ה-PDF"): never counted or changed.
 */
const MARKED = /['"׳״‘’“”`\-־–]/;

/**
 * Frequent Hebrew words (general frequency, not this feature's test
 * corpus) whose reversed spelling is not a Hebrew word. Pairs that read as
 * words both ways (לא/אל, את/תא, עד/דע, רק/קר, יש/שי, אלו/ולא, טוב/בוט,
 * עבור/רובע) and palindromes (הזה, היה) are left out.
 */
const FUNCTION_WORDS = ["של", "על", "עם", "זה", "כי", "גם", "או", "אם", "הוא", "היא", "הם", "הן", "אין", "כל", "בין", "לפי", "אשר", "זאת", "אני", "אנחנו", "להם", "שלא", "כן", "אבל", "מאוד", "שהוא", "יותר", "אחרי", "לפני", "כמו", "הזאת", "אותו", "אותה", "שלו", "עוד", "כך", "אז", "לאחר", "כדי", "ידי", "פי", "נגד", "אך", "למען", "שם", "היום", "אחד", "אחת", "שני", "כאן", "אצל", "בלי", "אולם", "לכן", "מה", "מי", "לי", "לו", "עכשיו", "דבר", "אנשים", "ישראל", "בית", "שנה", "שנים", "יום", "פעם", "חלק", "מקום", "דרך", "תוך", "לגבי", "ביותר", "כמה", "כבר", "אולי", "תמיד", "אף", "בגלל", "עדיין", "ממש", "כלל", "איך", "למה", "צריך", "גדול", "חדש", "ראשון", "אחר", "מספר", "מתי", "איפה"];
const reverse = (s: string) => Array.from(s).reverse().join("");
const FORWARD = new Set(FUNCTION_WORDS);
/** The function words that end in a final letter, spelled with the regular one ("בינ", "שמ"): not words. */
const GARBLED = new Set(
  FUNCTION_WORDS.filter((w) => "ךםןףץ".includes(w[w.length - 1])).map((w) => w.slice(0, -1) + ({ ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" } as Record<string, string>)[w[w.length - 1]]),
);
const BACKWARD = new Set(FUNCTION_WORDS.map(reverse).filter((w) => !FORWARD.has(w)));

export interface PdfHebrewEvidence {
  words: number;
  finalStart: number;
  finalEnd: number;
  finalMid: number;
  regularEnd: number;
  regularStart: number;
  wordsForward: number;
  wordsBackward: number;
  /** Function words with a regular letter where the final belongs. */
  wordsGarbled: number;
  punctStart: number;
  punctEnd: number;
}

export type PdfHebrewKind = "reversed" | "finals";

export interface PdfHebrewAnalysis {
  kind: PdfHebrewKind | null;
  evidence: PdfHebrewEvidence;
}

/** The Hebrew words of `text` that can be judged: two letters or more, no geresh or quote next to them, points removed. */
function judgedWords(text: string): string[] {
  const out: string[] = [];
  HEB_WORD.lastIndex = 0;
  for (let m = HEB_WORD.exec(text); m; m = HEB_WORD.exec(text)) {
    const before = text[m.index - 1] ?? "";
    const after = text[m.index + m[0].length] ?? "";
    if (MARKED.test(before) || MARKED.test(after)) continue;
    const w = m[0].replace(POINTS, "");
    if (w.length >= 2) out.push(w);
  }
  return out;
}

export function pdfHebrewEvidence(text: string): PdfHebrewEvidence {
  const e: PdfHebrewEvidence = { words: 0, finalStart: 0, finalEnd: 0, finalMid: 0, regularEnd: 0, regularStart: 0, wordsForward: 0, wordsBackward: 0, wordsGarbled: 0, punctStart: 0, punctEnd: 0 };
  for (const w of judgedWords(text)) {
    e.words++;
    const first = w[0];
    const last = w[w.length - 1];
    if (FINAL.includes(first)) e.finalStart++;
    if (FINAL.includes(last)) e.finalEnd++;
    if (REGULAR.includes(last)) e.regularEnd++;
    if (REGULAR.includes(first)) e.regularStart++;
    for (let i = 1; i < w.length - 1; i++) if (FINAL.includes(w[i])) e.finalMid++;
    if (FORWARD.has(w)) e.wordsForward++;
    if (BACKWARD.has(w)) e.wordsBackward++;
    if (GARBLED.has(w)) e.wordsGarbled++;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!HEB_LETTER.test(line)) continue;
    if (/^[.,:;!?]/.test(line) && !/[.,:;!?]$/.test(line)) e.punctStart++;
    if (/[.,:;!?]$/.test(line) && !/^[.,:;!?]/.test(line)) e.punctEnd++;
  }
  return e;
}

/**
 * How often each letter starts and ends a Hebrew word (U+05D0–U+05EA in
 * order, finals included), counted over the app's Hebrew UI strings and
 * Hebrew welcome note (4,039 words). Used for one weak signal: whether the
 * words read more like Hebrew forwards or backwards.
 */
const START_COUNTS = [382, 342, 45, 57, 634, 104, 57, 78, 39, 76, 0, 167, 401, 0, 479, 0, 174, 65, 182, 0, 96, 0, 25, 139, 75, 299, 123];
const END_COUNTS = [125, 99, 22, 87, 497, 199, 9, 61, 49, 233, 120, 0, 345, 515, 1, 299, 0, 15, 32, 50, 1, 59, 0, 110, 281, 75, 755];
const logShare = (counts: number[]) => {
  const total = counts.reduce((a, b) => a + b, 0) + counts.length;
  return counts.map((c) => Math.log((c + 1) / total));
};
const LOG_START = logShare(START_COUNTS);
const LOG_END = logShare(END_COUNTS);
const letterIndex = (ch: string) => ch.charCodeAt(0) - 0x05d0;

/** Log-likelihood that the words read forwards rather than backwards (positive: forwards). */
export function letterOrderScore(text: string): { score: number; words: number } {
  let score = 0;
  let words = 0;
  for (const w of judgedWords(text)) {
    const a = letterIndex(w[0]);
    const z = letterIndex(w[w.length - 1]);
    if (a < 0 || a > 26 || z < 0 || z > 26) continue;
    // Final and regular כ מ נ פ צ have signals of their own.
    if ((FINAL + REGULAR).includes(w[0]) || (FINAL + REGULAR).includes(w[w.length - 1])) continue;
    score += LOG_START[a] + LOG_END[z] - (LOG_START[z] + LOG_END[a]);
    words++;
  }
  return { score, words };
}

/** Is this pasted text Hebrew in visual order, or with its final letters wrong? null when it reads fine. */
export function analyzePdfHebrew(text: string): PdfHebrewAnalysis {
  const e = pdfHebrewEvidence(text);
  const strongBack = e.finalStart + e.wordsBackward + e.punctStart;
  const strongForward = e.finalEnd + e.wordsForward + e.punctEnd + e.regularStart;
  const back = strongBack + e.regularEnd;
  let kind: PdfHebrewKind | null = null;
  if (e.finalMid >= 1 && e.finalMid > e.finalEnd && e.wordsBackward + e.punctStart === 0) {
    // A final letter inside a word: neither correct nor reversed text has one. But a PDF
    // reader joins words where the PDF has no space glyph ("גםאתר"): with more words that
    // end in their final letter than finals inside words, the text reads right (W6.38).
    kind = "finals";
  } else if (strongBack >= 1 && (back >= 2 || (strongForward === 0 && e.finalStart + e.wordsBackward >= 1)) && 4 * strongForward <= back) {
    // A final letter opening a word, or a frequent word spelled backwards, never occurs in
    // correct Hebrew: alone it is enough when nothing reads forwards (a one-word form field).
    kind = "reversed";
  } else if (strongBack === 0 && e.finalEnd === 0 && (e.regularEnd >= 2 || e.wordsGarbled >= 1)) {
    // No word ends in a final letter, and several end in a regular כ מ נ פ צ, or a
    // frequent word does ("בינ"): finals read as regular letters. One such word alone
    // may be a loanword (טיפ) and is left alone.
    kind = "finals";
  } else if (strongForward === 0 && e.words >= 4) {
    // Nothing decisive: the letters at the words' edges, when they clearly read backwards.
    const { score, words } = letterOrderScore(text);
    if (score <= -5 && score / words <= -0.7) kind = "reversed";
  }
  return { kind, evidence: e };
}

// ── Visual → logical ────────────────────────────────────────────────────

const LTR_CH = "A-Za-z0-9\\u00c0-\\u024f\\u0370-\\u03ff\\u0400-\\u04ff";
/** One left-to-right atom: a Latin word or a number, with inner punctuation (3.5, 10:30, gov.il, GPT-4, 1234/20, 15,000, 35%). */
const ATOM = new RegExp(`[${LTR_CH}](?:[${LTR_CH}'’._:/@+\\-,&#=?]*[${LTR_CH}%])?%?`, "y");
const HAS_LATIN = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
/**
 * What may sit between two atoms of one left-to-right run. Brackets too:
 * a number after a Latin word is left-to-right (UAX #9 W7), so is a bracket
 * pair around it ("Smith et al. (2021)").
 */
const GAP = /[ \t.,:;\-–—/&+'"’()[\]]+/y;
const CLOSERS = /[)\]]+/y;
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«" };

/**
 * One line in visual (left-to-right drawing) order to logical order, for
 * a right-to-left paragraph. A line without Hebrew is returned as is.
 */
export function fixVisualLine(line: string): string {
  if (!HEB_LETTER.test(line)) return line;
  const pieces: string[] = [];
  let i = 0;
  while (i < line.length) {
    ATOM.lastIndex = i;
    const m = ATOM.exec(line);
    if (!m) {
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      pieces.push(MIRROR[ch] ?? ch);
      i += ch.length;
      continue;
    }
    // A run: atoms joined by gaps while a Latin word leads (UAX #9 W7, N1).
    let run = m[0];
    let end = i + run.length;
    while (HAS_LATIN.test(run)) {
      GAP.lastIndex = end;
      const g = GAP.exec(line);
      if (!g) break;
      ATOM.lastIndex = end + g[0].length;
      const next = ATOM.exec(line);
      if (!next) break;
      run += g[0] + next[0];
      end = ATOM.lastIndex;
    }
    // A bracket opened inside the run closes inside it.
    const opened = (run.match(/[([]/g) ?? []).length - (run.match(/[)\]]/g) ?? []).length;
    if (opened > 0) {
      CLOSERS.lastIndex = end;
      const c = CLOSERS.exec(line);
      if (c) {
        const take = c[0].slice(0, opened);
        run += take;
        end += take.length;
      }
    }
    pieces.push(run);
    i = end;
  }
  // A glyph cluster is drawn base first, points after it: keep each letter's points with it.
  const clusters: string[] = [];
  for (const p of pieces) {
    if (/^[\u0591-\u05c7]$/.test(p) && clusters.length) clusters[clusters.length - 1] += p;
    else clusters.push(p);
  }
  return clusters.reverse().join("");
}

/** Final letters where they belong (see the module comment). */
export function fixFinalForms(text: string): string {
  return text.replace(HEB_WORD, (w, at: number, all: string) => {
    // An acronym, a quote or a hyphenated prefix keeps its last letter as written
    // (מ״מ, עמ׳, כ-35%), but a final letter before its end is wrong everywhere.
    const after = all[at + w.length] ?? "";
    const prefix = /[-־–]/.test(after); // ב-, כ-, ה-: prefix letters, never final
    const marked = MARKED.test(all[at - 1] ?? "") || MARKED.test(after);
    const chars = Array.from(w);
    let lastLetter = -1;
    for (let k = chars.length - 1; k >= 0; k--)
      if (HEB_LETTER.test(chars[k])) {
        lastLetter = k;
        break;
      }
    return chars
      .map((c, k) => {
        if (k === lastLetter) return prefix ? (TO_REGULAR[c] ?? c) : marked || lastLetter < 1 ? c : (TO_FINAL[c] ?? c);
        return TO_REGULAR[c] ?? c;
      })
      .join("");
  });
}

/** The whole text in logical order, line by line (lines keep their order). */
export function fixVisualText(text: string): string {
  return text
    .split(/(\r?\n)/)
    .map((part) => (part === "\n" || part === "\r\n" ? part : fixVisualLine(part)))
    .join("");
}

export interface PdfHebrewFix {
  kind: PdfHebrewKind;
  fixed: string;
}

/** The fix to offer for pasted text, or null when it reads fine (or the fix would change nothing). */
export function suggestPdfHebrewFix(text: string): PdfHebrewFix | null {
  if (!HEB_LETTER.test(text) || text.length > 200_000) return null;
  const { kind } = analyzePdfHebrew(text);
  if (!kind) return null;
  const fixed = kind === "reversed" ? fixVisualText(text) : fixFinalForms(text);
  return fixed === text ? null : { kind, fixed };
}
