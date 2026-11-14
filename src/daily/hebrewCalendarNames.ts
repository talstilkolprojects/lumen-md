/**
 * Names of the holidays, months and Torah portions (plan W2.10), in Hebrew
 * and in English. They are proper names — "פרשת בהר", "Behar" — so they live
 * here as data beside the calendar, like the template gallery's Hebrew and
 * English names, and reach the UI only with the lazily loaded calendar.
 * Other UI languages show the English transliteration.
 */
import { gematria } from "./gematria";
import { ADAR_I, ADAR_II, AV, CHESHVAN, ELUL, IYYAR, KISLEV, NISAN, SHVAT, SIVAN, TAMUZ, TEVET, TISHREI, hebrewOfFixed, isLeapYear, type Holiday, type ParashaId, type Reading } from "./hebrewCalendar";

export type NameLang = "he" | "en";
export const nameLang = (locale: string): NameLang => (locale === "he" ? "he" : "en");

type Names = Record<string, { he: string; en: string }>;

const HOLIDAYS: Names = {
  "rosh-hashana-1": { he: "ראש השנה א׳", en: "Rosh Hashana I" },
  "rosh-hashana-2": { he: "ראש השנה ב׳", en: "Rosh Hashana II" },
  "erev-rosh-hashana": { he: "ערב ראש השנה", en: "Erev Rosh Hashana" },
  "tzom-gedaliah": { he: "צום גדליה", en: "Tzom Gedaliah" },
  "erev-yom-kippur": { he: "ערב יום כיפור", en: "Erev Yom Kippur" },
  "yom-kippur": { he: "יום כיפור", en: "Yom Kippur" },
  "erev-sukkot": { he: "ערב סוכות", en: "Erev Sukkot" },
  "sukkot-1": { he: "סוכות", en: "Sukkot I" },
  "sukkot-2": { he: "סוכות ב׳", en: "Sukkot II" },
  "hoshana-raba": { he: "הושענא רבה", en: "Hoshana Raba" },
  "shemini-atzeret-simchat-torah": { he: "שמיני עצרת ושמחת תורה", en: "Shemini Atzeret and Simchat Torah" },
  "shemini-atzeret": { he: "שמיני עצרת", en: "Shemini Atzeret" },
  "simchat-torah": { he: "שמחת תורה", en: "Simchat Torah" },
  "asara-btevet": { he: "עשרה בטבת", en: "Asara B'Tevet" },
  "tu-bishvat": { he: "ט״ו בשבט", en: "Tu BiShvat" },
  "purim-katan": { he: "פורים קטן", en: "Purim Katan" },
  "taanit-esther": { he: "תענית אסתר", en: "Ta'anit Esther" },
  purim: { he: "פורים", en: "Purim" },
  "shushan-purim": { he: "שושן פורים", en: "Shushan Purim" },
  "taanit-bechorot": { he: "תענית בכורות", en: "Ta'anit Bechorot" },
  "erev-pesach": { he: "ערב פסח", en: "Erev Pesach" },
  "pesach-1": { he: "פסח", en: "Pesach I" },
  "pesach-2": { he: "פסח ב׳", en: "Pesach II" },
  "pesach-7": { he: "שביעי של פסח", en: "Pesach VII" },
  "pesach-8": { he: "אחרון של פסח", en: "Pesach VIII" },
  "yom-hashoah": { he: "יום השואה", en: "Yom HaShoah" },
  "yom-hazikaron": { he: "יום הזיכרון", en: "Yom HaZikaron" },
  "yom-haatzmaut": { he: "יום העצמאות", en: "Yom HaAtzmaut" },
  "pesach-sheni": { he: "פסח שני", en: "Pesach Sheni" },
  "lag-baomer": { he: "ל״ג בעומר", en: "Lag BaOmer" },
  "yom-yerushalayim": { he: "יום ירושלים", en: "Yom Yerushalayim" },
  "erev-shavuot": { he: "ערב שבועות", en: "Erev Shavuot" },
  "shavuot-1": { he: "שבועות", en: "Shavuot I" },
  "shavuot-2": { he: "שבועות ב׳", en: "Shavuot II" },
  "tzom-tammuz": { he: "צום י״ז בתמוז", en: "Tzom Tammuz" },
  "erev-tisha-bav": { he: "ערב תשעה באב", en: "Erev Tish'a B'Av" },
  "tisha-bav": { he: "תשעה באב", en: "Tish'a B'Av" },
  "tu-bav": { he: "ט״ו באב", en: "Tu B'Av" },
};

const MONTHS: Record<number, { he: string; en: string }> = {
  [NISAN]: { he: "ניסן", en: "Nisan" },
  [IYYAR]: { he: "אייר", en: "Iyyar" },
  [SIVAN]: { he: "סיוון", en: "Sivan" },
  [TAMUZ]: { he: "תמוז", en: "Tamuz" },
  [AV]: { he: "אב", en: "Av" },
  [ELUL]: { he: "אלול", en: "Elul" },
  [TISHREI]: { he: "תשרי", en: "Tishrei" },
  [CHESHVAN]: { he: "חשוון", en: "Cheshvan" },
  [KISLEV]: { he: "כסלו", en: "Kislev" },
  [TEVET]: { he: "טבת", en: "Tevet" },
  [SHVAT]: { he: "שבט", en: "Sh'vat" },
  [ADAR_I]: { he: "אדר", en: "Adar" },
  [ADAR_II]: { he: "אדר ב׳", en: "Adar II" },
};

/** A month's name; Adar of a leap year is "Adar I". */
export function monthName(month: number, year: number, lang: NameLang): string {
  if (month === ADAR_I && isLeapYear(year)) return lang === "he" ? "אדר א׳" : "Adar I";
  return MONTHS[month][lang];
}

const PARASHA_NAMES: Record<ParashaId, { he: string; en: string }> = {
  bereshit: { he: "בראשית", en: "Bereshit" },
  noach: { he: "נח", en: "Noach" },
  "lech-lecha": { he: "לך לך", en: "Lech-Lecha" },
  vayera: { he: "וירא", en: "Vayera" },
  "chayei-sara": { he: "חיי שרה", en: "Chayei Sara" },
  toldot: { he: "תולדות", en: "Toldot" },
  vayetzei: { he: "ויצא", en: "Vayetzei" },
  vayishlach: { he: "וישלח", en: "Vayishlach" },
  vayeshev: { he: "וישב", en: "Vayeshev" },
  miketz: { he: "מקץ", en: "Miketz" },
  vayigash: { he: "ויגש", en: "Vayigash" },
  vayechi: { he: "ויחי", en: "Vayechi" },
  shemot: { he: "שמות", en: "Shemot" },
  vaera: { he: "וארא", en: "Vaera" },
  bo: { he: "בא", en: "Bo" },
  beshalach: { he: "בשלח", en: "Beshalach" },
  yitro: { he: "יתרו", en: "Yitro" },
  mishpatim: { he: "משפטים", en: "Mishpatim" },
  terumah: { he: "תרומה", en: "Terumah" },
  tetzaveh: { he: "תצוה", en: "Tetzaveh" },
  "ki-tisa": { he: "כי תשא", en: "Ki Tisa" },
  vayakhel: { he: "ויקהל", en: "Vayakhel" },
  pekudei: { he: "פקודי", en: "Pekudei" },
  vayikra: { he: "ויקרא", en: "Vayikra" },
  tzav: { he: "צו", en: "Tzav" },
  shmini: { he: "שמיני", en: "Shmini" },
  tazria: { he: "תזריע", en: "Tazria" },
  metzora: { he: "מצורע", en: "Metzora" },
  "achrei-mot": { he: "אחרי מות", en: "Achrei Mot" },
  kedoshim: { he: "קדושים", en: "Kedoshim" },
  emor: { he: "אמור", en: "Emor" },
  behar: { he: "בהר", en: "Behar" },
  bechukotai: { he: "בחוקותי", en: "Bechukotai" },
  bamidbar: { he: "במדבר", en: "Bamidbar" },
  nasso: { he: "נשא", en: "Nasso" },
  behaalotcha: { he: "בהעלותך", en: "Beha'alotcha" },
  shlach: { he: "שלח לך", en: "Sh'lach" },
  korach: { he: "קורח", en: "Korach" },
  chukat: { he: "חוקת", en: "Chukat" },
  balak: { he: "בלק", en: "Balak" },
  pinchas: { he: "פינחס", en: "Pinchas" },
  matot: { he: "מטות", en: "Matot" },
  masei: { he: "מסעי", en: "Masei" },
  devarim: { he: "דברים", en: "Devarim" },
  vaetchanan: { he: "ואתחנן", en: "Vaetchanan" },
  eikev: { he: "עקב", en: "Eikev" },
  reeh: { he: "ראה", en: "Re'eh" },
  shoftim: { he: "שופטים", en: "Shoftim" },
  "ki-teitzei": { he: "כי תצא", en: "Ki Teitzei" },
  "ki-tavo": { he: "כי תבוא", en: "Ki Tavo" },
  nitzavim: { he: "נצבים", en: "Nitzavim" },
  vayeilech: { he: "וילך", en: "Vayeilech" },
  haazinu: { he: "האזינו", en: "Ha'azinu" },
  "vezot-haberakhah": { he: "וזאת הברכה", en: "Vezot Haberakhah" },
};

export const parashaNameOf = (id: ParashaId, lang: NameLang): string => PARASHA_NAMES[id][lang];

/** "פרשת בהר-בחוקותי" / "Behar-Bechukotai"; a holiday Shabbat gives the holiday's name. */
export function readingName(reading: Reading, lang: NameLang): string {
  if (!reading.parashot.length) return reading.holiday ? holidayName(reading.holiday, lang) : "";
  const names = reading.parashot.map((p) => PARASHA_NAMES[p][lang]).join("-");
  return lang === "he" ? `פרשת ${names}` : names;
}

/** A holiday's name from its id (with the day of Chanukah or Chol HaMoed, the month of Rosh Chodesh). */
export function holidayName(id: string, lang: NameLang, year?: number): string {
  const fixed = HOLIDAYS[id];
  if (fixed) return fixed[lang];
  let m = /^chanukah-(\d)$/.exec(id);
  if (m) return lang === "he" ? `חנוכה: נר ${gematria(Number(m[1]))}` : `Chanukah: ${m[1]} candle${m[1] === "1" ? "" : "s"}`;
  m = /^(sukkot|pesach)-chm-(\d)$/.exec(id);
  if (m) {
    const he = m[1] === "sukkot" ? "סוכות" : "פסח";
    const en = m[1] === "sukkot" ? "Sukkot" : "Pesach";
    return lang === "he" ? `חול המועד ${he} (${gematria(Number(m[2]))})` : `${en}: Chol HaMoed ${m[2]}`;
  }
  m = /^rosh-chodesh-(\d+)$/.exec(id);
  if (m) {
    const month = monthName(Number(m[1]), year ?? 5785, lang);
    return lang === "he" ? `ראש חודש ${month}` : `Rosh Chodesh ${month}`;
  }
  return id;
}

/** A holiday's name, with its Hebrew year (for Adar I / Adar II). */
export const holidayLabel = (h: Holiday, lang: NameLang): string => holidayName(h.id, lang, hebrewOfFixed(h.fixed).year);

/** Every holiday id with a fixed name (for the tests). */
export const NAMED_HOLIDAYS = Object.keys(HOLIDAYS);
