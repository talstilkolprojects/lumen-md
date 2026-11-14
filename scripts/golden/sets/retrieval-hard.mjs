/**
 * retrieval/hard (plan W7.13): a Hebrew retrieval set hard enough to tell
 * embedding models apart. 7.6 found BM25 alone at nDCG@10 = 1.0 on HeQ:
 * the HeQ questions share their words with their paragraph. Here every
 * question is rewritten the way people actually ask —
 *
 *   paraphrase   a word replaced by a synonym (the paragraph's word is gone)
 *   inflection   a prefix letter (ו ה ב ל מ ש כ) added to a word the paragraph has as is
 *   spelling     full ↔ defective spelling (כתיב מלא/חסר: ו and י added or dropped)
 *   acronym      an acronym expanded, or the words contracted (צה״ל ↔ צבא ההגנה לישראל)
 *   loanword     a Hebrew term ↔ its English or transliterated form (מחשב ↔ קומפיוטר)
 *
 * The questions are HeQ v1.1 test questions other than the one retrieval/heq
 * uses, so the two sets never share a query. 300 questions, a held-out 30 %
 * by the split seed; plus the cross-lingual probes of W5.28.
 *
 * `hardenQuery` is pure and deterministic (seeded), so the set is rebuilt
 * byte-identical: node scripts/golden/build-retrieval-hard.mjs
 */
import { rankKey } from "../../lib/golden.mjs";

export const KINDS = ["paraphrase", "inflection", "spelling", "acronym", "loanword"];

/** Hebrew synonyms (both directions are used). */
export const SYNONYMS = [
  ["גדול", "רחב"], ["קטן", "זעיר"], ["מתי", "באיזו שנה"], ["למה", "מדוע"], ["איך", "כיצד"], ["חשוב", "מהותי"],
  ["הראשון", "הבכור"], ["עיר", "כרך"], ["מדינה", "ארץ"], ["ספר", "חיבור"], ["נולד", "בא לעולם"], ["מת", "נפטר"],
  ["הקים", "ייסד"], ["בנה", "הקים"], ["כתב", "חיבר"], ["שיר", "זמר"], ["מלחמה", "קרב"], ["חברה", "תאגיד"],
  ["שנה", "עונה"], ["מספר", "כמות"], ["מקום", "אתר"], ["אנשים", "בני אדם"], ["ילדים", "צאצאים"], ["עבודה", "תעסוקה"],
];
export const ACRONYMS = [
  ["צה״ל", "צבא ההגנה לישראל"], ["ארה״ב", "ארצות הברית"], ["בריה״מ", "ברית המועצות"], ["או״ם", "האומות המאוחדות"],
  ["ח״כ", "חבר כנסת"], ["ביה״ס", "בית הספר"], ["רה״מ", "ראש הממשלה"], ["ת״א", "תל אביב"], ["ד״ר", "דוקטור"], ["אוניב׳", "אוניברסיטה"],
];
export const LOANWORDS = [
  ["מחשב", "קומפיוטר"], ["מרשתת", "אינטרנט"], ["טלפון", "phone"], ["תוכנה", "software"], ["רשת", "network"], ["מדע", "science"],
  ["טכנולוגיה", "technology"], ["אלגוריתם", "algorithm"], ["מוזיקה", "music"], ["סרט", "film"], ["פיזיקה", "physics"], ["כלכלה", "economy"],
];
const PREFIXES = ["ו", "ה", "ב", "ל", "מ", "ש", "כ"];

const words = (q) => q.split(/(\s+)/);
const isHeb = (w) => /^[א-ת]{3,}$/.test(w);

/** Replace a whole word or phrase (optionally after one prefix letter), never part of a word. */
function swapPairs(q, pairs) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [a, b] of pairs) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const re = new RegExp(`(^|[\\s"'(״])([ובלמשכה]?)${esc(from)}(?=$|[\\s?.,!:;)"'״])`);
      if (re.test(q)) return q.replace(re, (_m, pre, pfx) => `${pre}${pfx}${to}`);
    }
  }
  return null;
}

/** Content words of the question that also appear in the paragraph: rewriting those is what makes word matching fail. */
function shared(ws, context) {
  const idx = ws.map((w, i) => (isHeb(w) && w.length >= 3 ? i : -1)).filter((i) => i >= 0);
  const inCtx = context ? idx.filter((i) => context.includes(ws[i])) : [];
  return inCtx.length ? inCtx : idx;
}
const pick = (idx, seed, q) => idx[parseInt(rankKey(seed, q).slice(0, 6), 16) % idx.length];

/** Full ↔ defective: drop an inner ו/י (to defective), or add a י after the first letter (to full). */
function respell(q, seed, context) {
  const ws = words(q);
  const idx = shared(ws, context).filter((i) => ws[i].length >= 4);
  if (!idx.length) return null;
  const i = pick(idx, seed, q);
  const w = ws[i];
  const inner = w.slice(1, -1);
  const m = /[וי]/.exec(inner);
  ws[i] = m ? w[0] + inner.slice(0, m.index) + inner.slice(m.index + 1) + w.at(-1) : w[0] + "י" + w.slice(1);
  return ws.join("");
}

/** Inflection: a prefix letter (ו ה ב ל מ ש כ) added to a word the paragraph has as is. Only added: removing one could cut a root letter. */
function inflect(q, seed, context) {
  const ws = words(q);
  const idx = shared(ws, context);
  if (!idx.length) return null;
  const i = pick(idx, seed, q);
  const w = ws[i];
  const p = w.startsWith("ה") ? "ו" : PREFIXES[parseInt(rankKey(seed, w).slice(0, 4), 16) % PREFIXES.length];
  ws[i] = p + w;
  return ws.join("");
}

/** One hard rewrite of a question; the kind is tried first, then the others, so each question changes. */
export function hardenQuery(query, kind, seed, context = "") {
  // The specific rewrites first (they apply rarely), the general ones last.
  const order = [kind, ...["acronym", "loanword", "paraphrase", "spelling", "inflection"].filter((k) => k !== kind)];
  for (const k of order) {
    const out =
      k === "paraphrase" ? swapPairs(query, SYNONYMS) : k === "acronym" ? swapPairs(query, ACRONYMS) : k === "loanword" ? swapPairs(query, LOANWORDS) : k === "spelling" ? respell(query, `${seed}:${k}`, context) : inflect(query, `${seed}:${k}`, context);
    if (out && out !== query) return { query: out, kind: k };
  }
  return { query: inflect(query, `${seed}:fallback`, context) ?? query, kind: "inflection" };
}

/**
 * The hard items from HeQ paragraphs (the `heq` pool): every usable
 * question but the one retrieval/heq picked, rewritten, `n` in all, then
 * split dev / held-out by the seed.
 */
export function buildHard(pool, { n = 300, heldOut = 0.3, seed, exclude = new Set(), corpus = [] }) {
  const textOf = new Map(corpus.map((d) => [d.id, d.text]));
  const cands = [];
  for (const p of pool.items) for (const q of p.qas) if (!exclude.has(q.id)) cands.push({ p, q });
  cands.sort((a, b) => (rankKey(seed, a.q.id) < rankKey(seed, b.q.id) ? -1 : 1));
  const items = cands.slice(0, n).map(({ p, q }, i) => {
    const h = hardenQuery(q.question, KINDS[i % KINDS.length], `${seed}:${q.id}`, textOf.get(p.id) ?? "");
    return { id: `hard-${String(i + 1).padStart(3, "0")}`, query: h.query, original: q.question, kind: h.kind, relevant: [p.id], sameArticle: p.sameArticle ?? [], heqId: q.id };
  });
  const cut = Math.round(items.length * (1 - heldOut));
  return { dev: items.slice(0, cut), heldout: items.slice(cut) };
}
