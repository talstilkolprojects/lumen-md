/**
 * The sync key as Hebrew words (plan W4.19): what a non-technical user writes
 * down or photographs instead of inventing a passphrase.
 *
 * 12 random bytes → 12 words from a list of 256 everyday Hebrew nouns (one
 * byte each, 96 bits), plus a 13th word that checks the first 12 (one byte of
 * their SHA-256), so a typo is caught before it becomes "wrong passphrase".
 * The words joined by single spaces *are* the vault passphrase, run through
 * the vault KDF like any passphrase (kdf.ts).
 *
 * Typing is forgiving: niqqud, punctuation, extra spaces and final letters
 * (ך ם ן ף ץ written as כ מ נ פ צ, or the other way round) are ignored.
 */

import { bs, randomBytes, sha256Hex, toB64u, utf8 } from "../bytes";

/** 256 words, no two the same once final letters are folded. */
export const WORD_LIST: readonly string[] = "אבן אגם אגס אדמה אוזן אוויר אוכל אור אורז אחות אילן איש אמא אגוז אננס אסם ארגז ארון ארמון ארנב אש אשכול בננה בגד בובה בוטן בוקר ביצה בית בלון בקבוק בריכה ברז ברק גבינה גבעה גדר גוזל גומי גזר גינה גיטרה גלגל גל גמל גשם גשר דבש דג דגל דוב דלת דלעת דף דקל דשא הר הדס ורד זאב זברה זהב זית זמר זנב חבל חג חול חומה חוף חותם חלב חלון חלום חמור חסה חציל חצר חרוז חתול טבעת טווס טחנה טל טלה טיל יד ים יער ירח ירק יונה יין ילד כדור כובע כוכב כוס כינור כיסא כלב כנרת כפית כפר כרוב כתר כרית לבנה לוח לחם לימון לטאה לפיד מגדל מדבר מזלג מחברת מטוס מים מכונה מלח מלון מנורה מסמר מעיל מערה מפה מפתח מראה מרק מתנה נבל נהר נוצה נחל נחש נמר נמל נעל נר נשר סבון סבתא סוכר סוס סיר סל סלע סנאי ספל ספר ספינה סרט עגלה עוגה עז עט עיגול עין עכבר ענן ענב עץ ערב עשב פיל פנס פעמון פרח פרפר פרה פסנתר פיתה פלפל צב צבע צדף צלחת צנון צפור צפרדע קוף קיר קן קנה קערה קשת קרון קרח קש רגל רדיו רוח רחוב רכבת רמון רקפת שבלול שולחן שועל שזיף שטיח שיר שמיים שמש שן שעון שפן שקד שק שרשרת תאנה תוף תות תיק תמר תנור תפוח תרנגול תרמיל תבלין תקליט תמנון תוכי אלמוג ארז ברוש גפן דולפין יעל כבש כיפה כנף לביא מגן מוז נבט סחלב עדשה צמיד קקטוס רימון שושנה תכלת בלוט זרע חמנייה ינשוף כורסה מנגו עמק פיסטוק קינמון רעם שלג תרד".split(" ");

export const KEY_WORDS = 12;

const FINALS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
const fold = (w: string) => w.replace(/[ךםןףץ]/g, (c) => FINALS[c]);
const INDEX = new Map(WORD_LIST.map((w, i) => [fold(w), i]));

/** One typed word, as the list holds it (null when it isn't a list word). */
export function normalizeWord(input: string): string | null {
  const w = input.normalize("NFC").replace(/[\u0591-\u05C7]/g, "").replace(/[^\u05D0-\u05EA]/g, "");
  const i = INDEX.get(fold(w));
  return i === undefined ? null : WORD_LIST[i];
}

async function checkWord(bytes: Uint8Array): Promise<string> {
  const hex = await sha256Hex(bytes);
  return WORD_LIST[parseInt(hex.slice(0, 2), 16)];
}

/** A new sync key: 13 words (12 random, 1 check). */
export async function newRecoveryWords(): Promise<string[]> {
  const bytes = randomBytes(KEY_WORDS);
  return [...Array.from(bytes, (b) => WORD_LIST[b]), await checkWord(bytes)];
}

export type ParsedWords =
  | { ok: true; words: string[]; passphrase: string }
  | { ok: false; reason: "count" | "unknown" | "check"; at?: number };

/** Read typed or pasted words back; says which word is wrong. */
export async function parseRecoveryWords(input: string): Promise<ParsedWords> {
  const raw = input.split(/[\s,،.;·]+/).filter(Boolean);
  if (raw.length !== KEY_WORDS + 1) return { ok: false, reason: "count" };
  const words: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = normalizeWord(raw[i]);
    if (!w) return { ok: false, reason: "unknown", at: i };
    words.push(w);
  }
  const bytes = new Uint8Array(words.slice(0, KEY_WORDS).map((w) => WORD_LIST.indexOf(w)));
  if ((await checkWord(bytes)) !== words[KEY_WORDS]) return { ok: false, reason: "check" };
  return { ok: true, words, passphrase: words.join(" ") };
}

/**
 * The relay space token for these words: a domain-separated hash, so a
 * second device needs nothing but the words. The relay stores only a hash
 * of the token; it can't derive the passphrase from it (96 random bits).
 */
export async function relayToken(passphrase: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bs(utf8(`lumen-relay-token v1|${passphrase.normalize("NFC")}`))));
  return toB64u(digest);
}

/** Which word (1-based) the user is asked to type back to show they saved the key. */
export function checkPosition(words: readonly string[], seed = Math.random()): number {
  return 1 + Math.floor(seed * Math.min(words.length, KEY_WORDS));
}
