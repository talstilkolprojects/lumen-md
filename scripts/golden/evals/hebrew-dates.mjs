/**
 * Harness for the hebrew-dates golden set (plan 4.12, daily notes).
 *
 * Scores the same conversion the app uses for `{{hebrewDate}}` and the
 * calendar: the browser's ICU Hebrew calendar through
 * `Intl.DateTimeFormat("he-u-ca-hebrew")` at noon UTC — see hebrewParts()
 * in src/daily/dailyNote.ts, which this mirrors (a plain .mjs cannot import
 * the TypeScript source). No calendar library.
 *
 *   to-hebrew     Gregorian → { day, month (Hebrew name), year } and the
 *                 text the app writes, `ז׳ בחשוון תשפ״ז` (hebrewDate())
 *   to-gregorian  the Hebrew text → the Gregorian day, found by searching
 *                 the days of that Hebrew year
 *
 * Returns accuracies only; no item, input or output is ever reported.
 */

const HE_PARTS = new Intl.DateTimeFormat("he-u-ca-hebrew", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const DAY_MS = 86_400_000;

function partsAt(ms) {
  const p = Object.fromEntries(HE_PARTS.formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return { day: Number(p.day), month: p.month, year: Number(p.year) };
}

function noonOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : NaN;
}

const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const LETTERS = [[400, "ת"], [300, "ש"], [200, "ר"], [100, "ק"], [90, "צ"], [80, "פ"], [70, "ע"], [60, "ס"], [50, "נ"], [40, "מ"], [30, "ל"], [20, "כ"], [10, "י"], [9, "ט"], [8, "ח"], [7, "ז"], [6, "ו"], [5, "ה"], [4, "ד"], [3, "ג"], [2, "ב"], [1, "א"]];
const VALUE = Object.fromEntries(LETTERS.map(([v, l]) => [l, v]));

/** Hebrew numerals, as gematria() in src/daily/dailyNote.ts. */
export function gematria(n) {
  let s = "";
  let rest = n;
  while (rest > 0) {
    if (rest === 15 || rest === 16) {
      s += rest === 15 ? "טו" : "טז";
      break;
    }
    const [v, l] = LETTERS.find(([v]) => v <= rest);
    s += l;
    rest -= v;
  }
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}

const numeral = (s) => [...s.replace(/[׳״'"]/g, "")].reduce((a, c) => (VALUE[c] ? a + VALUE[c] : NaN), 0);

/** As hebrewDate() in src/daily/dailyNote.ts. */
export function hebrewText(iso) {
  const p = toHebrew(iso);
  return p ? `${gematria(p.day)} ב${p.month} ${gematria(p.year % 1000)}` : null;
}

/** `ז׳ בחשוון תשפ״ז` → { day: 7, monthHe: "חשוון", year: 5787 }, or null. */
export function parseHebrewText(text) {
  const m = /^(\S+) ב(.+) (\S+)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const day = numeral(m[1]);
  const year = 5000 + numeral(m[3]);
  return Number.isInteger(day) && Number.isInteger(year) ? { day, monthHe: m[2], year } : null;
}

export function toHebrew(iso) {
  const ms = noonOf(iso);
  return Number.isFinite(ms) ? partsAt(ms) : null;
}

/** The Gregorian day of a Hebrew date, or null. Hebrew year Y starts in autumn of Y − 3761. */
export function toGregorian({ day, monthHe, year }) {
  if (!Number.isInteger(day) || !Number.isInteger(year)) return null;
  const start = Date.UTC(year - 3761, 7, 1, 12); // 1 August before Rosh Hashana
  for (let i = 0; i < 430; i++) {
    const ms = start + i * DAY_MS;
    const p = partsAt(ms);
    if (p.year === year && p.month === monthHe && p.day === day) return isoOf(ms);
  }
  return null;
}

export async function score({ items }) {
  const tally = { "to-hebrew": [0, 0], "to-gregorian": [0, 0] };
  for (const it of items) {
    const want = it.hebrew ?? {};
    const dir = it.direction === "to-gregorian" ? "to-gregorian" : "to-hebrew";
    let ok = false;
    if (dir === "to-hebrew") {
      const got = toHebrew(it.gregorian);
      ok = !!got && got.day === want.day && got.month === want.monthHe && got.year === want.year && hebrewText(it.gregorian) === it.hebrewText;
    } else {
      const parsed = parseHebrewText(it.hebrewText);
      ok = !!parsed && toGregorian(parsed) === it.gregorian;
    }
    tally[dir][0] += ok ? 1 : 0;
    tally[dir][1] += 1;
  }
  const rate = ([a, n]) => (n ? a / n : NaN);
  const all = [tally["to-hebrew"][0] + tally["to-gregorian"][0], tally["to-hebrew"][1] + tally["to-gregorian"][1]];
  return { exact: rate(all), to_hebrew_exact: rate(tally["to-hebrew"]), to_gregorian_exact: rate(tally["to-gregorian"]) };
}
