/**
 * Vocalized Hebrew → IPA for a neural voice (plan W2.6), in the spirit of
 * Phonikud (arXiv 2506.12311): the input is text with niqqud (from the
 * niqqud service, 6.3 / W2.5), the output is Modern Israeli Hebrew phonemes
 * with the stress marked (ˈ), the alphabet Piper-style voices use.
 *
 * Lumen's own rules, not Phonikud's code (no GPL, no eSpeak). What they do:
 * - בּ כּ פּ with dagesh → b k p, without → v χ f; שׁ → ʃ, שׂ → s; ר → ʁ;
 *   ח → χ; צ → ts; ג׳ ז׳ צ׳ → dʒ ʒ tʃ.
 * - Matres lectionis: וֹ → o, וּ → u, י after hiriq / tsere → silent;
 *   final ה without mappiq → silent; א and ע carry only their vowel
 *   (a glottal stop between two vowels).
 * - Shva: vocal (e) at the start of a word before י ל מ נ ר or a doubled
 *   letter, after another shva, or on the first of two identical letters;
 *   silent otherwise (Modern Hebrew drops it: סְפָרִים → sfaʁim).
 * - Furtive patah (רוּחַ → ʁuaχ) is not a syllable of its own.
 * - Stress: the letter marked with ole (U+05AB, Phonikud's stress mark),
 *   else the last syllable, else (segolates, מֶלֶךְ) the one before it.
 *
 * Pure; no data files.
 */

const SHVA = "\u05B0";
const HATAF_SEGOL = "\u05B1";
const HATAF_PATAH = "\u05B2";
const HATAF_QAMATS = "\u05B3";
const HIRIQ = "\u05B4";
const TSERE = "\u05B5";
const SEGOL = "\u05B6";
const PATAH = "\u05B7";
const QAMATS = "\u05B8";
const HOLAM = "\u05B9";
const HOLAM_HASER = "\u05BA";
const QUBUTS = "\u05BB";
const DAGESH = "\u05BC";
const SIN_DOT = "\u05C2";
const QAMATS_QATAN = "\u05C7";
const STRESS = "\u05AB";

const VOWEL_OF: Record<string, string> = {
  [HATAF_SEGOL]: "e",
  [HATAF_PATAH]: "a",
  [HATAF_QAMATS]: "o",
  [HIRIQ]: "i",
  [TSERE]: "e",
  [SEGOL]: "e",
  [PATAH]: "a",
  [QAMATS]: "a",
  [HOLAM]: "o",
  [HOLAM_HASER]: "o",
  [QUBUTS]: "u",
  [QAMATS_QATAN]: "o",
};

const FINAL: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
const isLetter = (c: string) => c >= "א" && c <= "ת";
const isMark = (c: string) => (c >= "\u0591" && c <= "\u05C7" && c !== "\u05BE" && c !== "\u05C0" && c !== "\u05C3" && c !== "\u05C6") || c === "\u05F3" || c === "'";

interface Letter {
  ch: string;
  marks: string;
}

interface Unit {
  c: string;
  v: string;
  /** Can carry the stress (a real syllable nucleus). */
  syllable: boolean;
  stressMark: boolean;
  /** The letter it came from. */
  letter: number;
}

function lettersOf(word: string): Letter[] {
  const out: Letter[] = [];
  for (const c of word.normalize("NFD")) {
    if (isLetter(c)) out.push({ ch: c, marks: "" });
    else if (isMark(c) && out.length) out[out.length - 1].marks += c;
  }
  return out;
}

const has = (l: Letter | undefined, m: string) => !!l && l.marks.includes(m);
const vowelOf = (l: Letter | undefined): string => {
  if (!l) return "";
  for (const m of l.marks) if (VOWEL_OF[m]) return VOWEL_OF[m];
  return "";
};
/** A vav or yod that is only a vowel letter (no consonant of its own). */
function isMater(ls: Letter[], i: number): boolean {
  const l = ls[i];
  const prev = ls[i - 1];
  const prevVowel = vowelOf(prev);
  if (l.ch === "ו") {
    const own = [...l.marks].filter((m) => VOWEL_OF[m] && m !== HOLAM && m !== HOLAM_HASER);
    if (has(l, HOLAM) && !own.length && !prevVowel) return true; // holam male
    if (has(l, DAGESH) && !vowelOf(l) && (!prev || !prevVowel)) return true; // shuruk
    return false;
  }
  if (l.ch === "י") return !vowelOf(l) && !has(l, SHVA) && !has(l, DAGESH) && (has(prev, HIRIQ) || has(prev, TSERE));
  return false;
}

function consonant(l: Letter, last: boolean): string {
  const base = FINAL[l.ch] ?? l.ch;
  const dagesh = has(l, DAGESH);
  const geresh = l.marks.includes("\u05F3") || l.marks.includes("'");
  switch (base) {
    case "א":
    case "ע":
      return "";
    case "ב":
      return dagesh ? "b" : "v";
    case "ג":
      return geresh ? "dʒ" : "g";
    case "ד":
      return "d";
    case "ה":
      return last && !dagesh && !vowelOf(l) ? "" : "h";
    case "ו":
      return "v";
    case "ז":
      return geresh ? "ʒ" : "z";
    case "ח":
      return "χ";
    case "ט":
      return "t";
    case "י":
      return "j";
    case "כ":
      return dagesh ? "k" : "χ";
    case "ל":
      return "l";
    case "מ":
      return "m";
    case "נ":
      return "n";
    case "ס":
      return "s";
    case "פ":
      return dagesh ? "p" : "f";
    case "צ":
      return geresh ? "tʃ" : "ts";
    case "ק":
      return "k";
    case "ר":
      return "ʁ";
    case "ש":
      return has(l, SIN_DOT) ? "s" : "ʃ";
    case "ת":
      return "t";
    default:
      return "";
  }
}

const SONORANT_ONSET = new Set(["י", "ל", "מ", "נ", "ר"]);
const GUTTURAL = new Set(["א", "ה", "ח", "ע"]);

function shvaIsVocal(ls: Letter[], i: number): boolean {
  if (i === ls.length - 1) return false;
  const base = (l: Letter | undefined) => (l ? (FINAL[l.ch] ?? l.ch) : "");
  if (base(ls[i]) === base(ls[i + 1])) return true; // first of two identical letters
  if (i === 0) return SONORANT_ONSET.has(base(ls[i])) || SONORANT_ONSET.has(base(ls[i + 1])) || GUTTURAL.has(base(ls[i + 1]));
  if (has(ls[i - 1], SHVA) && i >= 2) return true; // second of two shvas
  return false;
}

function unitsOf(ls: Letter[]): Unit[] {
  const units: Unit[] = [];
  ls.forEach((l, i) => {
    const last = i === ls.length - 1;
    const stressMark = has(l, STRESS);
    if (isMater(ls, i)) {
      const v = l.ch === "ו" ? (has(l, DAGESH) ? "u" : "o") : "";
      if (v) units.push({ c: "", v, syllable: true, stressMark, letter: i });
      else if (stressMark && units.length) units[units.length - 1].stressMark = true;
      return;
    }
    let c = consonant(l, last);
    let v = vowelOf(l);
    if (l.ch === "ו" && has(l, HOLAM) && vowelOf(ls[i - 1])) v = "o"; // "vo" after a vowel
    if (!v && has(l, SHVA) && shvaIsVocal(ls, i)) v = "e";
    // Glottal stop for א / ע with a vowel between two vowels (שְׁאֵלָה → ʃeʔela).
    if ((l.ch === "א" || l.ch === "ע") && v && i > 0 && units.length && units[units.length - 1].v) c = "ʔ";
    const furtive = last && v === "a" && has(l, PATAH) && (l.ch === "ח" || l.ch === "ע" || (l.ch === "ה" && has(l, DAGESH)));
    if (furtive) {
      units.push({ c: "", v: "a", syllable: false, stressMark: false, letter: i });
      units.push({ c, v: "", syllable: false, stressMark: false, letter: i });
      return;
    }
    units.push({ c, v, syllable: !!v, stressMark, letter: i });
  });
  return units;
}

function stressedIndex(units: Unit[], ls: Letter[]): number {
  const syl = units.map((u, i) => (u.syllable ? i : -1)).filter((i) => i >= 0);
  if (!syl.length) return -1;
  const marked = units.findIndex((u) => u.stressMark && u.syllable);
  if (marked >= 0) return marked;
  const lastSyl = syl[syl.length - 1];
  const tail = units[units.length - 1];
  // Segolates: a final syllable closed by a consonant whose vowel is segol after segol / tsere / holam
  // (מֶלֶךְ, סֵפֶר, בֹּקֶר; not לָכֶם), hiriq on yod after patah (בַּיִת), or patah on a
  // guttural after patah (נַעַר) → stress the one before.
  if (syl.length >= 2 && tail !== units[lastSyl] && tail.c && !tail.v) {
    const li = units[lastSyl].letter;
    const l = ls[li];
    const prev = ls[li - 1];
    const before = ls[units[syl[syl.length - 2]].letter];
    const segolate =
      (has(l, SEGOL) && (has(before, SEGOL) || has(before, TSERE) || has(before, HOLAM))) ||
      (l.ch === "י" && has(l, HIRIQ) && has(prev, PATAH)) ||
      (has(l, PATAH) && GUTTURAL.has(l.ch) && has(prev, PATAH));
    if (segolate) return syl[syl.length - 2];
  }
  return lastSyl;
}

/** One vocalized Hebrew word → IPA with its stress. Non-Hebrew text is returned as is. */
export function wordToIpa(word: string): string {
  const ls = lettersOf(word);
  if (!ls.length) return word;
  const units = unitsOf(ls);
  const s = stressedIndex(units, ls);
  if (s < 0 || units.filter((x) => x.syllable).length < 2) return units.map((u) => u.c + u.v).join("");
  // The mark goes before the syllable's onset: a vowel-only unit (a mater) takes the consonant before it.
  const at = !units[s].c && s > 0 && units[s - 1].c && !units[s - 1].v ? s - 1 : s;
  return units.map((u, i) => (i === at ? "ˈ" : "") + u.c + u.v).join("");
}

/** A sentence → IPA: Hebrew words converted, punctuation kept (a voice pauses on it), other words untouched. */
export function sentenceToIpa(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\u05BE/g, " ") // maqaf joins words; read them apart
    .split(/(\s+|[.,;:!?…"()«»“”–—-])/u)
    .map((tok) => (/[א-ת]/.test(tok) ? wordToIpa(tok) : tok))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does `text` carry enough niqqud to be read by these rules (≥ 60% of Hebrew letters pointed or matres)? */
export function isVocalized(text: string): boolean {
  const words = text.normalize("NFD").split(/\s+/).filter((w) => /[א-ת]/.test(w));
  if (!words.length) return false;
  const pointed = words.filter((w) => /[\u05B0-\u05BC\u05C1\u05C2\u05C7]/.test(w)).length;
  return pointed / words.length >= 0.6;
}
