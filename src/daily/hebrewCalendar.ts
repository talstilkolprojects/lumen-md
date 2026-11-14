/**
 * The Hebrew calendar: holidays, fasts, Rosh Chodesh and the weekly Torah
 * portion, for Israel and for the diaspora (plan W2.10).
 *
 * Our own code, MIT like the rest of Lumen — no calendar library (the usual
 * one, @hebcal/core, is GPL; gate 0.10). The arithmetic is the fixed
 * calendar of Hillel II: months from the molad of Tohu, the four
 * postponements (dehiyyot) of Rosh Hashana, and month lengths from the year
 * length. The holiday and reading rules follow the Shulchan Aruch (OC 428)
 * and Israeli law for the national days; each rule is spelled out where it
 * is applied. The browser's own ICU Hebrew calendar (Intl) is not used here,
 * so the tests can check this arithmetic against it day by day.
 *
 * Days are "fixed" day numbers (RD: 1 = Monday, 1 January of year 1 in the
 * proleptic Gregorian calendar), so nothing depends on a time zone.
 */

/* ─── Months ─────────────────────────────────────────────────────────── */

/** Months counted from Nisan, as in the Torah. Adar of a common year is ADAR_I (12). */
export const NISAN = 1;
export const IYYAR = 2;
export const SIVAN = 3;
export const TAMUZ = 4;
export const AV = 5;
export const ELUL = 6;
export const TISHREI = 7;
export const CHESHVAN = 8;
export const KISLEV = 9;
export const TEVET = 10;
export const SHVAT = 11;
export const ADAR_I = 12;
export const ADAR_II = 13;

export interface HDate {
  year: number;
  /** 1 = Nisan … 7 = Tishrei … 12 = Adar (Adar I in a leap year), 13 = Adar II. */
  month: number;
  day: number;
}

/** A Gregorian calendar day. */
export interface GDay {
  y: number;
  m: number; // 1–12
  d: number;
}

/* ─── Fixed days ─────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;
/** RD of 1970-01-01. */
const RD_UNIX = 719_163;

export const fixedOf = (g: GDay): number => Math.floor(Date.UTC(g.y, g.m - 1, g.d) / DAY_MS) + RD_UNIX;
/** Date.UTC treats years 0–99 as 1900–1999; set the year explicitly. */
export function gregorianOf(fixed: number): GDay {
  const date = new Date((fixed - RD_UNIX) * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}
/** 0 = Sunday … 6 = Shabbat. */
export const weekdayOf = (fixed: number): number => ((fixed % 7) + 7) % 7;
export const SHABBAT = 6;

/* ─── The year ───────────────────────────────────────────────────────── */

export const isLeapYear = (year: number): boolean => (7 * year + 1) % 19 < 7;
export const monthsInYear = (year: number): number => (isLeapYear(year) ? 13 : 12);

/** RD of the day before 1 Tishrei of year 1 (Monday, 7 October 3761 BCE, Julian). */
const EPOCH = -1_373_428;

const elapsedCache = new Map<number, number>();

/**
 * Days from the epoch to 1 Tishrei of `year`: the molad of Tishrei, then the
 * postponements — molad zaken (at or after noon), lo ADU rosh (never Sunday,
 * Wednesday or Friday), GaTRaD and BeTU'TaKPaT.
 */
export function elapsedDays(year: number): number {
  const cached = elapsedCache.get(year);
  if (cached !== undefined) return cached;
  const months = Math.floor((235 * year - 234) / 19);
  const partsElapsed = 204 + 793 * (months % 1080);
  const hoursElapsed = 5 + 12 * months + 793 * Math.floor(months / 1080) + Math.floor(partsElapsed / 1080);
  let day = 1 + 29 * months + Math.floor(hoursElapsed / 24);
  const parts = 1080 * (hoursElapsed % 24) + (partsElapsed % 1080);
  // Molad zaken: a molad at or after 18 hours (noon) moves the new year a day.
  // GaTRaD: a common year whose molad is on Tuesday at 9h 204p or later.
  // BeTU'TaKPaT: after a leap year, a molad on Monday at 15h 589p or later.
  if (parts >= 19_440 || (day % 7 === 2 && parts >= 9_924 && !isLeapYear(year)) || (day % 7 === 1 && parts >= 16_789 && isLeapYear(year - 1))) day += 1;
  // Lo ADU rosh: Rosh Hashana is never on Sunday, Wednesday or Friday.
  if (day % 7 === 0 || day % 7 === 3 || day % 7 === 5) day += 1;
  if (elapsedCache.size > 400) elapsedCache.clear();
  elapsedCache.set(year, day);
  return day;
}

export const daysInYear = (year: number): number => elapsedDays(year + 1) - elapsedDays(year);
/** Cheshvan has 30 days in a complete year (355 / 385 days). */
export const longCheshvan = (year: number): boolean => daysInYear(year) % 10 === 5;
/** Kislev has 29 days in a deficient year (353 / 383 days). */
export const shortKislev = (year: number): boolean => daysInYear(year) % 10 === 3;

export function daysInMonth(month: number, year: number): number {
  switch (month) {
    case IYYAR:
    case TAMUZ:
    case ELUL:
    case TEVET:
    case ADAR_II:
      return 29;
    case ADAR_I:
      return isLeapYear(year) ? 30 : 29;
    case CHESHVAN:
      return longCheshvan(year) ? 30 : 29;
    case KISLEV:
      return shortKislev(year) ? 29 : 30;
    default:
      return 30;
  }
}

/** The months of a year in order, from Tishrei to Elul. */
export function monthsOfYear(year: number): number[] {
  const out = [TISHREI, CHESHVAN, KISLEV, TEVET, SHVAT, ADAR_I];
  if (isLeapYear(year)) out.push(ADAR_II);
  out.push(NISAN, IYYAR, SIVAN, TAMUZ, AV, ELUL);
  return out;
}

/** RD of 1 Tishrei. */
export const roshHashana = (year: number): number => EPOCH + elapsedDays(year);

/** RD of a Hebrew date. A day past the month's end runs into the next month. */
export function fixedOfHebrew({ year, month, day }: HDate): number {
  let n = roshHashana(year);
  for (const m of monthsOfYear(year)) {
    if (m === month) return n + day - 1;
    n += daysInMonth(m, year);
  }
  throw new RangeError(`month ${month} is not in year ${year}`);
}

/** The Hebrew date of a fixed day. */
export function hebrewOfFixed(fixed: number): HDate {
  // Approximate the year from the mean year length, then step.
  let year = Math.floor((fixed - EPOCH) / 365.2468) + 1;
  while (roshHashana(year) > fixed) year--;
  while (roshHashana(year + 1) <= fixed) year++;
  let n = roshHashana(year);
  for (const m of monthsOfYear(year)) {
    const len = daysInMonth(m, year);
    if (fixed < n + len) return { year, month: m, day: fixed - n + 1 };
    n += len;
  }
  throw new RangeError(`no Hebrew date for ${fixed}`);
}

/** "Adar" of the year: Adar in a common year, Adar II in a leap year (Purim, Ta'anit Esther). */
export const purimAdar = (year: number): number => (isLeapYear(year) ? ADAR_II : ADAR_I);

/* ─── Holidays ───────────────────────────────────────────────────────── */

export type HolidayKind = "major" | "minor" | "fast" | "modern" | "roshChodesh" | "erev";

export interface Holiday {
  /** Stable id, e.g. "pesach-1", "yom-haatzmaut" — the name comes from hebrewCalendarNames. */
  id: string;
  kind: HolidayKind;
  /** RD of the day. */
  fixed: number;
  /** A day of rest (yom tov) — no regular Torah portion when it is Shabbat. */
  yomTov?: boolean;
  /** Chol HaMoed — also no regular portion on Shabbat. */
  cholHamoed?: boolean;
}

export interface CalendarOptions {
  /** Israel (one day of yom tov) or the diaspora (two). */
  israel: boolean;
}

const holidayCache = new Map<string, readonly Holiday[]>();

/** Every holiday, fast and Rosh Chodesh of a Hebrew year (1 Tishrei – 29 Elul), in date order. Shared: do not change it. */
export function holidaysOfHebrewYear(year: number, { israel }: CalendarOptions): readonly Holiday[] {
  const key = `${year}:${israel ? "il" : "d"}`;
  const cached = holidayCache.get(key);
  if (cached) return cached;
  const list = computeHolidays(year, israel);
  if (holidayCache.size > 200) holidayCache.clear();
  holidayCache.set(key, list);
  return list;
}

function computeHolidays(year: number, israel: boolean): readonly Holiday[] {
  const out: Holiday[] = [];
  const at = (month: number, day: number) => fixedOfHebrew({ year, month, day });
  const add = (id: string, kind: HolidayKind, fixed: number, extra: Partial<Holiday> = {}) => out.push({ id, kind, fixed, ...extra });
  const dow = weekdayOf;

  // Tishrei
  add("rosh-hashana-1", "major", at(TISHREI, 1), { yomTov: true });
  add("rosh-hashana-2", "major", at(TISHREI, 2), { yomTov: true });
  // Tzom Gedaliah: 3 Tishrei; on Shabbat it moves to Sunday.
  add("tzom-gedaliah", "fast", dow(at(TISHREI, 3)) === SHABBAT ? at(TISHREI, 4) : at(TISHREI, 3));
  add("erev-yom-kippur", "erev", at(TISHREI, 9));
  add("yom-kippur", "major", at(TISHREI, 10), { yomTov: true });
  add("erev-sukkot", "erev", at(TISHREI, 14));
  add("sukkot-1", "major", at(TISHREI, 15), { yomTov: true });
  if (israel) {
    for (let d = 16; d <= 20; d++) add(`sukkot-chm-${d - 15}`, "minor", at(TISHREI, d), { cholHamoed: true });
  } else {
    add("sukkot-2", "major", at(TISHREI, 16), { yomTov: true });
    for (let d = 17; d <= 20; d++) add(`sukkot-chm-${d - 16}`, "minor", at(TISHREI, d), { cholHamoed: true });
  }
  add("hoshana-raba", "minor", at(TISHREI, 21), { cholHamoed: true });
  if (israel) add("shemini-atzeret-simchat-torah", "major", at(TISHREI, 22), { yomTov: true });
  else {
    add("shemini-atzeret", "major", at(TISHREI, 22), { yomTov: true });
    add("simchat-torah", "major", at(TISHREI, 23), { yomTov: true });
  }

  // Chanukah: eight days from 25 Kislev (into Tevet; 30 Kislev only in some years).
  for (let i = 0; i < 8; i++) add(`chanukah-${i + 1}`, "minor", at(KISLEV, 25) + i);
  // 10 Tevet is never on Shabbat and is never moved.
  add("asara-btevet", "fast", at(TEVET, 10));
  add("tu-bishvat", "minor", at(SHVAT, 15));

  // Purim and its fast are in Adar II in a leap year; Purim Katan in Adar I.
  if (isLeapYear(year)) add("purim-katan", "minor", at(ADAR_I, 14));
  const adar = purimAdar(year);
  // Ta'anit Esther: 13 Adar; on Shabbat it moves back to Thursday.
  add("taanit-esther", "fast", dow(at(adar, 13)) === SHABBAT ? at(adar, 11) : at(adar, 13));
  add("purim", "major", at(adar, 14));
  add("shushan-purim", "minor", at(adar, 15));

  // Nisan. Ta'anit Bechorot: 14 Nisan; on Shabbat it moves back to Thursday.
  add("taanit-bechorot", "fast", dow(at(NISAN, 14)) === SHABBAT ? at(NISAN, 12) : at(NISAN, 14));
  add("erev-pesach", "erev", at(NISAN, 14));
  add("pesach-1", "major", at(NISAN, 15), { yomTov: true });
  if (israel) {
    for (let d = 16; d <= 20; d++) add(`pesach-chm-${d - 15}`, "minor", at(NISAN, d), { cholHamoed: true });
    add("pesach-7", "major", at(NISAN, 21), { yomTov: true });
  } else {
    add("pesach-2", "major", at(NISAN, 16), { yomTov: true });
    for (let d = 17; d <= 20; d++) add(`pesach-chm-${d - 16}`, "minor", at(NISAN, d), { cholHamoed: true });
    add("pesach-7", "major", at(NISAN, 21), { yomTov: true });
    add("pesach-8", "major", at(NISAN, 22), { yomTov: true });
  }

  // Yom HaShoah (law of 1959, as amended): 27 Nisan; Friday → Thursday, Sunday → Monday.
  const shoah = at(NISAN, 27);
  add("yom-hashoah", "modern", dow(shoah) === 5 ? shoah - 1 : dow(shoah) === 0 ? shoah + 1 : shoah);
  // Yom HaZikaron and Yom HaAtzmaut (government rules since 2004), from 5 Iyar:
  //   Friday   → Zikaron Wednesday 3 Iyar, Atzmaut Thursday 4 Iyar
  //   Shabbat  → Zikaron Wednesday 2 Iyar, Atzmaut Thursday 3 Iyar
  //   Monday   → Zikaron Monday 5 Iyar,    Atzmaut Tuesday 6 Iyar
  //   otherwise Zikaron 4 Iyar, Atzmaut 5 Iyar
  const iyar5 = at(IYYAR, 5);
  const atzmaut = dow(iyar5) === 5 ? iyar5 - 1 : dow(iyar5) === SHABBAT ? iyar5 - 2 : dow(iyar5) === 1 ? iyar5 + 1 : iyar5;
  add("yom-hazikaron", "modern", atzmaut - 1);
  add("yom-haatzmaut", "modern", atzmaut);
  add("pesach-sheni", "minor", at(IYYAR, 14));
  add("lag-baomer", "minor", at(IYYAR, 18));
  add("yom-yerushalayim", "modern", at(IYYAR, 28));

  // Sivan
  add("erev-shavuot", "erev", at(SIVAN, 5));
  add("shavuot-1", "major", at(SIVAN, 6), { yomTov: true });
  if (!israel) add("shavuot-2", "major", at(SIVAN, 7), { yomTov: true });

  // 17 Tammuz and 9 Av: on Shabbat they move to Sunday.
  add("tzom-tammuz", "fast", dow(at(TAMUZ, 17)) === SHABBAT ? at(TAMUZ, 18) : at(TAMUZ, 17));
  const av9 = at(AV, 9);
  add("erev-tisha-bav", "erev", dow(av9) === SHABBAT ? av9 : av9 - 1);
  add("tisha-bav", "fast", dow(av9) === SHABBAT ? av9 + 1 : av9);
  add("tu-bav", "minor", at(AV, 15));
  add("erev-rosh-hashana", "erev", at(ELUL, 29));

  // Rosh Chodesh: the 30th of a full month and the 1st of the next (not Tishrei: that is Rosh Hashana).
  const months = monthsOfYear(year);
  months.forEach((m, i) => {
    if (m === TISHREI) return;
    const prev = months[i - 1];
    if (daysInMonth(prev, year) === 30) add(`rosh-chodesh-${m}`, "roshChodesh", at(prev, 30));
    add(`rosh-chodesh-${m}`, "roshChodesh", at(m, 1));
  });

  return Object.freeze(out.sort((a, b) => a.fixed - b.fixed || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]).map((h) => Object.freeze(h)));
}

const KIND_ORDER: Record<HolidayKind, number> = { major: 0, fast: 1, modern: 2, minor: 3, roshChodesh: 4, erev: 5 };

/* ─── Torah portions ─────────────────────────────────────────────────── */

/** The 54 portions, in order (ids; names in hebrewCalendarNames). */
export const PARASHOT = [
  "bereshit", "noach", "lech-lecha", "vayera", "chayei-sara", "toldot", "vayetzei", "vayishlach", "vayeshev", "miketz",
  "vayigash", "vayechi", "shemot", "vaera", "bo", "beshalach", "yitro", "mishpatim", "terumah", "tetzaveh",
  "ki-tisa", "vayakhel", "pekudei", "vayikra", "tzav", "shmini", "tazria", "metzora", "achrei-mot", "kedoshim",
  "emor", "behar", "bechukotai", "bamidbar", "nasso", "behaalotcha", "shlach", "korach", "chukat", "balak",
  "pinchas", "matot", "masei", "devarim", "vaetchanan", "eikev", "reeh", "shoftim", "ki-teitzei", "ki-tavo",
  "nitzavim", "vayeilech", "haazinu", "vezot-haberakhah",
] as const;
export type ParashaId = (typeof PARASHOT)[number];

const P = (id: ParashaId) => PARASHOT.indexOf(id);
/** The pairs that may be read together, by the index of the first. */
const JOINABLE = new Set([P("vayakhel"), P("tazria"), P("achrei-mot"), P("behar"), P("chukat"), P("matot"), P("nitzavim")]);

/** A Shabbat's reading: one portion, two read together, or none (a holiday reading). */
export interface Reading {
  fixed: number;
  /** One id, or two for a double portion; empty on a holiday. */
  parashot: ParashaId[];
  /** The holiday read instead, when `parashot` is empty. */
  holiday?: string;
}

/** Shabbatot from `from` (inclusive) to `to` (exclusive). */
function shabbatot(from: number, to: number): number[] {
  const out: number[] = [];
  for (let s = from + ((SHABBAT - weekdayOf(from) + 7) % 7); s < to; s += 7) out.push(s);
  return out;
}

/**
 * Portions for `days`, from `first`, aiming to end at `target`: pairs are
 * joined (in `order`) while there are fewer Shabbatot than portions; with
 * more Shabbatot than portions the segment simply reads on past its target
 * (a leap year that begins on Thursday has no pair to join at all, and its
 * Shabbat before Shavuot reads Naso). Returns the groups.
 */
function fill(days: number[], first: number, target: number, order: number[], exact = false): number[][] {
  const count = target - first + 1;
  let joins = Math.max(0, count - days.length);
  if (exact && days.length > count) throw new Error(`portions ${PARASHOT[first]}…${PARASHOT[target]}: ${days.length} Shabbatot for ${count}`);
  const join = new Set<number>();
  for (const p of order) {
    if (!joins) break;
    if (p >= first && p < target && JOINABLE.has(p)) {
      join.add(p);
      joins--;
    }
  }
  if (joins) throw new Error(`portions ${PARASHOT[first]}…${PARASHOT[target]}: ${days.length} Shabbatot, not enough pairs to join`);
  const out: number[][] = [];
  for (let p = first; out.length < days.length; p++) {
    if (join.has(p)) {
      out.push([p, p + 1]);
      p++;
    } else out.push([p]);
  }
  return out;
}

const lastOf = (groups: number[][], before: number) => (groups.length ? groups[groups.length - 1][groups[groups.length - 1].length - 1] : before);

const readingCache = new Map<string, readonly Reading[]>();

/**
 * The Shabbat readings of a Hebrew year (1 Tishrei – 29 Elul).
 *
 * Diaspora first, by its fixed points (OC 428:4):
 *  - before Pesach: Tzav in a common year ("pikdu u-fiskhu"); in a leap year
 *    nothing is joined before Pesach (Metzora, or Acharei Mot, comes as it falls);
 *  - Bamidbar on the Shabbat before Shavuot ("minu v'itzru");
 *  - Devarim on the Shabbat before 9 Av, or on it ("tzumu v'tzalu");
 *  - Va'etchanan after 9 Av, Nitzavim before Rosh Hashana ("kumu v'tik'u"),
 *    with Vayelech when the next Rosh Hashana is Thursday or Shabbat (no
 *    Shabbat for it between Rosh Hashana and Sukkot).
 * Between the fixed points, the pairs are joined as far as needed: Vayakhel–
 * Pekudei; Tazria–Metzora, Acharei Mot–Kedoshim, Behar–Bechukotai; Matot–
 * Masei, then Chukat–Balak.
 *
 * Israel reads the same, except after a Shabbat that is a holiday only in the
 * diaspora (the eighth day of Pesach, the second day of Shavuot): Israel reads
 * the next portion that Shabbat and stays a week ahead, until the diaspora
 * joins Behar–Bechukotai, Chukat–Balak or Matot–Masei and Israel reads them
 * apart.
 */
export function readingsOfHebrewYear(year: number, { israel }: CalendarOptions): readonly Reading[] {
  const key = `${year}:${israel ? "il" : "d"}`;
  const cached = readingCache.get(key);
  if (cached) return cached;
  const diaspora = diasporaReadings(year);
  const result = israel ? israelReadings(year, diaspora) : diaspora;
  if (readingCache.size > 200) readingCache.clear();
  readingCache.set(key, result);
  return result;
}

function holidayReadingId(fixed: number, year: number, israel: boolean): string | undefined {
  // The first holiday of the day that has its own reading (yom tov or Chol HaMoed).
  for (const h of holidaysOfHebrewYear(year, { israel })) if (h.fixed === fixed && (h.yomTov || h.cholHamoed)) return h.id;
  return undefined;
}

function diasporaReadings(year: number): Reading[] {
  const at = (month: number, day: number) => fixedOfHebrew({ year, month, day });
  const end = roshHashana(year + 1);
  const all = shabbatot(roshHashana(year), end);
  const holiday = (s: number) => holidayReadingId(s, year, false);
  const readings: Reading[] = [];
  const put = (s: number, ps: number[]) => readings.push({ fixed: s, parashot: ps.map((i) => PARASHOT[i]) });

  // Tishrei, before Simchat Torah: Vayelech (when last year read it apart from
  // Nitzavim) and Ha'azinu on the Shabbatot that are not holidays.
  const simchatTorah = at(TISHREI, 23);
  const early = all.filter((s) => s < simchatTorah && !holiday(s));
  if (early.length === 2) {
    put(early[0], [P("vayeilech")]);
    put(early[1], [P("haazinu")]);
  } else if (early.length === 1) put(early[0], [P("haazinu")]);
  else if (early.length) throw new Error(`year ${year}: ${early.length} Shabbatot before Sukkot`);

  const rest = all.filter((s) => s > simchatTorah && !holiday(s));
  const pesach = at(NISAN, 15);
  const shavuot = at(SIVAN, 6);
  const av9 = at(AV, 9);
  const s1 = rest.filter((s) => s < pesach);
  const s2 = rest.filter((s) => s > pesach && s < shavuot);
  const s3 = rest.filter((s) => s > shavuot && s <= av9);
  const s4 = rest.filter((s) => s > av9);
  const leap = isLeapYear(year);
  // 1. Bereshit … the Shabbat before Pesach: Tzav in a common year; in a leap
  //    year Metzora, or Acharei Mot when the year begins on Thursday.
  const g1 = fill(s1, P("bereshit"), leap ? P("metzora") : P("tzav"), [P("vayakhel")]);
  // 2. … Bamidbar on the Shabbat before Shavuot.
  const g2 = fill(s2, lastOf(g1, -1) + 1, P("bamidbar"), [P("tazria"), P("achrei-mot"), P("behar")]);
  // 3. … Devarim on the Shabbat of (or before) 9 Av.
  const g3 = fill(s3, lastOf(g2, -1) + 1, P("devarim"), [P("matot"), P("chukat")], true);
  if (lastOf(g3, -1) !== P("devarim")) throw new Error(`year ${year}: Devarim is not read before 9 Av`);
  // 4. … Nitzavim before Rosh Hashana, with Vayelech when the next year has no Shabbat for it.
  const nextRh = weekdayOf(end);
  const lastOfYear = nextRh === 4 || nextRh === SHABBAT ? P("vayeilech") : P("nitzavim");
  const g4 = fill(s4, P("vaetchanan"), lastOfYear, [P("nitzavim")], true);
  if (g4.length !== s4.length || lastOf(g4, -1) !== lastOfYear) throw new Error(`year ${year}: the year does not end with ${PARASHOT[lastOfYear]}`);
  [...s1, ...s2, ...s3, ...s4].forEach((s, i) => put(s, [...g1, ...g2, ...g3, ...g4][i]));

  for (const s of all) {
    const h = holiday(s);
    if (h) readings.push({ fixed: s, parashot: [], holiday: h });
  }
  return readings.sort((a, b) => a.fixed - b.fixed);
}

const ISRAEL_REJOIN = new Set<ParashaId>(["behar", "chukat", "matot"]);

function israelReadings(year: number, diaspora: readonly Reading[]): Reading[] {
  const out: Reading[] = [];
  for (let i = 0; i < diaspora.length; i++) {
    const r = diaspora[i];
    const ilHoliday = r.parashot.length ? undefined : holidayReadingId(r.fixed, year, true);
    if (r.parashot.length || ilHoliday) {
      out.push(ilHoliday ? { fixed: r.fixed, parashot: [], holiday: ilHoliday } : { fixed: r.fixed, parashot: [...r.parashot] });
      continue;
    }
    // A holiday only in the diaspora. Israel reads each following diaspora
    // reading a week early, up to the first pair it reads apart: the first
    // half the week before, the second half with the diaspora.
    const days = [r.fixed];
    const groups: ParashaId[][] = [];
    let j = i + 1;
    for (; j < diaspora.length; j++) {
      const next = diaspora[j];
      if (!next.parashot.length) throw new Error(`year ${year}: a holiday before Israel rejoins the diaspora`);
      days.push(next.fixed);
      if (next.parashot.length === 2 && ISRAEL_REJOIN.has(next.parashot[0])) {
        groups.push([next.parashot[0]], [next.parashot[1]]);
        break;
      }
      groups.push([...next.parashot]);
    }
    if (j === diaspora.length) throw new Error(`year ${year}: Israel never rejoins the diaspora`);
    days.forEach((fixed, k) => out.push({ fixed, parashot: groups[k] }));
    i = j;
  }
  return out;
}

/* ─── By Gregorian day ───────────────────────────────────────────────── */

/** The holidays of a Gregorian day. */
export function holidaysOn(day: GDay, opts: CalendarOptions): Holiday[] {
  const fixed = fixedOf(day);
  return holidaysOfHebrewYear(hebrewOfFixed(fixed).year, opts).filter((h) => h.fixed === fixed);
}

/** The reading of the Shabbat on or after `day` — "this week's portion". */
export function weeklyReading(day: GDay, opts: CalendarOptions): Reading {
  const fixed = fixedOf(day);
  const shabbat = fixed + ((SHABBAT - weekdayOf(fixed) + 7) % 7);
  const found = readingsOfHebrewYear(hebrewOfFixed(shabbat).year, opts).find((r) => r.fixed === shabbat);
  if (!found) throw new Error(`no reading for ${shabbat}`);
  return found;
}

/** Holidays and Shabbat readings of a Gregorian year (or of `from` … `to`, inclusive), in date order. */
export function calendarOfRange(from: GDay, to: GDay, opts: CalendarOptions): { holidays: Holiday[]; readings: Reading[] } {
  const a = fixedOf(from);
  const b = fixedOf(to);
  const holidays: Holiday[] = [];
  const readings: Reading[] = [];
  for (let y = hebrewOfFixed(a).year; y <= hebrewOfFixed(b).year; y++) {
    for (const h of holidaysOfHebrewYear(y, opts)) if (h.fixed >= a && h.fixed <= b) holidays.push(h);
    for (const r of readingsOfHebrewYear(y, opts)) if (r.fixed >= a && r.fixed <= b) readings.push(r);
  }
  return { holidays, readings };
}

/**
 * Israel or the diaspora when the user hasn't said: Israel for a Hebrew UI or
 * the Israeli time zone.
 */
export function defaultIsrael(locale: string, timeZone: string = safeTimeZone()): boolean {
  return locale === "he" || timeZone === "Asia/Jerusalem" || timeZone === "Asia/Tel_Aviv";
}

function safeTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** Forget the computed years (for timing tests). */
export function __clearHebrewCalendarCaches(): void {
  elapsedCache.clear();
  holidayCache.clear();
  readingCache.clear();
}
