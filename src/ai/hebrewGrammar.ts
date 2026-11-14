/**
 * Hebrew grammar and style, entirely on this device (plan W5.3) — the
 * common errors spelling cannot see:
 *
 *   HE_NUM_GENDER    שלוש ילדים → שלושה ילדים, חמישה בנות → חמש בנות (3–10)
 *   HE_TWO_GENDER    שתי ילדים → שני ילדים, שניים ספרים → שני ספרים
 *   HE_HACHI_BEYOTER הכי טוב ביותר → הטוב ביותר / הכי טוב
 *   HE_ET_IM         נפגשתי את דני → נפגשתי עם דני; דיברתי אותו → איתו
 *   HE_SMICHUT_DEF   הבית ספר → בית הספר (the article goes on the last noun)
 *   HE_ANI_FUTURE    אני ילך → אני אלך
 *   HE_PLEONASM      חזר שוב → חזר; בערך כמאה → כמאה
 *   HE_REGISTER      (academic / legal) הכי חשוב → חשוב ביותר; בגלל ש → מכיוון ש
 *
 * Rules are precise rather than greedy: a noun whose gender the lexicon
 * cannot tell is left alone. Each finding carries an i18n message key and
 * a short explanation key, translated on the main thread (the rules also
 * run in the spelling worker). An optional local model (./grammarRanker.ts)
 * may re-rank or drop findings; the rules never need it.
 */
import type { GrammarMatch } from "./grammar";

export type GrammarLevel = "everyday" | "academic" | "legal";

export interface HebrewGrammarMatch extends GrammarMatch {
  /** i18n key of the message and of the one-line explanation; `vars` fill both. */
  messageKey: string;
  explainKey: string;
  vars?: Record<string, string>;
}

const W = "[\\u05D0-\\u05EA]";
const NOT_LETTER_BEFORE = `(?<![\\u05D0-\\u05EA\\u0591-\\u05C7'"\\u05F3\\u05F4])`;
const NOT_LETTER_AFTER = `(?![\\u05D0-\\u05EA\\u0591-\\u05C7'"\\u05F3\\u05F4])`;

/* ── Noun gender (plural forms) ────────────────────────────────────────── */

/** Feminine plurals in -ים / -יים and masculine plurals in -ות: the regular suffix would mislead. */
const FEM_IM = new Set(["נשים", "שנים", "ערים", "ביצים", "מילים", "אבנים", "פעמים", "צפרדעים", "יונים", "שעורים", "עזים", "רחלים", "ידיים", "רגליים", "עיניים", "אוזניים", "שיניים", "נעליים", "ברכיים", "כנפיים", "שעורות"]);
const MASC_OT = new Set(["אבות", "חלונות", "שולחנות", "מקומות", "קירות", "לילות", "כוחות", "רחובות", "חלומות", "קולות", "שמות", "לוחות", "ארונות", "כיסאות", "כסאות", "פתרונות", "רעיונות", "מוסדות", "זיכרונות", "עקרונות", "שבועות", "דורות", "אוצרות", "גבולות", "מזלות", "עורות", "יתרונות", "חסרונות", "קורות", "ארגזות", "מכתבות", "אורות", "שופרות", "תנורות"]);
/** Plurals that are not nouns a number can count, or whose gender varies: never judged. */
const UNSURE = new Set(["מים", "שמיים", "שמים", "חיים", "פנים", "רחמים", "אופניים", "מכנסיים", "משקפיים", "צהריים", "אחרים", "אחרות", "שונים", "שונות", "רבים", "רבות", "כאלה", "אלו", "אלה"]);

/** "masc" | "fem" | null for a plural noun (without prefixes). */
export function pluralGender(noun: string): "masc" | "fem" | null {
  if (UNSURE.has(noun) || noun.length < 3) return null;
  if (FEM_IM.has(noun)) return "fem";
  if (MASC_OT.has(noun)) return "masc";
  if (noun.endsWith("יים")) return null; // duals: mostly feminine body parts, listed above; others unsure
  if (noun.endsWith("ים")) return "masc";
  if (noun.endsWith("ות")) return "fem";
  return null;
}

/* ── Numbers ───────────────────────────────────────────────────────────── */

/** 3–10 (and 2) in their feminine and masculine counting forms. */
const NUMBERS: Array<[fem: string, masc: string]> = [
  ["שלוש", "שלושה"],
  ["ארבע", "ארבעה"],
  ["חמש", "חמישה"],
  ["שש", "שישה"],
  ["שבע", "שבעה"],
  ["תשע", "תשעה"],
  ["עשר", "עשרה"],
];
const NUM_GENDER = new Map<string, { gender: "fem" | "masc"; other: string }>();
for (const [f, m] of NUMBERS) {
  NUM_GENDER.set(f, { gender: "fem", other: m });
  NUM_GENDER.set(m, { gender: "masc", other: f });
}
NUM_GENDER.set("חמשה", { gender: "masc", other: "חמש" });
NUM_GENDER.set("ששה", { gender: "masc", other: "שש" });
const ALL_NUMBER_WORDS = new Set([...NUM_GENDER.keys(), "שמונה", "אחד", "אחת", "שני", "שתי", "שניים", "שתיים", "שתים", "עשרים", "שלושים", "מאה", "אלף"]);

/* ── Verbs that take עם ("with"), not את ───────────────────────────────── */

const WITH_VERBS = new Set(
  [
    "נפגשתי נפגשת נפגש נפגשה נפגשנו נפגשתם נפגשתן נפגשו נפגשים נפגשות להיפגש ייפגש ניפגש אפגש",
    "דיברתי דיברת דיבר דיברה דיברנו דיברתם דיברו מדבר מדברת מדברים מדברות לדבר אדבר ידבר נדבר",
    "שוחחתי שוחחת שוחח שוחחה שוחחנו שוחחו משוחח משוחחת לשוחח",
    "התייעצתי התייעצת התייעץ התייעצה התייעצנו התייעצו להתייעץ",
    "התווכחתי התווכחת התווכח התווכחה התווכחנו התווכחו להתווכח",
    "התכתבתי התכתבת התכתב התכתבה התכתבנו התכתבו להתכתב",
    "התחתנתי התחתנת התחתן התחתנה התחתנו להתחתן",
    "נפרדתי נפרדת נפרד נפרדה נפרדנו נפרדו להיפרד",
  ]
    .join(" ")
    .split(" "),
);
const OBJECT_TO_WITH: Record<string, string> = { "אותי": "איתי", "אותך": "איתך", "אותו": "איתו", "אותה": "איתה", "אותנו": "איתנו", "אתכם": "איתכם", "אתכן": "איתכן", "אותם": "איתם", "אותן": "איתן" };

/* ── Construct compounds: the article goes on the last noun ────────────── */

const COMPOUNDS: Array<[string, string]> = [
  ["בית", "ספר"], ["בית", "חולים"], ["בית", "משפט"], ["בית", "כנסת"], ["בית", "מרקחת"], ["בית", "קפה"], ["בית", "מלון"], ["בית", "קברות"],
  ["כדור", "רגל"], ["כדור", "סל"], ["כדור", "יד"], ["יום", "הולדת"], ["יום", "העצמאות"], ["ראש", "ממשלה"], ["ראש", "עיר"], ["עורך", "דין"], ["רואה", "חשבון"],
  ["תפוח", "אדמה"], ["חדר", "אוכל"], ["חדר", "שינה"], ["חדר", "אמבטיה"], ["שם", "משפחה"], ["ארוחת", "בוקר"], ["ארוחת", "ערב"], ["ארוחת", "צהריים"], ["מכונת", "כביסה"],
  ["תעודת", "זהות"], ["כרטיס", "אשראי"], ["מגרש", "חניה"], ["תחנת", "דלק"], ["תחנת", "רכבת"], ["שדה", "תעופה"], ["בית", "מדרש"], ["גן", "ילדים"], ["סוף", "שבוע"], ["חוף", "ים"],
];
const COMPOUND_MAP = new Map(COMPOUNDS.map(([a, b]) => [`${a} ${b}`, [a, b] as const]));

/* ── אני + future 3rd person ───────────────────────────────────────────── */

const FUTURE_I: Record<string, string> = {
  "ילך": "אלך", "יבוא": "אבוא", "יגיד": "אגיד", "יעשה": "אעשה", "יכתוב": "אכתוב", "ישלח": "אשלח", "יקנה": "אקנה", "יתקשר": "אתקשר", "ידבר": "אדבר", "יחזור": "אחזור",
  "יספר": "אספר", "יבדוק": "אבדוק", "יקרא": "אקרא", "ישאל": "אשאל", "ייתן": "אתן", "יביא": "אביא", "יסיים": "אסיים", "יעזור": "אעזור", "ישב": "אשב", "יאכל": "אוכל",
};

/* ── The checker ───────────────────────────────────────────────────────── */

function push(out: HebrewGrammarMatch[], offset: number, length: number, id: string, category: string, replacements: string[], vars: Record<string, string> = {}): void {
  out.push({ offset, length, message: `grammar.he.${id}`, replacements, rule: { id: `HE_${id}`, category }, messageKey: `grammar.he.${id}`, explainKey: `grammar.he.${id}.why`, vars });
}

/** Strip one prefix letter cluster for a lexicon lookup ("והילדים" → "ילדים"). */
function bare(word: string): { prefix: string; base: string } {
  const m = /^(ו?(?:ש|כש|מ|ל|ב|כ)?ה?)(.+)$/.exec(word);
  return m && m[1] && m[2].length >= 3 ? { prefix: m[1], base: m[2] } : { prefix: "", base: word };
}

export function hebrewGrammar(text: string, level: GrammarLevel = "everyday"): HebrewGrammarMatch[] {
  const out: HebrewGrammarMatch[] = [];
  const words = [...text.matchAll(new RegExp(`${NOT_LETTER_BEFORE}${W}+(?:["\\u05F4]${W}+)?`, "gu"))].map((m) => ({ w: m[0], at: m.index! }));

  for (let i = 0; i < words.length - 1; i++) {
    const { w, at } = words[i];
    const next = words[i + 1];
    const between = text.slice(at + w.length, next.at);
    const adjacent = /^\s+$/.test(between) && !between.includes("\n\n");
    const prev = words[i - 1];
    const prevAdjacent = prev && /^\s+$/.test(text.slice(prev.at + prev.w.length, at));

    // Numbers 3–10 with a plural noun: the counting form has the opposite-looking gender.
    const num = NUM_GENDER.get(w);
    if (num && adjacent && !(prevAdjacent && (ALL_NUMBER_WORDS.has(prev.w) || ALL_NUMBER_WORDS.has(bare(prev.w).base) || ALL_NUMBER_WORDS.has(prev.w.slice(1)))) && !ALL_NUMBER_WORDS.has(next.w) && !(prevAdjacent && /^(יום|בשעה|שעה|פרק|סעיף|עמוד|מספר|כיתה|קומה)$/.test(prev.w))) {
      const g = pluralGender(next.w);
      if (g && g !== num.gender) push(out, at, w.length, "NUM_GENDER", "GRAMMAR", [num.other], { number: w, fix: num.other, noun: next.w });
    }

    // Two: שני (m) / שתי (f); the counting forms שניים / שתיים do not come before a noun.
    if (/^(שני|שתי|שניים|שתיים)$/.test(w) && adjacent && !(prevAdjacent && /^(יום|ביום|כיתה|בכיתה|הפרק|פרק|מקום|במקום|ה?דור|סוג)$/.test(prev.w))) {
      const g = pluralGender(next.w);
      const want = g === "masc" ? "שני" : g === "fem" ? "שתי" : null;
      if (want && want !== w) push(out, at, w.length, "TWO_GENDER", "GRAMMAR", [want], { number: w, fix: want, noun: next.w });
    }

    // Verbs of meeting / talking take עם.
    if (WITH_VERBS.has(bare(w).base) || WITH_VERBS.has(w)) {
      if (adjacent && next.w === "את" && words[i + 2] && /^\s+$/.test(text.slice(next.at + next.w.length, words[i + 2].at))) push(out, next.at, next.w.length, "ET_IM", "GRAMMAR", ["עם"], { verb: w, wrong: "את", fix: "עם" });
      else if (adjacent && OBJECT_TO_WITH[next.w]) push(out, next.at, next.w.length, "ET_IM", "GRAMMAR", [OBJECT_TO_WITH[next.w]], { verb: w, wrong: next.w, fix: OBJECT_TO_WITH[next.w] });
    }

    // The article on the first noun of a construct compound.
    if (adjacent) {
      const m = /^(ו?(?:ש|כש|מ)?)ה(.+)$/.exec(w);
      if (m) {
        const pair = COMPOUND_MAP.get(`${m[2]} ${next.w}`);
        if (pair) push(out, at, next.at + next.w.length - at, "SMICHUT_DEF", "GRAMMAR", [`${m[1]}${pair[0]} ה${pair[1]}`], { wrong: `${w} ${next.w}`, fix: `${m[1]}${pair[0]} ה${pair[1]}` });
      }
    }

    // אני + a third-person future form.
    if (w === "אני" && adjacent && FUTURE_I[next.w]) push(out, next.at, next.w.length, "ANI_FUTURE", "GRAMMAR", [FUTURE_I[next.w]], { wrong: next.w, fix: FUTURE_I[next.w] });

    // Pleonasm: חזר שוב.
    if (/^(ל?חזור|חזר|חזרה|חזרתי|חזרנו|חזרו|חוזר|חוזרת|חוזרים|אחזור|יחזור|נחזור)$/.test(w) && adjacent && next.w === "שוב") push(out, next.at - between.length, between.length + next.w.length, "PLEONASM", "STYLE", [""], { wrong: `${w} שוב`, fix: w });
    if (w === "בערך" && adjacent && /^כ/.test(next.w) && next.w.length > 2) push(out, at, next.at - at, "PLEONASM", "STYLE", [""], { wrong: `בערך ${next.w}`, fix: next.w });
  }

  // הכי … ביותר within three words.
  for (const m of text.matchAll(new RegExp(`${NOT_LETTER_BEFORE}הכי\\s+(${W}+(?:\\s+${W}+){0,2}?)\\s+ביותר${NOT_LETTER_AFTER}`, "gu"))) {
    const inner = m[1];
    push(out, m.index!, m[0].length, "HACHI_BEYOTER", "GRAMMAR", [`${inner} ביותר`, `הכי ${inner}`], { phrase: m[0], fix: `${inner} ביותר` });
  }

  // Register: academic and legal writing.
  if (level !== "everyday") {
    const taken = (o: number) => out.some((x) => x.offset <= o && o < x.offset + x.length);
    for (const m of text.matchAll(new RegExp(`${NOT_LETTER_BEFORE}הכי\\s+(${W}+)${NOT_LETTER_AFTER}`, "gu"))) {
      if (!taken(m.index!)) push(out, m.index!, m[0].length, "REGISTER_HACHI", "STYLE", [`${m[1]} ביותר`], { phrase: m[0], fix: `${m[1]} ביותר` });
    }
    // "בגלל שדרוג" is "because of an upgrade": only a ש that opens a clause.
    for (const m of text.matchAll(new RegExp(`${NOT_LETTER_BEFORE}בגלל\\s?ש(?=(?:הוא|היא|הם|הן|אני|אנחנו|אתה|את|אתם|זה|זו|יש|אין|לא|כבר|עוד|כל|לא)${NOT_LETTER_AFTER})`, "gu"))) push(out, m.index!, m[0].length, "REGISTER_BIGLAL", "STYLE", ["מכיוון ש"], { phrase: m[0], fix: "מכיוון ש" });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Apply the first replacement of each finding (for tests and the "fix all" action). */
export function applyFirst(text: string, matches: GrammarMatch[]): string {
  let s = text;
  for (const m of [...matches].sort((a, b) => b.offset - a.offset)) s = s.slice(0, m.offset) + (m.replacements[0] ?? "") + s.slice(m.offset + m.length);
  return s;
}

/**
 * The grammar findings merged into the spelling ones (the worker and the
 * main-thread fallback both call this): a grammar finding replaces a
 * spelling or hint finding on the same words.
 */
export function mergeGrammar(spelling: GrammarMatch[], text: string, level: GrammarLevel): GrammarMatch[] {
  const grammar = hebrewGrammar(text, level);
  const overlaps = (a: GrammarMatch, b: GrammarMatch) => a.offset < b.offset + b.length && b.offset < a.offset + a.length;
  return [...grammar, ...spelling.filter((m) => !grammar.some((g) => overlaps(g, m)))].sort((a, b) => a.offset - b.offset);
}

export const GRAMMAR_LEVELS: readonly GrammarLevel[] = ["everyday", "academic", "legal"];
