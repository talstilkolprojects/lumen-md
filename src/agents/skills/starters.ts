/**
 * The six starter skills (plan W7.1), in Hebrew, as SKILL.md text in the
 * Agent Skills format. They ship with Lumen (trusted) and can be copied to
 * `.lumen/skills/<name>/SKILL.md` to edit. Each declares only the tools it
 * needs; the ones that change notes do it through write tools, which stage
 * the change for the review screen.
 */
import { parseSkill, type Skill } from "./skillFile";

const skill = (name: string, titleHe: string, titleEn: string, description: string, tools: string, body: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nallowed-tools: ${tools}\nmetadata:\n  title-he: ${JSON.stringify(titleHe)}\n  title-en: ${JSON.stringify(titleEn)}\n---\n${body.trim()}\n`;

export const STARTER_SKILL_FILES: Readonly<Record<string, string>> = {
  "weekly-reading": skill(
    "weekly-reading",
    "סכם את מה שקראתי השבוע",
    "Summarise what I read this week",
    "Summarise the notes, clips and highlights the user read or changed in the last seven days. Use when the user asks what they read this week.",
    "list_files read_file get_frontmatter",
    `
# סיכום הקריאה של השבוע

1. קרא את רשימת הקבצים (list_files) ובחר את הפתקים מ-7 הימים האחרונים לפי תאריך השינוי, תיקיית clips/ או highlights/, או \`date\` ב-frontmatter.
2. קרא כל פתק (read_file). אל תמציא תוכן שלא כתוב בפתקים.
3. כתוב סיכום בעברית: כותרת ״מה קראתי השבוע״, ואז לכל נושא 2–3 משפטים עם קישור [[שם הפתק]] למקור.
4. בסוף: ״שאלות פתוחות״ — עד שלוש שאלות שעולות מהקריאה.
אם אין פתקים מהשבוע, אמור זאת במשפט אחד.`,
  ),
  "sort-inbox": skill(
    "sort-inbox",
    "מיין את ה-inbox",
    "Sort the inbox",
    "Sort the notes in the inbox folder: propose a folder and tags for each, as reviewable changes. Use when the user asks to sort, triage or file the inbox.",
    "list_files read_file list_tags set_frontmatter",
    `
# מיון ה-inbox

1. מצא את הפתקים בתיקייה inbox/ (או Inbox/) עם list_files.
2. קרא כל פתק, ואת רשימת התגיות הקיימות (list_tags). העדף תגיות קיימות על פני תגיות חדשות.
3. לכל פתק הצע \`tags\` ו-\`folder\` ב-frontmatter עם set_frontmatter. זו הצעה: המשתמש מאשר אותה במסך האישור.
4. אל תמחק ואל תעביר קבצים. בסוף כתוב טבלה: פתק | תיקייה מוצעת | תגיות.`,
  ),
  "book-breakdown": skill(
    "book-breakdown",
    "פרק ספר לפרקים וכרטיסים",
    "Break a book into chapters and cards",
    "Break a long book or document into chapter notes and question-answer study cards. Use when the user asks to break down a book.",
    "get_document read_file write_file",
    `
# פירוק ספר

1. קרא את המסמך הפתוח (get_document), או את הקובץ שהמשתמש ציין (read_file).
2. זהה את הפרקים לפי הכותרות (#, ##) או לפי מעברי נושא.
3. לכל פרק הצע פתק חדש \`books/<שם הספר>/<מספר>-<שם הפרק>.md\` (write_file) עם: סיכום של 3–5 משפטים מתוך הטקסט, ו-3 כרטיסים בפורמט:
   \`שאלה :: תשובה\`
4. כל משפט בסיכום צריך להיות נאמן לטקסט. אל תוסיף ידע חיצוני.`,
  ),
  "similar-notes": skill(
    "similar-notes",
    "מצא פתקים דומים",
    "Find similar notes",
    "Find notes similar to the open note and explain in one line why each is related. Use when the user asks for related or similar notes.",
    "get_document search_workspace read_file",
    `
# פתקים דומים

1. קרא את הפתק הפתוח (get_document) וחלץ 3–6 מונחי מפתח (כולל צורות בלי תחיליות: ה, ו, ב, ל, מ, ש, כ).
2. חפש כל מונח (search_workspace) ואסוף את הפתקים שחוזרים.
3. קרא את 5 המועמדים הטובים ביותר (read_file) כדי לוודא שהם באמת קשורים.
4. כתוב רשימה: [[שם הפתק]] — שורה אחת שמסבירה את הקשר. בלי הפתק הפתוח עצמו.`,
  ),
  "literature-matrix": skill(
    "literature-matrix",
    "הכן מטריצת ספרות",
    "Build a literature matrix",
    "Build a literature review matrix (source, question, method, findings, limits) from the notes in a folder. Use when the user asks for a literature matrix or review table.",
    "list_files read_file get_frontmatter write_file",
    `
# מטריצת ספרות

1. מצא את פתקי המקורות בתיקייה שהמשתמש ציין (ברירת מחדל: sources/ או literature/).
2. לכל מקור קרא את הפתק ואת ה-frontmatter (author, year, title).
3. בנה טבלת Markdown: מקור | שאלת מחקר | שיטה | ממצאים | מגבלות. כל תא — מתוך הפתק בלבד; אם חסר, כתוב ״—״.
4. הצע פתק חדש \`literature-matrix.md\` (write_file) עם הטבלה, ומתחתיה שלוש פסקאות: הסכמות, מחלוקות ופערים.`,
  ),
  "check-citations": skill(
    "check-citations",
    "בדוק ציטוטים",
    "Check citations",
    "Check that every quotation and reference in the open note matches its source note, and list the ones that do not. Use when the user asks to check quotes or citations.",
    "get_document search_workspace read_file",
    `
# בדיקת ציטוטים

1. קרא את הפתק הפתוח (get_document). מצא כל ציטוט (טקסט במירכאות ״...״ או "...", או שורת > ) וכל הפניה ([[מקור]], [@key], או הפניה לספריא כמו ״בראשית א, א״).
2. לכל ציטוט עם מקור בכספת: קרא את המקור (read_file) ובדוק שהטקסט מופיע בו מילה במילה (מותר הבדל בניקוד ובפיסוק).
3. כתוב טבלה: ציטוט | מקור | ✓ תואם / ✗ לא נמצא / ? אין מקור בכספת.
4. אל תתקן את הפתק; רק דווח.`,
  ),
};

/** The starter skills, parsed (a starter that fails to parse is a bug: tests hold them). */
export function starterSkills(): Skill[] {
  const out: Skill[] = [];
  for (const [folder, text] of Object.entries(STARTER_SKILL_FILES)) {
    const p = parseSkill(text, { kind: "starter" }, folder);
    if (p.ok) out.push(p.skill);
  }
  return out;
}
