/**
 * Plan W5.2: Israeli legal citation by כללי האזכור האחיד (3rd edition, TAU,
 * 2021). The first seven golden cases are the rules' own examples (their
 * summary "כללים מרכזיים", 2021); the rest apply the same rules to other
 * sources. The law-student review the plan asks for (≥ 38/40) is owed.
 */
import { describe, it, expect } from "vitest";
import { caseNumberAt, findCaseNumbers, formatLegal, hebrewYearOfDate, hebrewYearText, joinNames, ruleDate, rulingFromMatch, type LegalSource } from "../citations/legal";

const GOLDEN: Array<[string, LegalSource, string]> = [
  // The rules' own examples.
  ["Supreme Court, printed report, pinpoint paragraph", { kind: "ruling", proceeding: 'בג"ץ', number: "7/48", parties: ["אל-כרבוטלי", "שר-הבטחון"], reporter: { series: 'פ"ד', volume: "ב", page: "5" }, pinpoint: { paras: "14" }, year: "1949" }, 'בג"ץ 7/48 אל-כרבוטלי נ\' שר-הבטחון, פ"ד ב 5, פס\' 14 (1949).'],
  ["Lower court, printed report", { kind: "ruling", proceeding: 'ת"פ', court: "מקומיים י-ם", number: "2857/85", parties: ["מדינת ישראל", "אורנן"], reporter: { series: 'פ"מ', volume: 'התשמ"ז(ג)', page: "334" }, year: "1987" }, 'ת"פ (מקומיים י-ם) 2857/85 מדינת ישראל נ\' אורנן, פ"מ התשמ"ז(ג) 334 (1987).'],
  ["Unpublished ruling in Nevo", { kind: "ruling", proceeding: 'ת"כ', court: "תחרות", number: "745-07-18", parties: ['בנק מזרחי טפחות בע"מ', "הממונה על התחרות"], database: { name: "נבו", date: "2019-11-28" } }, 'ת"כ (תחרות) 745-07-18 בנק מזרחי טפחות בע"מ נ\' הממונה על התחרות (נבו 28.11.2019).'],
  ["Unpublished, pinpoint in one judge's opinion, the judiciary's site", { kind: "ruling", proceeding: 'בג"ץ', number: "8300/02", parties: ["נסר", "ממשלת ישראל"], database: { name: 'אר"ש', date: "2012-05-22" }, pinpoint: { paras: "35–36", judge: "הנשיאה (בדימ') ביניש" } }, 'בג"ץ 8300/02 נסר נ\' ממשלת ישראל, פס\' 35–36 לפסק הדין של הנשיאה (בדימ\') ביניש (אר"ש 22.5.2012).'],
  ["Primary legislation", { kind: "law", name: "חוק איסור נהיגה ברכב בחוף הים", hebrewYear: 'התשנ"ז', year: "1997", page: "84" }, 'חוק איסור נהיגה ברכב בחוף הים, התשנ"ז–1997, ס"ח 84.'],
  ["A section of a Basic Law, cited by its collection year", { kind: "law", name: "חוק-יסוד: הממשלה", section: "10", collectionYear: 'התשס"א', page: "158", pinpointPage: "159" }, 'ס\' 10 לחוק-יסוד: הממשלה, ס"ח התשס"א 158, 159.'],
  ["Regulations", { kind: "regulation", name: "תקנות הנמלים (תיקון מס' 3)", hebrewYear: 'התשמ"א', year: "1981", page: "956" }, 'תקנות הנמלים (תיקון מס\' 3), התשמ"א–1981, ק"ת 956.'],
  ["Government bill", { kind: "bill", name: "הצעת חוק ההתיישנות", hebrewYear: 'התשס"ד', year: "2004", page: "611" }, 'הצעת חוק ההתיישנות, התשס"ד–2004, ה"ח הממשלה 611.'],
  ["Book", { kind: "book", authors: ["אהרן ברק"], title: "פרשנות במשפט", volume: "כרך שני: פרשנות החקיקה", year: "1993" }, "אהרן ברק פרשנות במשפט כרך שני: פרשנות החקיקה (1993)."],
  ["Law-review article with parts", { kind: "article", authors: ["יפה זילברשץ"], title: "על חופש הביטוי המסחרי", journal: "משפט וממשל", volume: "ג", page: "509", pinpoint: "חלקים ד(3)-(4)", year: "1996" }, 'יפה זילברשץ "על חופש הביטוי המסחרי" משפט וממשל ג 509, חלקים ד(3)-(4) (1996).'],
  // The same rules, other sources.
  ["Civil appeal, printed, pinpoint", { kind: "ruling", proceeding: 'ע"א', number: "6821/93", parties: ['בנק המזרחי המאוחד בע"מ', "מגדל כפר שיתופי"], reporter: { series: 'פ"ד', volume: "מט(4)", page: "221" }, pinpoint: { paras: "80" }, year: "1995" }, 'ע"א 6821/93 בנק המזרחי המאוחד בע"מ נ\' מגדל כפר שיתופי, פ"ד מט(4) 221, פס\' 80 (1995).'],
  ["Criminal appeal in Nevo", { kind: "ruling", proceeding: 'ע"פ', number: "1234/20", parties: ["פלוני", "מדינת ישראל"], database: { name: "נבו", date: "2021-03-04" } }, 'ע"פ 1234/20 פלוני נ\' מדינת ישראל (נבו 4.3.2021).'],
  ["District court civil claim in Nevo", { kind: "ruling", proceeding: 'ת"א', court: 'מחוזי ת"א', number: "12345-06-19", parties: ["כהן", "לוי"], database: { name: "נבו", date: "2022-01-15" } }, 'ת"א (מחוזי ת"א) 12345-06-19 כהן נ\' לוי (נבו 15.1.2022).'],
  ["Labour court with a judge's paragraph", { kind: "ruling", proceeding: 'ע"ע', court: "ארצי", number: "300274/96", parties: ["סעדה", 'הום סנטר (עשה זאת בעצמך) בע"מ'], database: { name: "נבו", date: "2001-05-02" }, pinpoint: { paras: "7", judge: "השופט רבינוביץ" } }, 'ע"ע (ארצי) 300274/96 סעדה נ\' הום סנטר (עשה זאת בעצמך) בע"מ, פס\' 7 לפסק הדין של השופט רבינוביץ (נבו 2.5.2001).'],
  ["Further hearing, printed", { kind: "ruling", proceeding: 'דנ"א', number: "4465/98", parties: ['טבעול (1993) בע"מ', 'שף-הים (1994) בע"מ'], reporter: { series: 'פ"ד', volume: "נו(1)", page: "56" }, year: "2001" }, 'דנ"א 4465/98 טבעול (1993) בע"מ נ\' שף-הים (1994) בע"מ, פ"ד נו(1) 56 (2001).'],
  ["A section of a law with a pinpoint page", { kind: "law", name: "חוק החוזים (חלק כללי)", section: "39", hebrewYear: 'התשל"ג', year: "1973", page: "118", pinpointPage: "122" }, 'ס\' 39 לחוק החוזים (חלק כללי), התשל"ג–1973, ס"ח 118, 122.'],
  ["Knesset bill", { kind: "bill", name: "הצעת חוק הגנת הפרטיות (תיקון מס' 14)", hebrewYear: 'התשפ"א', year: "2021", collection: 'ה"ח הכנסת', page: "120" }, 'הצעת חוק הגנת הפרטיות (תיקון מס\' 14), התשפ"א–2021, ה"ח הכנסת 120.'],
  ["Book by two authors, edition and pinpoint", { kind: "book", authors: ["גבריאלה שלו", "אפי צמח"], title: "דיני חוזים", pinpoint: "עמ' 140", edition: "מהדורה רביעית", year: "2019" }, "גבריאלה שלו ואפי צמח דיני חוזים עמ' 140 (מהדורה רביעית 2019)."],
  ["Article with an issue and a pinpoint page", { kind: "article", authors: ["מרדכי קרמניצר"], title: "המשפט הפלילי בעידן החוקתי", journal: "משפטים", volume: "כח", issue: "1", page: "45", pinpoint: "50", year: "1997" }, 'מרדכי קרמניצר "המשפט הפלילי בעידן החוקתי" משפטים כח(1) 45, 50 (1997).'],
  ["Article by three authors, one named in Latin letters", { kind: "article", authors: ["דפנה ברק-ארז", "אסף הראל", "Smith"], title: "מבוא", journal: "עיוני משפט", volume: "מ", page: "1", year: "2017" }, 'דפנה ברק-ארז, אסף הראל ו-Smith "מבוא" עיוני משפט מ 1 (2017).'],
];

describe("כללי האזכור האחיד: 20 golden legal citations", () => {
  it("there are 20", () => expect(GOLDEN.length).toBe(20));
  for (const [name, src, want] of GOLDEN) it(name, () => expect(formatLegal(src)).toBe(want));
});

describe("legal citation helpers", () => {
  it("Hebrew years as legislation writes them", () => {
    expect(hebrewYearText(5757)).toBe('התשנ"ז');
    expect(hebrewYearText(5781)).toBe('התשפ"א');
    expect(hebrewYearText(5715)).toBe('התשט"ו');
    expect(hebrewYearText(5716)).toBe('התשט"ז');
    expect(hebrewYearText(5700)).toBe('הת"ש');
    expect(hebrewYearOfDate("1997-03-05")).toBe('התשנ"ז');
    expect(hebrewYearOfDate("1997-10-05")).toBe('התשנ"ח');
    expect(hebrewYearOfDate("soon")).toBeNull();
  });

  it("dates without leading zeros; names joined with a Hebrew and", () => {
    expect(ruleDate("2012-05-22")).toBe("22.5.2012");
    expect(ruleDate("04/03/2021")).toBe("4.3.2021");
    expect(joinNames(["אהרן ברק", "בני שגיא"])).toBe("אהרן ברק ובני שגיא");
    expect(joinNames(["א", "ב", "ג"])).toBe("א, ב וג");
  });

  it("finds case numbers in text, with either quote mark, and the court in parentheses", () => {
    const text = 'כפי שנפסק בע"א 1234/05 ובבג״ץ 7/48, וכן ת"א (מחוזי ת"א) 12345-06-19 ורע"א 999/21.';
    const found = findCaseNumbers(text).map((m) => [m.proceeding, m.court ?? "", m.number]);
    expect(found).toEqual([
      ['ע"א', "", "1234/05"],
      ['בג"ץ', "", "7/48"],
      ['ת"א', 'מחוזי ת"א', "12345-06-19"],
      ['רע"א', "", "999/21"],
    ]);
  });

  it("does not take a longer abbreviation's tail (רע\"א is not ע\"א) or a bare number", () => {
    expect(findCaseNumbers('רע"א 5/20').map((m) => m.proceeding)).toEqual(['רע"א']);
    expect(findCaseNumbers("ראו 1234/05 שם")).toEqual([]);
  });

  it("the case number at the cursor starts a ruling for the picker", () => {
    const text = 'ראו ע"פ 1234/20 שם';
    const m = caseNumberAt(text, 6)!;
    expect(rulingFromMatch(m)).toEqual({ kind: "ruling", proceeding: 'ע"פ', court: undefined, number: "1234/20", parties: ["", ""], database: { name: "נבו", date: "" } });
    expect(caseNumberAt(text, 0)).toBeNull();
  });
});
