/**
 * Israeli law names as people write them (plan W7.5):
 *
 *   "חוק הגנת הפרטיות", "חוק הגנת הפרטיות, התשמ״א-1981", "חוק הגנת הפרטיות התשמ"א",
 *   "לחוק הגנת הפרטיות (1981)", "חוק יסוד: כבוד האדם וחירותו", "ח״י: כבוד האדם וחירותו",
 *   "חוק-יסוד כבוד האדם", "[[חוק:הגנת הפרטיות]]", with or without niqqud, with
 *   full or defective spelling (הבנייה / הבניה, השוויון / השויון).
 *
 * All of them reduce to one comparison key (`lawKey`), and `matchLaw` picks
 * the law from a list of Knesset records (KNS_IsraelLaw and the alternative
 * names in KNS_IsraelLawName). Nothing here touches the network.
 */

export interface LawRecord {
  /** KNS_IsraelLaw.IsraelLawID */
  id: number;
  /** KNS_IsraelLaw.Name, as the Knesset writes it. */
  name: string;
  isBasicLaw?: boolean;
  /** Other names of the same law (KNS_IsraelLawName.Name). */
  aliases?: string[];
}

export interface LawMatch {
  law: LawRecord;
  /** 1 for the same key; lower for a partial name (every typed word found in the law's name). */
  score: number;
}

const POINTS = /[֑-ׇ]/g;
const FINALS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };

/** Niqqud off, quotes and dashes unified, spaces collapsed. */
export function cleanLawText(s: string): string {
  return s
    .replace(/[־]/g, "-") // maqaf
    .replace(POINTS, "")
    .replace(/[״“”„]/g, '"')
    .replace(/[׳‘’`´]/g, "'")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** A Hebrew year (תשמ"א, התשמ״א) or a Gregorian one (1981), when the name carries one. */
export function lawYear(s: string): { hebrew: string | null; gregorian: number | null } {
  const c = cleanLawText(s);
  const heb = HEB_YEAR.exec(c);
  const greg = /(?:^|\D)(1[89]\d\d|20\d\d)(?:\D|$)/.exec(c);
  return { hebrew: heb ? heb[1].replace(/["']/g, "") : null, gregorian: greg ? Number(greg[1]) : null };
}

/** A Hebrew year of the State's laws: תש"י, התשמ"א, תשמ״א (quoted), or a bare תשמא right before its Gregorian year. */
const HEB_YEAR = /(?:^|[\s,(])ה?(תש[א-ת]{0,2}["'][א-ת]|תש[א-ת]{1,3}(?=\s*-\s*(?:1[89]|20)\d\d))(?=$|[\s,)\-])/;
const HEB_YEAR_TAIL = /,?\s*ה?(?:תש[א-ת]{0,2}["'][א-ת]|תש[א-ת]{1,3}(?=\s*-\s*(?:1[89]|20)\d\d))\s*(?:-\s*(?:1[89]\d\d|20\d\d))?\s*$/;

/**
 * Names in common use that are not the law's title (the Knesset lists
 * official alternative names in KNS_IsraelLawName; these are the ones
 * people write that it does not).
 */
const NICKNAMES: Record<string, string> = {
  "חוק הלאום": "חוק-יסוד: ישראל - מדינת הלאום של העם היהודי",
  "חוק יסוד: הלאום": "חוק-יסוד: ישראל - מדינת הלאום של העם היהודי",
};

const BASIC = /^(?:חוק[- ]?(?:ה)?יסוד|ח"י|חו"י|ח' ?י)\s*[:\-–]?\s*/;

/** The comparison key: "basic:" for a Basic Law, then the law's own words, folded (no year, no prefixes, defective spelling). */
export function lawKey(input: string): string {
  let s = cleanLawText(input);
  const wiki = /^\[\[\s*חוק\s*:\s*([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(s);
  if (wiki) s = /^חוק/.test(wiki[1].trim()) ? wiki[1].trim() : `חוק ${wiki[1].trim()}`;
  const nick = NICKNAMES[s.replace(/^(?:ו?ש?[לבמכ]?|ו)(?=חוק)/, "")];
  if (nick) s = nick;
  // A preposition or conjunction glued to the first word: לחוק, בחוק, וחוק, שבחוק, מחוק, כחוק.
  s = s.replace(/^(?:ו?ש?[לבמכ]?|ו)(?=חוק)/, "");
  let basic = false;
  const b = BASIC.exec(s);
  if (b) {
    basic = true;
    s = s.slice(b[0].length);
  } else s = s.replace(/^חוק\s+/, "").replace(/^ה?חוק$/, "");
  s = s
    .replace(/\[[^\]]*\]/g, " ") // [נוסח משולב], [נוסח חדש]
    .replace(/\(\s*(?:1[89]\d\d|20\d\d)\s*\)/g, " ")
    .replace(HEB_YEAR_TAIL, " ")
    .replace(/,?\s*-?\s*(?:1[89]\d\d|20\d\d)\s*$/, " ")
    .replace(/["',.:;!?–\-]/g, " ")
    .replace(/[()]/g, " ");
  const words = s
    .split(" ")
    .filter(Boolean)
    .map(foldWord)
    .filter((w) => w && w !== "ו");
  return (basic ? "basic:" : "") + words.join(" ");
}

/** Final letters folded; ו and י after the first letter dropped (full and defective spelling meet). */
function foldWord(w: string): string {
  const f = w.replace(/[ךםןףץ]/g, (c) => FINALS[c] ?? c);
  if (!/^[א-ת]+$/.test(f)) return f.toLowerCase();
  return f[0] + f.slice(1).replace(/[וי]/g, "");
}

function wordsOf(key: string): string[] {
  return key.replace(/^basic:/, "").split(" ").filter(Boolean);
}

/** Strip one Hebrew prefix letter group from a word (for partial matches: "וחירותו" ~ "חרתו"). */
function looseEq(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (w: string) => w.replace(/^[והבלמכש]{1,2}(?=[א-ת]{3})/, "");
  return strip(a) === strip(b);
}

/**
 * The law a name refers to, or null. An exact key wins; otherwise the law
 * whose name contains every typed word (in order-free form), the shortest
 * such name first, with a matching year preferred.
 */
export function matchLaw(input: string, laws: readonly LawRecord[]): LawMatch | null {
  const key = lawKey(input);
  const typed = wordsOf(key);
  if (!typed.length) return null;
  const basic = key.startsWith("basic:");
  const year = lawYear(input);
  let best: LawMatch | null = null;
  let bestLen = Infinity;
  for (const law of laws) {
    for (const name of [law.name, ...(law.aliases ?? [])]) {
      const k = lawKey(name);
      if (basic && !k.startsWith("basic:")) continue;
      const words = wordsOf(k);
      let score = 0;
      if (k === key || (!basic && k.replace(/^basic:/, "") === key)) score = 1;
      else if (typed.every((t) => words.some((w) => looseEq(w, t)))) score = 0.5 + 0.4 * (typed.length / words.length);
      if (!score) continue;
      const y = lawYear(name);
      if (year.gregorian && y.gregorian && year.gregorian !== y.gregorian) score -= 0.3;
      if (year.hebrew && y.hebrew && year.hebrew !== y.hebrew) score -= 0.3;
      if (score <= 0.3) continue;
      if (!best || score > best.score || (score === best.score && words.length < bestLen)) {
        best = { law, score };
        bestLen = words.length;
      }
    }
  }
  return best;
}

/** `[[חוק:...]]` links and "חוק …" phrases in a note, as raw names (for suggestions and the notes index). */
export function lawMentionsIn(markdown: string): string[] {
  const out: string[] = [];
  const text = cleanLawText(markdown);
  for (const m of text.matchAll(/\[\[\s*חוק\s*:[^\]]+\]\]/g)) out.push(m[0]);
  const re = /(?:^|[\s("'])((?:ו?ש?[לבמכ])?(?:חוק[- ]?יסוד\s*:?\s*|חוק\s+)[א-ת][^.;\n\]]*?)(?=[.;\n]|$|\]\])/g;
  for (const m of text.matchAll(re)) {
    if (/^\[\[/.test(m[1])) continue;
    out.push(m[1].trim());
  }
  return out;
}

/** The OData search term for a name: its longest word, unfolded (Name contains it as written). */
export function searchTermOf(input: string): string {
  const s = cleanLawText(input)
    .replace(/^\[\[\s*חוק\s*:\s*/, "")
    .replace(/\]\]$/, "")
    .replace(BASIC, "")
    .replace(/^(?:ו?ש?[לבמכ]?)חוק\s+/, "")
    .replace(/,.*$/, "")
    .replace(/["'()[\]:]/g, " ");
  const words = s.split(/\s+/).filter((w) => /^[א-ת]{2,}$/.test(w) && !/^ה?תש[א-ת]{0,3}$/.test(w));
  return words.sort((a, b) => b.length - a.length)[0] ?? "";
}
