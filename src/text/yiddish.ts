/**
 * Yiddish text (plan W7.9): the YIVO standard's spelling as Unicode, the
 * YIVO romanisation in both directions, and telling Yiddish from Hebrew.
 * Pure and dependency-free; the rules below are Lumen's own (MIT), written
 * from the YIVO transcription table (YIVO Institute, "Yiddish alphabet").
 *
 * Unicode: a pointed letter can arrive precomposed (U+FB2E אַ) or as a
 * base plus a point (א + U+05B7), and the digraphs as ligatures (U+05F0 װ,
 * U+05F1 ױ, U+05F2 ײ). `normalizeYiddish` makes one form of each: base +
 * point, and digraphs as two letters (ײַ → ייַ), which is how the YIVO
 * Hunspell word list and most typed text spell them.
 *
 * Words of Hebrew and Aramaic origin keep their Hebrew spelling in YIVO
 * (שבת is "shabes", not "שאַבעס"); a letter-by-letter rule cannot know
 * that, so the common ones are a table here (`HEBRAISMS`), read both ways.
 */

const PATAKH = "\u05B7";
const KAMATS = "\u05B8";
const HIRIK = "\u05B4";
const DAGESH = "\u05BC";
const RAFE = "\u05BF";
const SHIN_DOT = "\u05C1";
const SIN_DOT = "\u05C2";
const MAQAF = "\u05BE";

/** Precomposed forms and ligatures → base letters + points. */
export function normalizeYiddish(text: string): string {
  return text
    .normalize("NFD") // U+FB1D..FB4F decompose to base + point
    .replace(/\u05F0/g, "וו")
    .replace(/\u05F1/g, "וי")
    .replace(/\u05F2/g, "יי")
    .replace(/\uFB1F/g, "יי" + PATAKH); // \u05F2\u05B7 (Yiddish yod yod patah)
}

/** A word or paragraph in Hebrew script that is Yiddish rather than Hebrew. */
export function isYiddishText(text: string): boolean {
  const s = normalizeYiddish(text);
  const letters = (s.match(/[א-ת]/g) ?? []).length;
  if (letters < 2) return false;
  // Pointed alef (אַ אָ) and the YIVO digraphs with points are Yiddish spelling, not Hebrew.
  const marks = (s.match(/א[\u05B7\u05B8]|יי\u05B7|פ\u05BF|ב\u05BF|י\u05B4/g) ?? []).length;
  if (marks >= 1 && marks / Math.max(1, s.split(/\s+/).length) >= 0.05) return true;
  // Ayin as the vowel "e" is far more frequent in Yiddish (about 1 letter in 10) than in Hebrew.
  const ayin = (s.match(/ע/g) ?? []).length;
  const ending = (s.match(/\p{L}(?:ען|ער|עס|ט)(?=$|[^\p{L}\p{M}])/gu) ?? []).length;
  const words = Math.max(1, (s.match(/[א-ת][א-ת\u0591-\u05C7]*/g) ?? []).length);
  return ayin / letters >= 0.07 && ending / words >= 0.2;
}

/**
 * Common words of Hebrew and Aramaic origin, as YIVO spells and romanises
 * them. Lumen's own selection (MIT); each is in YIVO's spelling.
 */
export const HEBRAISMS: ReadonlyArray<readonly [yiddish: string, latin: string]> = [
  ["שבת", "shabes"], ["אמת", "emes"], ["חכם", "khokhem"], ["חתונה", "khasene"], ["חבֿר", "khaver"], ["חבֿרים", "khaveyrim"],
  ["מלחמה", "milkhome"], ["עולם", "oylem"], ["ספֿר", "seyfer"], ["ספֿרים", "sforim"], ["רבי", "rebe"], ["תּורה", "toyre"], ["חסיד", "khosid"], ["חסידים", "khsidim"],
  ["שלום", "sholem"], ["משפּחה", "mishpokhe"], ["צדיק", "tsadek"], ["חלום", "kholem"], ["ישיבֿה", "yeshive"], ["כּלה", "kale"],
  ["חתן", "khosn"], ["מזל", "mazl"], ["חוצפּה", "khutspe"], ["נשמה", "neshome"], ["תּכלית", "takhles"], ["אפֿשר", "efsher"],
  ["מסתּמא", "mistame"], ["דווקא", "davke"], ["כּמעט", "kimat"], ["שׂימחה", "simkhe"], ["ייִשובֿ", "yishev"], ["מצווה", "mitsve"],
  ["מעשׂה", "mayse"], ["עבֿודה", "avoyde"], ["אמונה", "emune"], ["גלות", "goles"], ["אַחרון", "akhren"], ["סוף", "sof"],
  ["ספֿק", "sofek"], ["בטחון", "bitokhn"], ["חשבון", "kheshbn"], ["עצה", "eytse"], ["צרה", "tsore"], ["צרות", "tsores"],
  ["שׂכל", "seykhl"], ["חכמה", "khokhme"], ["תּלמיד", "talmid"], ["תּלמידים", "talmidim"], ["מלמד", "melamed"], ["חדר", "kheyder"],
  ["בית־מדרש", "besmedresh"], ["בית־עולם", "besoylem"], ["תּפֿילה", "tfile"], ["סידור", "sider"], ["מחזור", "makhzer"],
  ["יום־טובֿ", "yontef"], ["פּסח", "peysekh"], ["פּורים", "purim"], ["חנוכּה", "khanike"], ["שבֿועות", "shvues"], ["סוכּות", "sukes"],
  ["ראש־השנה", "rosheshone"], ["יום־כּיפּור", "yom-kiper"], ["ירושלים", "yerusholaim"], ["ארץ־ישׂראל", "erets-yisroel"], ["ישׂראל", "yisroel"], ["משה", "moyshe"],
  ["אבֿרהם", "avrom"], ["יצחק", "yitskhok"], ["יעקבֿ", "yankev"], ["דבֿורה", "dvoyre"], ["רחל", "rokhl"], ["שׂרה", "sore"],
  ["קהילה", "kehile"], ["זכּרון", "zikorn"], ["חיים", "khayim"], ["כּבֿוד", "koved"],
  ["סבֿרא", "svore"], ["ממש", "mamesh"], ["לחיים", "lekhayim"], ["חלילה", "kholile"], ["חסד", "khesed"], ["רחמנות", "rakhmones"],
];

const HEB_TO_LAT = new Map<string, string>();
const LAT_TO_HEB = new Map<string, string>();
for (const [y, l] of HEBRAISMS) {
  // Lumen's own forms are written with combining points; match either.
  const k = normalizeYiddish(y);
  HEB_TO_LAT.set(k, l);
  LAT_TO_HEB.set(l, k);
}

const VOWEL_LETTER = /[אעוי]/;

/** One Yiddish word (normalised, letters and points only) → YIVO romanisation. */
function wordToLatin(w: string): string {
  const known = HEB_TO_LAT.get(w);
  if (known !== undefined) return known;
  let out = "";
  let i = 0;
  const at = (k: number) => w[k] ?? "";
  const pointAfter = (k: number) => (/[\u05B0-\u05C2]/.test(at(k + 1)) ? at(k + 1) : "");
  while (i < w.length) {
    const c = w[i];
    const p = pointAfter(i);
    const step = (s: string, n: number) => {
      out += s;
      i += n;
    };
    switch (c) {
      case "א":
        if (p === PATAKH) step("a", 2);
        else if (p === KAMATS) step("o", 2);
        else step("", 1); // shtumer alef
        break;
      case "ב":
        if (p === RAFE) step("v", 2);
        else step("b", p === DAGESH ? 2 : 1);
        break;
      case "ג":
        step("g", 1);
        break;
      case "ד":
        if (at(i + 1) === "ז" && at(i + 2) === "ש") step("dzh", 3);
        else step("d", 1);
        break;
      case "ה":
        step("h", 1);
        break;
      case "ו":
        if (p === DAGESH) step("u", 2);
        else if (at(i + 1) === "ו" && pointAfter(i + 1) !== DAGESH) step("v", 2);
        else if (at(i + 1) === "י" && pointAfter(i + 1) !== HIRIK) step("oy", 2);
        else step("u", 1);
        break;
      case "ז":
        if (at(i + 1) === "ש") step("zh", 2);
        else step("z", 1);
        break;
      case "ח":
        step("kh", 1);
        break;
      case "ט":
        if (at(i + 1) === "ש") step("tsh", 2);
        else step("t", 1);
        break;
      case "י": {
        if (p === HIRIK) {
          step("i", 2);
          break;
        }
        if (at(i + 1) === "י") {
          // ייַ = ay; יי = ey; but י before יִ is the consonant y (ייִדיש = yidish).
          if (pointAfter(i + 1) === PATAKH) step("ay", 3);
          else if (pointAfter(i + 1) === HIRIK) step("y", 1);
          else step("ey", 2);
          break;
        }
        // A consonant before a vowel letter or a pointed alef, at the start of a word or after a vowel.
        const next = at(i + 1 + (p ? 1 : 0));
        const beforeVowel = next !== "" && VOWEL_LETTER.test(next) && !(next === "ו" && at(i + 2) === "ו" && pointAfter(i + 2) !== DAGESH);
        step(beforeVowel ? "y" : "i", 1);
        break;
      }
      case "כ":
        step(p === DAGESH ? "k" : "kh", p === DAGESH ? 2 : 1);
        break;
      case "ך":
        step("kh", 1);
        break;
      case "ל":
        step("l", 1);
        break;
      case "מ":
      case "ם":
        step("m", 1);
        break;
      case "נ":
      case "ן":
        step("n", 1);
        break;
      case "ס":
        step("s", 1);
        break;
      case "ע":
        step("e", 1);
        break;
      case "פ":
        if (p === RAFE) step("f", 2);
        else if (p === DAGESH) step("p", 2);
        else step(i === w.length - 1 ? "f" : "p", 1);
        break;
      case "ף":
        step("f", 1);
        break;
      case "צ":
      case "ץ":
        step("ts", 1);
        break;
      case "ק":
        step("k", 1);
        break;
      case "ר":
        step("r", 1);
        break;
      case "ש":
        if (p === SIN_DOT) step("s", 2);
        else step("sh", p === SHIN_DOT ? 2 : 1);
        break;
      case "ת":
        step(p === DAGESH ? "t" : "s", p === DAGESH ? 2 : 1);
        break;
      case MAQAF:
        step("-", 1);
        break;
      default:
        // A point we do not romanise, or anything else: points vanish, the rest stays.
        step(/[\u0591-\u05C7]/.test(c) ? "" : c, 1);
    }
  }
  return out;
}

/** Yiddish in Hebrew letters → YIVO romanisation. Non-Hebrew text is left as it is. */
export function yiddishToLatin(text: string): string {
  return normalizeYiddish(text).replace(/[א-ת][א-ת\u0591-\u05C7\u05BE]*/g, (w) => wordToLatin(w.replace(/\u05BE$/, "")) + (w.endsWith(MAQAF) ? "-" : ""));
}

/** One lower-case YIVO word → Yiddish letters (base + points). */
function wordToYiddish(word: string): string {
  const known = LAT_TO_HEB.get(word);
  if (known !== undefined) return known;
  const tokens: string[] = [];
  let i = 0;
  const take = (...opts: string[]) => {
    for (const o of opts)
      if (word.startsWith(o, i)) {
        i += o.length;
        return o;
      }
    return null;
  };
  while (i < word.length) {
    const t = take("dzh", "tsh", "zh", "kh", "sh", "ts", "ay", "ey", "oy") ?? word[i++];
    tokens.push(t);
  }
  let out = "";
  const isVowelTok = (t: string | undefined) => t !== undefined && /^(a|e|i|o|u|ay|ey|oy)$/.test(t);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    const last = k === tokens.length - 1;
    // Word-initial u, i, oy, ey, ay are written after a shtumer alef.
    if (k === 0 && /^(u|i|oy|ey|ay)$/.test(t)) out += "א";
    switch (t) {
      case "a":
        out += "א" + PATAKH;
        break;
      case "o":
        out += "א" + KAMATS;
        break;
      case "e":
        out += "ע";
        break;
      case "i":
        // Khirek yud next to a vowel letter or after the consonant y; plain yud otherwise.
        out += prev === "y" || isVowelTok(prev) || isVowelTok(next) || next === "y" ? "י" + HIRIK : "י";
        break;
      case "u":
        // Melupm vov next to a vov or before a yud, so it cannot be read as v or oy.
        out += prev === "v" || next === "v" || next === "i" || next === "y" || prev === "u" ? "ו" + DAGESH : "ו";
        break;
      case "ay":
        out += "יי" + PATAKH;
        break;
      case "ey":
        out += "יי";
        break;
      case "oy":
        out += "וי";
        break;
      case "b":
        out += "ב";
        break;
      case "v":
        out += "וו";
        break;
      case "g":
        out += "ג";
        break;
      case "d":
        out += "ד";
        break;
      case "h":
        out += "ה";
        break;
      case "z":
        out += "ז";
        break;
      case "zh":
        out += "זש";
        break;
      case "dzh":
        out += "דזש";
        break;
      case "kh":
        out += last ? "ך" : "כ";
        break;
      case "t":
        out += "ט";
        break;
      case "tsh":
        out += "טש";
        break;
      case "y":
        out += "י";
        break;
      case "k":
        out += "ק";
        break;
      case "l":
        out += "ל";
        break;
      case "m":
        out += last ? "ם" : "מ";
        break;
      case "n":
        out += last ? "ן" : "נ";
        break;
      case "s":
        out += "ס";
        break;
      case "p":
        out += "פ" + DAGESH;
        break;
      case "f":
        out += last ? "ף" : "פ" + RAFE;
        break;
      case "ts":
        out += last ? "ץ" : "צ";
        break;
      case "r":
        out += "ר";
        break;
      case "sh":
        out += "ש";
        break;
      case "-":
        out += MAQAF;
        break;
      default:
        out += t;
    }
  }
  return out;
}

/** YIVO romanisation → Yiddish letters (base + points). Words keep their order; case is ignored. */
export function latinToYiddish(text: string): string {
  return text.replace(/[A-Za-z]+(?:-[A-Za-z]+)*/g, (w) => {
    const lower = w.toLowerCase();
    const whole = LAT_TO_HEB.get(lower);
    if (whole !== undefined) return whole;
    return lower.split("-").map(wordToYiddish).join(MAQAF);
  });
}

