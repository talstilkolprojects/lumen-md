/**
 * Ladino (Judeo-Spanish) in two scripts (plan W7.9): the Latin spelling of
 * the Aki Yerushalayim review (the one the Autoridad Nasionala del Ladino
 * uses) and the Hebrew-letter spelling of the Ladino press (solitreo and
 * Rashi type, printed today in square letters). Lumen's own rules (MIT).
 *
 * Latin → Hebrew is a rule per letter: vowels a = א (ה at the end of a
 * word), e and i = י, o and u = ו; a word starting with a vowel takes an
 * alef; the sounds Spanish letters lack take a geresh (ג׳ dj, צ׳ ch, ז׳ j,
 * ש sh, ב׳ v, פ׳ f, ד׳ dh); y between vowels is a double yud.
 *
 * Hebrew → Latin cannot be exact: י is e or i and ו is o or u. The rule
 * picks the likelier reading (final י is "e", final ו is "o", inside a
 * word י is "i" and ו is "o") and says how many vowels it had to guess, so
 * the UI can ask for a check. Hebrew words (Hebraisms) are not changed.
 */

const GERESH = "\u05F3";

export type LadinoScript = "latin" | "hebrew";

/** Which script a Ladino text is in. */
export function ladinoScript(text: string): LadinoScript {
  const heb = (text.match(/[א-ת]/g) ?? []).length;
  const lat = (text.match(/[A-Za-zÑñ]/g) ?? []).length;
  return heb > lat ? "hebrew" : "latin";
}

const FINALS: Record<string, string> = { "כ": "ך", "מ": "ם", "נ": "ן", "פ": "ף", "צ": "ץ" };

function latinWord(word: string): string {
  const w = word.toLowerCase();
  const toks: string[] = [];
  for (let i = 0; i < w.length; ) {
    const two = w.slice(i, i + 2);
    if (["dj", "ch", "sh", "dh", "gh", "ny"].includes(two)) {
      toks.push(two);
      i += 2;
    } else toks.push(w[i++]);
  }
  const vowel = (t: string | undefined) => t !== undefined && /^[aeiou]$/.test(t);
  let out = "";
  toks.forEach((t, k) => {
    const last = k === toks.length - 1;
    if (k === 0 && vowel(t)) out += "א";
    switch (t) {
      case "a":
        out += k === 0 ? "" : last ? "ה" : "א";
        break;
      case "e":
      case "i":
        out += "י";
        break;
      case "o":
      case "u":
        out += "ו";
        break;
      case "y":
        out += vowel(toks[k - 1]) && vowel(toks[k + 1]) ? "יי" : "י";
        break;
      case "b":
        out += "ב";
        break;
      case "v":
        out += "ב" + GERESH;
        break;
      case "ch":
        out += "צ" + GERESH;
        break;
      case "d":
        out += "ד";
        break;
      case "dh":
        out += "ד" + GERESH;
        break;
      case "dj":
        out += "ג" + GERESH;
        break;
      case "f":
        out += "פ" + GERESH;
        break;
      case "g":
        out += "ג";
        break;
      case "gh":
        out += "ג" + GERESH; // rare: the Arabic/Turkish ğ
        break;
      case "h":
        out += "ה";
        break;
      case "j":
        out += "ז" + GERESH;
        break;
      case "k":
      case "q":
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
      case "ñ":
      case "ny":
        out += "ני";
        break;
      case "p":
        out += "פ";
        break;
      case "r":
        out += "ר";
        break;
      case "s":
        out += "ס";
        break;
      case "sh":
        out += "ש";
        break;
      case "t":
        out += "ט";
        break;
      case "x":
        out += "ח";
        break;
      case "z":
        out += "ז";
        break;
      default:
        out += t;
    }
  });
  // A final letter takes its final form (צ׳ and פ׳ keep the open form with their geresh).
  return out.replace(/([כמנפצ])$/, (c) => FINALS[c] ?? c);
}

/** Aki Yerushalayim Latin → Hebrew letters. */
export function ladinoLatinToHebrew(text: string): string {
  return text.normalize("NFC").replace(/[A-Za-zÑñ]+/g, latinWord);
}

export interface LadinoReading {
  text: string;
  /** Vowels read from an ambiguous letter (י as e/i, ו as o/u): the reading may need a check. */
  guessed: number;
}

/** Hebrew-letter Ladino → Aki Yerushalayim Latin, with the count of vowels it had to guess. */
export function ladinoHebrewToLatin(text: string): LadinoReading {
  let guessed = 0;
  const out = text.replace(/[א-ת][א-ת\u05F3']*/g, (raw) => {
    const w = raw.replace(/'/g, GERESH);
    let s = "";
    for (let i = 0; i < w.length; i++) {
      const c = w[i];
      const ger = w[i + 1] === GERESH;
      const last = i + (ger ? 2 : 1) >= w.length;
      const first = i === 0;
      if (ger) i++;
      switch (c) {
        case "א":
          // An alef before a vowel letter at the start only carries it; elsewhere it is "a".
          s += first && /[וי]/.test(w[i + 1] ?? "") ? "" : "a";
          break;
        case "ה":
          s += last ? "a" : "h";
          break;
        case "י":
          if (w[i + 1] === "י") {
            s += "y";
            i++;
          } else if (first) s += "y"; // y between vowels is written יי, so a single yud inside a word is a vowel
          else {
            s += last ? "e" : "i";
            guessed++;
          }
          break;
        case "ו":
          s += "o";
          guessed++;
          break;
        case "ב":
          s += ger ? "v" : "b";
          break;
        case "ג":
          s += ger ? "dj" : "g";
          break;
        case "ד":
          s += ger ? "dh" : "d";
          break;
        case "ז":
          s += ger ? "j" : "z";
          break;
        case "צ":
        case "ץ":
          s += ger ? "ch" : "ts";
          break;
        case "פ":
        case "ף":
          s += ger ? "f" : "p";
          break;
        case "ח":
        case "כ":
        case "ך":
          s += "h";
          break;
        case "ט":
        case "ת":
          s += "t";
          break;
        case "ק":
          s += "k";
          break;
        case "ל":
          s += "l";
          break;
        case "מ":
        case "ם":
          s += "m";
          break;
        case "נ":
        case "ן":
          if (w[i + 1] === "י" && /[אוי]/.test(w[i + 2] ?? "")) {
            s += "ny";
            i++;
          } else s += "n";
          break;
        case "ס":
          s += "s";
          break;
        case "ש":
          s += "sh";
          break;
        case "ר":
          s += "r";
          break;
        case "ע":
          s += "e";
          guessed++;
          break;
        default:
          s += c;
      }
    }
    return s;
  });
  return { text: out, guessed };
}
