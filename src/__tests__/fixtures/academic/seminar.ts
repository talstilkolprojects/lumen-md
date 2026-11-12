/**
 * A Hebrew seminar paper for the academic DOCX tests (plan W5.16): cover
 * fields in the frontmatter, chapters with sub-sections, footnotes, a
 * table, a list, an English quotation and a bibliography. `chapters`
 * repeats the body so the paper reaches about 20 pages at 12 pt, 1.5 lines.
 */
const PARAGRAPH =
  "המחקר בוחן כיצד סטודנטים בישראל משלבים כלים דיגיטליים בכתיבה אקדמית, ומה מקומה של השפה העברית בתהליך. " +
  "הספרות המקצועית מצביעה על פער בין הכלים הזמינים, שרובם נבנו לאנגלית, לבין צורכי הכותבים בעברית ובערבית. " +
  "פער זה ניכר בעיקר בעיצוב העבודה: כיוון הטקסט, הערות השוליים, מספור העמודים והביבליוגרפיה. " +
  "כפי שמציין Smith (2019), ״the tools shape the writing as much as the writer does״, ולכן יש לבחון אותם בזהירות.";

export function seminarMarkdown(chapters = 8): string {
  const out: string[] = [
    "---",
    "title: כלים דיגיטליים בכתיבה אקדמית בעברית",
    "subtitle: עבודה סמינריונית",
    "faculty: הפקולטה למדעי החברה",
    "department: המחלקה לחינוך",
    "course: סמינר בחקר הכתיבה",
    "course_number: 12-345",
    "lecturer: ד״ר רונית כהן",
    "author: ישראל ישראלי",
    "student_id: 012345678",
    "date: אדר תשפ״ו, מרץ 2026",
    "---",
    "",
  ];
  for (let c = 1; c <= chapters; c++) {
    out.push(`# פרק ${c}: ${c === 1 ? "מבוא" : `ממצאים, חלק ${c - 1}`}`, "");
    out.push(`${PARAGRAPH}[^c${c}a]`, "");
    out.push(`## ${c}.1 רקע`, "");
    for (let p = 0; p < 4; p++) out.push(PARAGRAPH, "");
    out.push(`## ${c}.2 שיטה`, "");
    out.push(`${PARAGRAPH} ראו גם את הטבלה שלהלן.[^c${c}b]`, "");
    if (c === 2) {
      out.push("| קבוצה | משתתפים | ממוצע |", "| :--- | ---: | ---: |", "| סטודנטים לתואר ראשון | 120 | 3.4 |", "| סטודנטים לתואר שני | 45 | 3.9 |", "");
      out.push("- ראיונות חצי-מובנים", "- שאלון מקוון", "- ניתוח מסמכים", "");
    }
    for (let p = 0; p < 3; p++) out.push(PARAGRAPH, "");
    out.push(`[^c${c}a]: כהן, ר. (2020). למידה מרחוק בעידן הקורונה. *דפים*, 72, 11–35.`);
    out.push(`[^c${c}b]: Smith, J. (2019). *Learning at a distance*. Journal of Education, 12(3), 45–67.`, "");
  }
  out.push("# ביבליוגרפיה", "");
  out.push("- כהן, ר. (2020). למידה מרחוק בעידן הקורונה. *דפים*, 72, 11–35.");
  out.push("- לוי, מ. ודרשן, ד. (2018). *מבוא לסטטיסטיקה*. האוניברסיטה הפתוחה.");
  out.push("- Smith, J., & Doe, J. (2019). Learning at a distance. *Journal of Education*, 12(3), 45–67.", "");
  return out.join("\n");
}
