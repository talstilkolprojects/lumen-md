---
title: Legal citations (Israel)
description: Rulings, laws, bills, books and articles by the Israeli uniform citation rules, and a citation from a case number in the note.
---

Lumen writes legal citations by **כללי האזכור האחיד בכתיבה המשפטית**, the third edition
(Tel Aviv University Faculty of Law, February 2021), which most Israeli law reviews and
faculties follow. Academic sources outside law use the
[Israeli APA style](/editor/citations/) ("APA 7 — Israeli academic").

## Insert a legal citation

Command palette → **Citations: legal source (uniform citation rules)…**. Choose the kind of
source, fill in the fields, and the citation is written as you type. **Insert** puts it at
the cursor, as plain text in the note, so it reads the same in the preview, in print and in
a DOCX or PDF export.

| Source | Example |
|---|---|
| Supreme Court, printed | `בג"ץ 7/48 אל-כרבוטלי נ' שר-הבטחון, פ"ד ב 5, פס' 14 (1949).` |
| Lower court, printed | `ת"פ (מקומיים י-ם) 2857/85 מדינת ישראל נ' אורנן, פ"מ התשמ"ז(ג) 334 (1987).` |
| Unpublished (Nevo) | `ת"כ (תחרות) 745-07-18 בנק מזרחי טפחות בע"מ נ' הממונה על התחרות (נבו 28.11.2019).` |
| One judge's paragraphs | `בג"ץ 8300/02 נסר נ' ממשלת ישראל, פס' 35–36 לפסק הדין של הנשיאה (בדימ') ביניש (אר"ש 22.5.2012).` |
| Law | `חוק איסור נהיגה ברכב בחוף הים, התשנ"ז–1997, ס"ח 84.` |
| A section of a Basic Law | `ס' 10 לחוק-יסוד: הממשלה, ס"ח התשס"א 158, 159.` |
| Regulations | `תקנות הנמלים (תיקון מס' 3), התשמ"א–1981, ק"ת 956.` |
| Bill | `הצעת חוק ההתיישנות, התשס"ד–2004, ה"ח הממשלה 611.` |
| Book | `אהרן ברק פרשנות במשפט כרך שני: פרשנות החקיקה (1993).` |
| Article | `יפה זילברשץ "על חופש הביטוי המסחרי" משפט וממשל ג 509, חלקים ד(3)-(4) (1996).` |

- A **printed** ruling takes its report (פ"ד, פ"מ), volume, first page and year. Leave the
  report empty for an **unpublished** one, and give the database (נבו, אר"ש) and the date.
- The **Supreme Court** has no court in parentheses; every other court does.
- A **law**: type a date (`1997-03-05`) in the year field and the Hebrew year is filled in
  (התשנ"ז). A Basic Law is cited by its collection year instead.
- **Authors** are full names, separated by commas; Hebrew joins the last one with ו
  (אהרן ברק ובני שגיא).

## From a case number in the note

Put the cursor on a case number such as `ע"א 1234/05`, `בבג״ץ 7/48` or
`ת"א (מחוזי ת"א) 12345-06-19`, and run **Citations: legal citation from the case number at
the cursor**. The picker opens with the proceeding, the court and the number filled in;
the citation you insert replaces the number. Lumen knows the common proceedings of every
court: ע"א, רע"א, דנ"א, בג"ץ, ע"פ, רע"פ, בש"פ, עע"מ, ת"א, ת"פ, ה"פ, ת"צ, ע"ע, תמ"ש and more.
Prefix letters (בע"א, ובבג"ץ) and both quote marks (" and ״) are understood.

## Checked

`src/__tests__/legalCitations.test.ts` holds 20 golden legal citations: the rules' own
examples and the same rules applied to other sources. `israeliAcademicCitations.test.ts`
holds 20 academic ones in Israeli APA. The plan asks a law student to approve at least 38 of
the 40; that review has not been done yet.
