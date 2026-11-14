/**
 * Book names for Jewish-source references (plan W5.1): Sefaria's English
 * title, the Hebrew title, and the abbreviations people write. Covers the
 * Tanakh, Midrash Rabbah, the Mishnah and the Babylonian Talmud.
 *
 * `kind` decides the address: Tanakh, Midrash and Mishnah are
 * chapter:verse (perek:mishnah); the Talmud is a folio and side (2a).
 */

export type BookKind = "tanakh" | "midrash" | "mishnah" | "talmud";

export interface Book {
  /** Sefaria's title: "Genesis", "Bereshit Rabbah", "Berakhot". */
  en: string;
  /** The Hebrew title as displayed: "בראשית". */
  he: string;
  kind: BookKind;
  /**
   * Other ways it is written, Hebrew and English. Matched after
   * normalizing (refs.ts): case, dots and repeated spaces ignored; a geresh
   * is written ' and gershayim " — so בר׳ (Genesis) and ב״ר (Bereshit
   * Rabbah) stay apart.
   */
  aliases: string[];
}

const T = (en: string, he: string, ...aliases: string[]): Book => ({ en, he, kind: "tanakh", aliases });
const MR = (en: string, he: string, ...aliases: string[]): Book => ({ en, he, kind: "midrash", aliases });

export const TANAKH: Book[] = [
  T("Genesis", "בראשית", "בר'", "Gen", "Gn", "Bereshit", "Bereishit"),
  T("Exodus", "שמות", "שמ'", "Ex", "Exod", "Shemot"),
  T("Leviticus", "ויקרא", "ויק'", "Lev", "Lv", "Vayikra"),
  T("Numbers", "במדבר", "במ'", "Num", "Nm", "Bamidbar"),
  T("Deuteronomy", "דברים", "דב'", "Deut", "Dt", "Devarim"),
  T("Joshua", "יהושע", "יהו'", "Josh"),
  T("Judges", "שופטים", "שופ'", "Judg", "Jdg"),
  T("I Samuel", "שמואל א", 'ש"א', "שמואל א׳", "1 Samuel", "1 Sam", "I Sam", "1Sam", "First Samuel"),
  T("II Samuel", "שמואל ב", 'ש"ב', "שמואל ב׳", "2 Samuel", "2 Sam", "II Sam", "2Sam", "Second Samuel"),
  T("I Kings", "מלכים א", 'מל"א', "מלכים א׳", "1 Kings", "1 Kgs", "I Kgs", "1Kgs"),
  T("II Kings", "מלכים ב", 'מל"ב', "מלכים ב׳", "2 Kings", "2 Kgs", "II Kgs", "2Kgs"),
  T("Isaiah", "ישעיהו", "ישעיה", "יש'", "Isa", "Is"),
  T("Jeremiah", "ירמיהו", "ירמיה", "יר'", "Jer"),
  T("Ezekiel", "יחזקאל", "יח'", "Ezek", "Ez"),
  T("Hosea", "הושע", "Hos"),
  T("Joel", "יואל"),
  T("Amos", "עמוס"),
  T("Obadiah", "עובדיה", "Obad"),
  T("Jonah", "יונה", "Jon"),
  T("Micah", "מיכה", "Mic"),
  T("Nahum", "נחום", "Nah"),
  T("Habakkuk", "חבקוק", "Hab"),
  T("Zephaniah", "צפניה", "Zeph"),
  T("Haggai", "חגי", "Hag"),
  T("Zechariah", "זכריה", "Zech"),
  T("Malachi", "מלאכי", "Mal"),
  T("Psalms", "תהלים", "תהילים", "תה'", "Ps", "Psa", "Psalm", "Tehillim"),
  T("Proverbs", "משלי", "מש'", "Prov", "Mishlei"),
  T("Job", "איוב", "Iyov"),
  T("Song of Songs", "שיר השירים", 'שה"ש', "Song", "Song of Solomon", "Canticles", "Shir HaShirim"),
  T("Ruth", "רות"),
  T("Lamentations", "איכה", "Lam", "Eichah"),
  T("Ecclesiastes", "קהלת", "קה'", "Eccl", "Ecc", "Qoh", "Kohelet"),
  T("Esther", "אסתר", "Esth", "Est"),
  T("Daniel", "דניאל", "Dan"),
  T("Ezra", "עזרא"),
  T("Nehemiah", "נחמיה", "Neh"),
  T("I Chronicles", "דברי הימים א", 'דה"א', "דברי הימים א׳", "1 Chronicles", "1 Chr", "I Chr", "1Chr"),
  T("II Chronicles", "דברי הימים ב", 'דה"ב', "דברי הימים ב׳", "2 Chronicles", "2 Chr", "II Chr", "2Chr"),
];

export const MIDRASH: Book[] = [
  MR("Bereshit Rabbah", "בראשית רבה", 'ב"ר', 'בר"ר', "Genesis Rabbah", "Gen. Rab", "Gen Rabbah"),
  MR("Shemot Rabbah", "שמות רבה", 'שמו"ר', 'ש"ר', "Exodus Rabbah"),
  MR("Vayikra Rabbah", "ויקרא רבה", 'ויק"ר', "Leviticus Rabbah"),
  MR("Bamidbar Rabbah", "במדבר רבה", 'במ"ר', "Numbers Rabbah"),
  MR("Devarim Rabbah", "דברים רבה", 'דב"ר', "Deuteronomy Rabbah"),
  MR("Shir HaShirim Rabbah", "שיר השירים רבה", 'שהש"ר', "Song of Songs Rabbah"),
  MR("Ruth Rabbah", "רות רבה", 'רו"ר'),
  MR("Eichah Rabbah", "איכה רבה", 'איכ"ר', "Lamentations Rabbah"),
  MR("Kohelet Rabbah", "קהלת רבה", 'קה"ר', "Ecclesiastes Rabbah"),
  MR("Esther Rabbah", "אסתר רבה", 'אס"ר'),
];

/** Tractates: Sefaria title, Hebrew, and whether the Babylonian Talmud has it. */
const TRACTATES: Array<[string, string, boolean, ...string[]]> = [
  ["Berakhot", "ברכות", true, "Brachot", "Berachot"],
  ["Peah", "פאה", false],
  ["Demai", "דמאי", false],
  ["Kilayim", "כלאים", false],
  ["Sheviit", "שביעית", false],
  ["Terumot", "תרומות", false],
  ["Maasrot", "מעשרות", false],
  ["Maaser Sheni", "מעשר שני", false],
  ["Challah", "חלה", false],
  ["Orlah", "ערלה", false],
  ["Bikkurim", "ביכורים", false, "בכורים"],
  ["Shabbat", "שבת", true, "Shabbos"],
  ["Eruvin", "עירובין", true, "ערובין"],
  ["Pesachim", "פסחים", true],
  ["Shekalim", "שקלים", false],
  ["Yoma", "יומא", true],
  ["Sukkah", "סוכה", true],
  ["Beitzah", "ביצה", true],
  ["Rosh Hashanah", "ראש השנה", true],
  ["Taanit", "תענית", true],
  ["Megillah", "מגילה", true],
  ["Moed Katan", "מועד קטן", true],
  ["Chagigah", "חגיגה", true],
  ["Yevamot", "יבמות", true],
  ["Ketubot", "כתובות", true],
  ["Nedarim", "נדרים", true],
  ["Nazir", "נזיר", true],
  ["Sotah", "סוטה", true],
  ["Gittin", "גיטין", true],
  ["Kiddushin", "קידושין", true, "קדושין"],
  ["Bava Kamma", "בבא קמא", true, 'ב"ק', "Baba Kamma"],
  ["Bava Metzia", "בבא מציעא", true, 'ב"מ', "Baba Metzia"],
  ["Bava Batra", "בבא בתרא", true, 'ב"ב', "Baba Batra"],
  ["Sanhedrin", "סנהדרין", true],
  ["Makkot", "מכות", true],
  ["Shevuot", "שבועות", true],
  ["Eduyot", "עדיות", false],
  ["Avodah Zarah", "עבודה זרה", true, 'ע"ז'],
  ["Pirkei Avot", "אבות", false, "פרקי אבות", "Avot"],
  ["Horayot", "הוריות", true],
  ["Zevachim", "זבחים", true],
  ["Menachot", "מנחות", true],
  ["Chullin", "חולין", true],
  ["Bekhorot", "בכורות", true],
  ["Arakhin", "ערכין", true],
  ["Temurah", "תמורה", true],
  ["Keritot", "כריתות", true],
  ["Meilah", "מעילה", true],
  ["Tamid", "תמיד", true],
  ["Middot", "מידות", false],
  ["Kinnim", "קינים", false],
  ["Kelim", "כלים", false],
  ["Oholot", "אהלות", false],
  ["Negaim", "נגעים", false],
  ["Parah", "פרה", false],
  ["Tahorot", "טהרות", false],
  ["Mikvaot", "מקואות", false],
  ["Niddah", "נדה", true],
  ["Makhshirin", "מכשירין", false],
  ["Zavim", "זבים", false],
  ["Tevul Yom", "טבול יום", false],
  ["Yadayim", "ידיים", false],
  ["Oktzin", "עוקצים", false],
];

/** Mishnah tractates: "Mishnah Berakhot" (Avot is "Pirkei Avot" with no prefix). */
export const MISHNAH: Book[] = TRACTATES.map(([en, he, bavli, ...aliases]) => ({
  en: en === "Pirkei Avot" ? en : `Mishnah ${en}`,
  he: en === "Pirkei Avot" ? "פרקי אבות" : `משנה ${he}`,
  kind: "mishnah" as const,
  aliases:
    en === "Pirkei Avot"
      ? ["אבות", "פרקי אבות", "Avot", "Pirkei Avot", "Pirke Avot"]
      : [`Mishna ${en}`, `m. ${en}`, ...aliases.map((a) => `משנה ${a}`), ...(bavli ? [] : [he, en, ...aliases])],
}));

/** The Mishnah tractate of a Talmud tractate ("ברכות א:א" is a mishnah, "ברכות ב." a folio). */
export function mishnahOf(talmud: Book): Book | undefined {
  return MISHNAH.find((m) => m.en === `Mishnah ${talmud.en}`);
}

/** Babylonian Talmud tractates: "Berakhot" (addressed by folio, 2a). */
export const TALMUD: Book[] = TRACTATES.filter(([, , bavli]) => bavli).map(([en, he, , ...aliases]) => ({
  en,
  he,
  kind: "talmud" as const,
  aliases: [`בבלי ${he}`, `Bavli ${en}`, `b. ${en}`, `BT ${en}`, ...aliases],
}));

export const ALL_BOOKS: Book[] = [...MIDRASH, ...TANAKH, ...MISHNAH, ...TALMUD];
