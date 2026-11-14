/**
 * Numbers read out in Hebrew for the neural voice (plan W2.6). The G2P
 * (./hebrewG2P.ts) turns pointed Hebrew letters into phonemes; a digit is
 * not a letter, so without this a voice would skip "15" or "3.5%" silently.
 * Each number becomes pointed Hebrew words, so the G2P reads them with the
 * right vowels: no niqqud model is needed for them.
 *
 * Read as Modern Hebrew reads a number on its own: the feminine counting
 * forms (שָׁלוֹשׁ, אַחַת עֶשְׂרֵה), "and" before the last part of each
 * group (וּ before a labial or a shva), the construct before thousands (שְׁלוֹשֶׁת
 * אֲלָפִים). Decimals with נְקֻדָּה, "%" as אָחוּז, a minus as מִינוּס,
 * times (14:30) as hours and minutes. Above 999,999,999 the digits are read
 * one by one rather than guessed.
 */

const ONES = ["אֶפֶס", "אַחַת", "שְׁתַּיִם", "שָׁלוֹשׁ", "אַרְבַּע", "חָמֵשׁ", "שֵׁשׁ", "שֶׁבַע", "שְׁמוֹנֶה", "תֵּשַׁע"];
const TEENS = ["עֶשֶׂר", "אַחַת עֶשְׂרֵה", "שְׁתֵּים עֶשְׂרֵה", "שְׁלוֹשׁ עֶשְׂרֵה", "אַרְבַּע עֶשְׂרֵה", "חֲמֵשׁ עֶשְׂרֵה", "שֵׁשׁ עֶשְׂרֵה", "שְׁבַע עֶשְׂרֵה", "שְׁמוֹנֶה עֶשְׂרֵה", "תְּשַׁע עֶשְׂרֵה"];
const TENS = ["", "", "עֶשְׂרִים", "שְׁלוֹשִׁים", "אַרְבָּעִים", "חֲמִשִּׁים", "שִׁשִּׁים", "שִׁבְעִים", "שְׁמוֹנִים", "תִּשְׁעִים"];
const HUNDREDS = ["", "מֵאָה", "מָאתַיִם", "שְׁלוֹשׁ מֵאוֹת", "אַרְבַּע מֵאוֹת", "חֲמֵשׁ מֵאוֹת", "שֵׁשׁ מֵאוֹת", "שְׁבַע מֵאוֹת", "שְׁמוֹנֶה מֵאוֹת", "תְּשַׁע מֵאוֹת"];
/** 1–10 thousand: the construct before אֲלָפִים. */
const THOUSANDS = ["", "אֶלֶף", "אַלְפַּיִם", "שְׁלוֹשֶׁת אֲלָפִים", "אַרְבַּעַת אֲלָפִים", "חֲמֵשֶׁת אֲלָפִים", "שֵׁשֶׁת אֲלָפִים", "שִׁבְעַת אֲלָפִים", "שְׁמוֹנַת אֲלָפִים", "תִּשְׁעַת אֲלָפִים", "עֲשֶׂרֶת אֲלָפִים"];
const MILLION = "מִילְיוֹן";
const THOUSAND = "אֶלֶף";
const POINT = "נְקֻדָּה";
const PERCENT = "אָחוּז";
const MINUS = "מִינוּס";

const SHVA = "ְ";
const HATAF = /^[א-ת][ֱ-ֳ]/;

/**
 * "and" before `word`, as it is said: וּ before ב מ פ or a letter with shva,
 * וַ before a hataf patah, else "ve". That last one is written with segol
 * (וֶ): the G2P reads a shva at the start of a word as silent, and these
 * strings are only ever spoken, never shown.
 */
function and(word: string): string {
  const first = word.normalize("NFD");
  if (/^[במפ]/.test(first) || (first.length > 1 && first.slice(1).replace(/[ּׁׂ]/g, "")[0] === SHVA)) return `וּ${word}`;
  if (HATAF.test(first) && first[1] === "ֲ") return `וַ${word}`;
  return `וֶ${word}`;
}

/** Joins the parts of a number, "and" before the last one (עֶשְׂרִים וְשָׁלוֹשׁ, מֵאָה וְעֶשֶׂר). */
function join(parts: string[]): string {
  const p = parts.filter(Boolean);
  if (p.length < 2) return p[0] ?? "";
  return [...p.slice(0, -1), and(p[p.length - 1])].join(" ");
}

/** 0–999 as its parts (no "and" yet). */
function below1000(n: number): string[] {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [HUNDREDS[h]];
  if (rest >= 20) {
    parts.push(TENS[Math.floor(rest / 10)]);
    if (rest % 10) parts.push(ONES[rest % 10]);
  } else if (rest >= 10) parts.push(TEENS[rest - 10]);
  else if (rest > 0) parts.push(ONES[rest]);
  return parts.filter(Boolean);
}

/** A whole number 0–999,999,999 in words. */
export function cardinal(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) throw new RangeError("0–999,999,999");
  if (n === 0) return ONES[0];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions) parts.push(millions === 1 ? MILLION : `${millions === 2 ? "שְׁנֵי" : join(below1000(millions))} ${MILLION}`);
  if (thousands) parts.push(thousands <= 10 ? THOUSANDS[thousands] : `${join(below1000(thousands))} ${THOUSAND}`);
  // Each multiplied group has its own "and" (מָאתַיִם וַחֲמִשִּׁים אֶלֶף); the last hundreds get the number's.
  const tail = below1000(rest);
  return tail.length ? join([...parts, ...tail]) : parts.join(" ");
}

/** Digits one by one (a long number, a code). */
function digitByDigit(s: string): string {
  return Array.from(s.replace(/\D/g, ""), (d) => ONES[Number(d)]).join(" ");
}

/** One number token as Hebrew words, or null when `token` isn't one. */
export function numberWords(token: string): string | null {
  const time = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (time) {
    const [h, m] = [Number(time[1]), Number(time[2])];
    if (h > 23 || m > 59) return null;
    return m === 0 ? cardinal(h) : `${cardinal(h)} ${m < 10 ? `${ONES[0]} ${ONES[m]}` : cardinal(m)}`;
  }
  const num = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%)?$/.exec(token);
  if (!num) return null;
  const [, minus, whole, frac, pct] = num;
  const digits = whole.replace(/,/g, "");
  const n = Number(digits);
  const words = [minus ? MINUS : "", digits.length > 9 || (digits.length > 1 && digits.startsWith("0")) ? digitByDigit(digits) : cardinal(n)];
  if (frac) words.push(POINT, frac.length <= 2 && !frac.startsWith("0") ? cardinal(Number(frac)) : digitByDigit(frac));
  if (pct) words.push(PERCENT);
  return words.filter(Boolean).join(" ");
}

/** A one-letter prefix said before a number as Modern Hebrew says it there ("בֶּ-15", "לֶ-3", "וֶ-2"). */
const PREFIX: Record<string, string> = { ב: "בֶּ", ל: "לֶ", כ: "כֶּ", מ: "מִ", ה: "הַ", ו: "וֶ", ש: "שֶׁ" };

/**
 * A number between word boundaries, with an optional prefix of one or two
 * letters (ב-2025, וב2025, ל־3). A hyphen right after a boundary, with no
 * prefix, is a minus sign; after a prefix it only joins the prefix.
 */
const NUMBER_RE = /(^|[\s(\["'״׳«“])([בלכמהוש]{1,2})?([-־])?(\d{1,2}:\d{2}|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?)(?=$|[\s.,;:!?)\]"'״…»”])/g;

/** Every number in `text` written out in pointed Hebrew words; everything else untouched. */
export function expandNumbers(text: string): string {
  return text.replace(NUMBER_RE, (m, lead: string, prefix: string | undefined, dash: string | undefined, num: string) => {
    const minus = !prefix && dash === "-";
    const words = numberWords(minus ? `-${num}` : num);
    if (words === null) return m;
    const pre = prefix ? Array.from(prefix, (c) => PREFIX[c]).join("") : "";
    return `${lead}${pre}${words}`;
  });
}
