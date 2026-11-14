/**
 * Light Hebrew morphology for search (plan W2.11): what lets "תכנית" find
 * "תוכנית", "אבודות" find "אבודה" and "השקיעו" find "משקיעות" closer —
 * without a model, on comparison forms (text/hebrew normalizeForMatch:
 * niqqud stripped, final letters folded).
 *
 *  - `ktivKey`: full and defective spelling (כתיב מלא / חסר) differ in the
 *    matres lectionis ו and י inside the word, so the key keeps the first
 *    letter and drops every other ו and י: תוכנית / תכנית → תכנת,
 *    צהריים / צהרים → צהרמ.
 *  - `lemmaKeys`: one inflectional suffix off (plural, construct,
 *    possessive, past-tense person endings), then the ktiv key: אבודות /
 *    אבודה → אבד, מזורחן / מזרחנים → מזרחנ. Never below three letters.
 *  - `synonymsOf` and `englishOf`: a small curated lexicon — Hebrew words
 *    that name the same thing, and common Hebrew words' English
 *    equivalents, so a Hebrew query also finds an English note.
 *
 * All of these are weaker evidence than the word itself
 * (text/searchTokens weights them below exact forms and prefix stems), so
 * they widen recall without reordering what already matched exactly.
 * Loaded with the BM25 chunk; nothing here is in the startup bundle.
 */

const HEB_WORD = /^[א-ת]+$/;

/** The defective-spelling key: first letter kept, every later ו and י dropped. Null for a non-Hebrew or too short word. */
export function ktivKey(word: string): string | null {
  if (word.length < 3 || !HEB_WORD.test(word)) return null;
  const key = word[0] + word.slice(1).replace(/[וי]/g, "");
  // A two-letter key only from a long word (לוויין → לנ): from a short one it joins unrelated words (בית → בת).
  return key.length >= 3 || (key.length === 2 && word.length >= 5) ? key : null;
}

/**
 * Inflectional endings, longest first (comparison forms: final letters are
 * already folded, so ם is מ and ן is נ). Possessive and plural-possessive
 * endings, plural and construct, past-tense person endings.
 */
const SUFFIXES = [
  "ותיהמ", "ותיהנ", "ותיכמ", "ותיכנ", "ותינו",
  "ותיו", "ותיה", "ותיכ", "יהמ", "יהנ", "יכמ", "יכנ", "ינו", "תמ", "תנ",
  "ותי", "ימ", "ות", "תי", "נו", "המ", "הנ", "כמ", "כנ", "יו", "יה", "ית",
  "ה", "ת", "ו", "י",
];

/** Lemma-like keys of a word: each single suffix removed (at least three letters left), then its ktiv key. */
export function lemmaKeys(word: string): string[] {
  if (word.length < 4 || !HEB_WORD.test(word)) return [];
  const out = new Set<string>();
  for (const s of SUFFIXES) {
    if (!word.endsWith(s) || word.length - s.length < 3) continue;
    const key = ktivKey(word.slice(0, -s.length));
    if (key && key.length >= 2) out.add(key);
  }
  return [...out];
}

/**
 * Words that name the same thing, one group per line (comparison forms).
 * Kept small and general on purpose: a wrong synonym costs precision on
 * every vault.
 */
const SYNONYM_GROUPS: string[][] = [
  ["סמארטפונ", "סמרטפונ", "טלפונ", "פלאפונ", "סלולרי"],
  ["מחשב", "קומפיוטר"],
  ["מכונית", "רכב", "אוטו"],
  ["אפליקציה", "אפליקצייה", "יישומונ", "יישומ"],
  ["רופא", "דוקטור"],
  ["תמונה", "צילומ"],
  ["סרטונ", "וידאו"],
  ["חברה", "תאגיד", "פירמה"],
  ["כסף", "מזומנ"],
  ["מחיר", "עלות"],
  ["רכישה", "קנייה", "קניה"],
  ["תקלה", "באג"],
  ["פגישה", "ישיבה"],
  ["אוכל", "מזונ"],
  ["עבודה", "משרה", "תעסוקה"],
  ["הודעה", "מסר"],
  ["מייל", "אימייל", "דואל"],
  ["אינטרנט", "רשת"],
  ["תלמיד", "סטודנט"],
  ["מורה", "מחנכ"],
  ["ילד", "ילדה", "ילדימ"],
  ["בית", "דירה"],
  ["רחוב", "שדרה"],
  ["חנות", "מרכול", "סופר"],
  ["שיר", "זמר"],
  ["ספר", "כרכ"],
  ["האקר", "פורצ"],
  ["פרצה", "חולשה"],
  ["יזמ", "מייסד"],
];

const SYNONYMS = new Map<string, string[]>();
for (const g of SYNONYM_GROUPS) for (const w of g) SYNONYMS.set(w, g.filter((x) => x !== w));

/** Other words for the same thing (comparison form in, comparison forms out). */
export function synonymsOf(word: string): string[] {
  return SYNONYMS.get(word) ?? [];
}

/**
 * Hebrew → English equivalents of common words (comparison forms), for Hebrew queries over English notes.
 *
 * Plan W10.B6 (audit W2.11): the first rows of this table were the
 * five dev-probe queries (eval/probes/hebrew-search.json, `crosslingual`) and
 * the words of their target notes (מתכון/עוגת/שוקולד, אופניים/שרשרת/בלמים,
 * קניות/סופר, רופא/שיניים/ביטוח, טיסה/אילת…). They are removed: a lexicon
 * written from the test measures nothing. What is left is general
 * vocabulary, hand-written, with no external source. The result is
 * reported on a held-out probe (eval/probes/crosslingual-heldout-he-en.json),
 * frozen by sha256; src/__tests__/hebrewMorph.test.ts fails if a word of a
 * held-out query is added here.
 */
const HE_EN: Record<string, string[]> = {
  "חנות": ["shop", "store"], "ירושלימ": ["jerusalem"], "תל": ["tel"], "אביב": ["aviv"],
  "ספר": ["book"], "ספרימ": ["books"], "שיעור": ["lesson", "class"], "בית": ["home", "house"], "עבודה": ["work", "job"],
  "משפחה": ["family"], "ילד": ["child", "kid"], "ילדימ": ["children", "kids"], "חבר": ["friend"], "חברימ": ["friends"],
  "מחשב": ["computer"], "טלפונ": ["phone"], "סיסמה": ["password"], "מייל": ["email", "mail"], "אתר": ["website", "site"],
  "תוכנה": ["software"], "קוד": ["code"], "באג": ["bug"], "שרת": ["server"], "ענן": ["cloud"], "גיבוי": ["backup"],
  "פרויקט": ["project"], "משימה": ["task"], "משימות": ["tasks"], "רעיונ": ["idea"], "רעיונות": ["ideas"], "הערות": ["notes"],
  "סיכומ": ["summary"], "דוח": ["report"], "תקציב": ["budget"], "חשבונית": ["invoice"], "מחיר": ["price"], "כסף": ["money"],
  "חופשה": ["vacation", "holiday"], "מלונ": ["hotel"], "נסיעה": ["trip"], "טיול": ["trip", "hike"], "רכב": ["car"], "מכונית": ["car"],
  "יומ": ["day"], "שבוע": ["week"], "חודש": ["month"], "שנה": ["year"], "בוקר": ["morning"], "ערב": ["evening"], "לילה": ["night"],
  "ראשונ": ["sunday"], "שני": ["monday"], "שלישי": ["tuesday"], "רביעי": ["wednesday"], "חמישי": ["thursday"], "שישי": ["friday"], "שבת": ["saturday"],
  "בריאות": ["health"], "ספורט": ["sport", "sports"], "ריצה": ["running"], "אימונ": ["workout", "training"], "שינה": ["sleep"],
  "מוזיקה": ["music"], "סרט": ["movie", "film"], "שיר": ["song"], "תמונה": ["photo", "picture"], "צילומ": ["photo"],
  "גינה": ["garden"], "פרחימ": ["flowers"], "כלב": ["dog"], "חתול": ["cat"], "מזג": ["weather"], "אוויר": ["air", "weather"],
};

/** English equivalents of a Hebrew comparison form (also of its prefix-less form, which the caller passes). */
export function englishOf(word: string): string[] {
  return HE_EN[word] ?? [];
}
