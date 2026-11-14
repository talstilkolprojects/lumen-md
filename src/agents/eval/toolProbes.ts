/**
 * Plan W4.31 — 200 tool-call probes, 100 in Hebrew and 100 in English: one
 * user request each, a set of offered tools (the right one and four
 * others), and the call a correct model makes. Ten of the runtime's real
 * tools, ten requests per tool and language. The tool specs below are the
 * real tools' names and parameter schemas (src/agents/tools/), copied so
 * the probes load without the tools' dependencies; toolProbes.test.ts
 * fails when they drift.
 */

import type { JsonSchema } from "../types";

export interface ProbeTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolProbe {
  id: string;
  lang: "he" | "en";
  prompt: string;
  /** Names of the offered tools; the expected one is among them. */
  tools: string[];
  expect: { tool: string; args: Record<string, unknown> };
}

const str = (extra: Record<string, unknown> = {}) => ({ type: "string", minLength: 1, ...extra });

export const PROBE_TOOLS: ProbeTool[] = [
  { name: "search_workspace", description: "Full-text search over the workspace's notes. Returns matching paths with a snippet.", parameters: { type: "object", properties: { query: { type: "string", minLength: 1 }, limit: { type: "number", minimum: 1 }, folder: { type: "string", description: "Only files under this folder, e.g. Library/" } }, required: ["query"], additionalProperties: false } },
  { name: "read_file", description: "Read a file from the workspace.", parameters: { type: "object", properties: { path: { type: "string", minLength: 1, description: "Workspace path, e.g. notes/todo.md" }, maxChars: { type: "number", minimum: 1 }, offset: { type: "number", minimum: 0 } }, required: ["path"], additionalProperties: false } },
  { name: "list_files", description: "List workspace files, optionally under a folder prefix.", parameters: { type: "object", properties: { prefix: { type: "string", description: "Folder prefix, e.g. projects/" }, limit: { type: "number", minimum: 1 }, offset: { type: "number", minimum: 0 }, modifiedSince: { type: "number", minimum: 0, description: "Only files modified after this time (ms since epoch)" }, withModified: { type: "boolean" } }, additionalProperties: false } },
  { name: "list_tags", description: "The workspace's tags with how many notes use each, most used first.", parameters: { type: "object", properties: { limit: { type: "number", minimum: 1 } }, additionalProperties: false } },
  { name: "get_frontmatter", description: "Read a note's YAML frontmatter as JSON.", parameters: { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false } },
  { name: "set_frontmatter", description: "Propose frontmatter changes to a note (staged for the user's approval).", parameters: { type: "object", properties: { path: { type: "string", minLength: 1, description: "Workspace path; default: the open document" }, set: { type: "object", description: "Keys to add or replace, with JSON values" }, remove: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 50 } }, additionalProperties: false } },
  { name: "write_file", description: "Propose writing a file (staged for the user's approval).", parameters: { type: "object", properties: { path: { type: "string", minLength: 1 }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "search_web", description: "Search the web. Needs the user's consent under the local-only policy.", parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 400 }, count: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false } },
  { name: "fetch_page", description: "Fetch a web page as text.", parameters: { type: "object", properties: { url: { type: "string", pattern: "^https?://", maxLength: 2000 }, maxChars: { type: "integer", minimum: 200, maximum: 12000 } }, required: ["url"], additionalProperties: false } },
  { name: "validate_mermaid", description: "Check Mermaid diagram code; returns the parse error if any.", parameters: { type: "object", properties: { code: str() }, required: ["code"], additionalProperties: false } },
];

type Row = [prompt: string, args: Record<string, unknown>];

/** Ten requests per tool and language: [prompt, the arguments a correct call has]. */
const ROWS: Record<string, { en: Row[]; he: Row[] }> = {
  search_workspace: {
    en: [
      ["Find my notes about the budget review.", { query: "budget review" }],
      ["Search my notes for 'onboarding checklist'.", { query: "onboarding checklist" }],
      ["Which of my notes mention Kubernetes?", { query: "Kubernetes" }],
      ["Look for notes about the trip to Lisbon, just the top 5.", { query: "Lisbon", limit: 5 }],
      ["Search the Library/ folder for anything on spaced repetition.", { query: "spaced repetition", folder: "Library/" }],
      ["Do I have a note that talks about tax deductions?", { query: "tax deductions" }],
      ["Find notes containing the word quarterly.", { query: "quarterly" }],
      ["Search for 'Dana' in my notes, at most 3 results.", { query: "Dana", limit: 3 }],
      ["Where did I write about the database migration?", { query: "database migration" }],
      ["Search projects/ for the word deadline.", { query: "deadline", folder: "projects/" }],
    ],
    he: [
      ["חפש בפתקים שלי על סקירת התקציב.", { query: "סקירת התקציב" }],
      ["מצא פתקים שמזכירים את ״רשימת קליטה״.", { query: "רשימת קליטה" }],
      ["באילו פתקים כתבתי על קוברנטיס?", { query: "קוברנטיס" }],
      ["חפש פתקים על הטיול לליסבון, רק 5 התוצאות הראשונות.", { query: "ליסבון", limit: 5 }],
      ["חפש בתיקייה Library/ משהו על חזרה מרווחת.", { query: "חזרה מרווחת", folder: "Library/" }],
      ["יש לי פתק על זיכויי מס?", { query: "זיכויי מס" }],
      ["מצא פתקים עם המילה רבעוני.", { query: "רבעוני" }],
      ["חפש את ״דנה״ בפתקים, לכל היותר 3 תוצאות.", { query: "דנה", limit: 3 }],
      ["איפה כתבתי על הסבת מסד הנתונים?", { query: "הסבת מסד הנתונים" }],
      ["חפש בתיקייה projects/ את המילה דדליין.", { query: "דדליין", folder: "projects/" }],
    ],
  },
  read_file: {
    en: [
      ["Open notes/todo.md and read it.", { path: "notes/todo.md" }],
      ["What does projects/roadmap.md say?", { path: "projects/roadmap.md" }],
      ["Read the file journal/2026-11-01.md.", { path: "journal/2026-11-01.md" }],
      ["Show me the first 500 characters of Library/papers.md.", { path: "Library/papers.md", maxChars: 500 }],
      ["Read meetings/standup.md for me.", { path: "meetings/standup.md" }],
      ["Load ideas.md.", { path: "ideas.md" }],
      ["I need the contents of recipes/shakshuka.md.", { path: "recipes/shakshuka.md" }],
      ["Read work/okr-q4.md.", { path: "work/okr-q4.md" }],
      ["Open the file reading-list.md.", { path: "reading-list.md" }],
      ["Read notes/books/dune.md from character 1000 on.", { path: "notes/books/dune.md", offset: 1000 }],
    ],
    he: [
      ["פתח את notes/todo.md וקרא אותו.", { path: "notes/todo.md" }],
      ["מה כתוב בקובץ פרויקטים/מפת-דרכים.md?", { path: "פרויקטים/מפת-דרכים.md" }],
      ["קרא את הקובץ יומן/2026-11-01.md.", { path: "יומן/2026-11-01.md" }],
      ["הראה לי את 500 התווים הראשונים של Library/papers.md.", { path: "Library/papers.md", maxChars: 500 }],
      ["קרא בשבילי את פגישות/עמידה.md.", { path: "פגישות/עמידה.md" }],
      ["טען את רעיונות.md.", { path: "רעיונות.md" }],
      ["אני צריך את התוכן של מתכונים/שקשוקה.md.", { path: "מתכונים/שקשוקה.md" }],
      ["קרא את work/okr-q4.md.", { path: "work/okr-q4.md" }],
      ["פתח את הקובץ רשימת-קריאה.md.", { path: "רשימת-קריאה.md" }],
      ["קרא את notes/books/dune.md החל מתו 1000.", { path: "notes/books/dune.md", offset: 1000 }],
    ],
  },
  list_files: {
    en: [
      ["List the files in projects/.", { prefix: "projects/" }],
      ["What's in my journal/ folder?", { prefix: "journal/" }],
      ["Show me every file in the workspace.", {}],
      ["List the first 20 files under Library/.", { prefix: "Library/", limit: 20 }],
      ["Which files are in meetings/?", { prefix: "meetings/" }],
      ["List the notes in recipes/.", { prefix: "recipes/" }],
      ["Show the files in work/ with their modification times.", { prefix: "work/", withModified: true }],
      ["What files do I have in archive/2025/?", { prefix: "archive/2025/" }],
      ["List 10 files from notes/.", { prefix: "notes/", limit: 10 }],
      ["Show me the contents of the templates/ folder.", { prefix: "templates/" }],
    ],
    he: [
      ["הצג את הקבצים בתיקייה projects/.", { prefix: "projects/" }],
      ["מה יש בתיקייה יומן/?", { prefix: "יומן/" }],
      ["הראה לי את כל הקבצים בכספת.", {}],
      ["הצג את 20 הקבצים הראשונים תחת Library/.", { prefix: "Library/", limit: 20 }],
      ["אילו קבצים יש בפגישות/?", { prefix: "פגישות/" }],
      ["רשום את הפתקים במתכונים/.", { prefix: "מתכונים/" }],
      ["הצג את הקבצים ב-work/ עם זמני השינוי שלהם.", { prefix: "work/", withModified: true }],
      ["אילו קבצים יש לי בארכיון/2025/?", { prefix: "ארכיון/2025/" }],
      ["הצג 10 קבצים מ-notes/.", { prefix: "notes/", limit: 10 }],
      ["הראה לי מה יש בתיקייה תבניות/.", { prefix: "תבניות/" }],
    ],
  },
  list_tags: {
    en: [
      ["Which tags do I use most?", {}],
      ["Show my top 10 tags.", { limit: 10 }],
      ["List all my tags.", {}],
      ["What are my five most common tags?", { limit: 5 }],
      ["Give me the tag list with counts.", {}],
      ["Top 3 tags, please.", { limit: 3 }],
      ["How are my notes tagged overall?", {}],
      ["List 20 tags.", { limit: 20 }],
      ["Which tags exist in this vault?", {}],
      ["Show the 7 most used tags.", { limit: 7 }],
    ],
    he: [
      ["באילו תגיות אני משתמש הכי הרבה?", {}],
      ["הצג את 10 התגיות המובילות שלי.", { limit: 10 }],
      ["רשום את כל התגיות שלי.", {}],
      ["מהן חמש התגיות הנפוצות ביותר שלי?", { limit: 5 }],
      ["תן לי את רשימת התגיות עם הספירות.", {}],
      ["3 התגיות המובילות, בבקשה.", { limit: 3 }],
      ["איך הפתקים שלי מתויגים באופן כללי?", {}],
      ["הצג 20 תגיות.", { limit: 20 }],
      ["אילו תגיות קיימות בכספת הזאת?", {}],
      ["הצג את 7 התגיות שבשימוש הרב ביותר.", { limit: 7 }],
    ],
  },
  get_frontmatter: {
    en: [
      ["What's in the frontmatter of notes/todo.md?", { path: "notes/todo.md" }],
      ["Show the metadata of projects/roadmap.md.", { path: "projects/roadmap.md" }],
      ["Which tags does the frontmatter of ideas.md list?", { path: "ideas.md" }],
      ["Read the YAML header of journal/2026-11-01.md.", { path: "journal/2026-11-01.md" }],
      ["What status is set in work/okr-q4.md's properties?", { path: "work/okr-q4.md" }],
      ["Get the frontmatter of Library/papers.md.", { path: "Library/papers.md" }],
      ["Show the properties of meetings/standup.md.", { path: "meetings/standup.md" }],
      ["What date is in the frontmatter of recipes/shakshuka.md?", { path: "recipes/shakshuka.md" }],
      ["Read the metadata block of reading-list.md.", { path: "reading-list.md" }],
      ["Which author does notes/books/dune.md list in its frontmatter?", { path: "notes/books/dune.md" }],
    ],
    he: [
      ["מה יש ב-frontmatter של notes/todo.md?", { path: "notes/todo.md" }],
      ["הצג את המטא-דאטה של פרויקטים/מפת-דרכים.md.", { path: "פרויקטים/מפת-דרכים.md" }],
      ["אילו תגיות רשומות ב-frontmatter של רעיונות.md?", { path: "רעיונות.md" }],
      ["קרא את כותרת ה-YAML של יומן/2026-11-01.md.", { path: "יומן/2026-11-01.md" }],
      ["איזה סטטוס מוגדר במאפיינים של work/okr-q4.md?", { path: "work/okr-q4.md" }],
      ["הבא את ה-frontmatter של Library/papers.md.", { path: "Library/papers.md" }],
      ["הצג את המאפיינים של פגישות/עמידה.md.", { path: "פגישות/עמידה.md" }],
      ["איזה תאריך יש ב-frontmatter של מתכונים/שקשוקה.md?", { path: "מתכונים/שקשוקה.md" }],
      ["קרא את בלוק המטא-דאטה של רשימת-קריאה.md.", { path: "רשימת-קריאה.md" }],
      ["איזה מחבר רשום ב-frontmatter של notes/books/dune.md?", { path: "notes/books/dune.md" }],
    ],
  },
  set_frontmatter: {
    en: [
      ["Set status to done in notes/todo.md.", { path: "notes/todo.md", set: { status: "done" } }],
      ["Mark projects/roadmap.md as priority high in its properties.", { path: "projects/roadmap.md", set: { priority: "high" } }],
      ["Add the property owner: Dana to work/okr-q4.md.", { path: "work/okr-q4.md", set: { owner: "Dana" } }],
      ["Remove the draft property from ideas.md.", { path: "ideas.md", remove: ["draft"] }],
      ["Set rating to 5 in notes/books/dune.md.", { path: "notes/books/dune.md", set: { rating: 5 } }],
      ["In meetings/standup.md set the property recurring to true.", { path: "meetings/standup.md", set: { recurring: true } }],
      ["Change the status of reading-list.md to archived.", { path: "reading-list.md", set: { status: "archived" } }],
      ["Set the language of recipes/shakshuka.md's frontmatter to he.", { path: "recipes/shakshuka.md", set: { language: "he" } }],
      ["Remove the properties old and temp from Library/papers.md.", { path: "Library/papers.md", remove: ["old", "temp"] }],
      ["Set due to 2026-12-01 in journal/2026-11-01.md.", { path: "journal/2026-11-01.md", set: { due: "2026-12-01" } }],
    ],
    he: [
      ["קבע status ל-done בקובץ notes/todo.md.", { path: "notes/todo.md", set: { status: "done" } }],
      ["סמן במאפיינים של פרויקטים/מפת-דרכים.md את priority כ-high.", { path: "פרויקטים/מפת-דרכים.md", set: { priority: "high" } }],
      ["הוסף ל-work/okr-q4.md את המאפיין owner: דנה.", { path: "work/okr-q4.md", set: { owner: "דנה" } }],
      ["הסר את המאפיין draft מ-רעיונות.md.", { path: "רעיונות.md", remove: ["draft"] }],
      ["קבע rating ל-5 ב-notes/books/dune.md.", { path: "notes/books/dune.md", set: { rating: 5 } }],
      ["ב-פגישות/עמידה.md קבע את המאפיין recurring ל-true.", { path: "פגישות/עמידה.md", set: { recurring: true } }],
      ["שנה את ה-status של רשימת-קריאה.md ל-archived.", { path: "רשימת-קריאה.md", set: { status: "archived" } }],
      ["קבע language ל-he ב-frontmatter של מתכונים/שקשוקה.md.", { path: "מתכונים/שקשוקה.md", set: { language: "he" } }],
      ["הסר את המאפיינים old ו-temp מ-Library/papers.md.", { path: "Library/papers.md", remove: ["old", "temp"] }],
      ["קבע due ל-2026-12-01 ב-יומן/2026-11-01.md.", { path: "יומן/2026-11-01.md", set: { due: "2026-12-01" } }],
    ],
  },
  write_file: {
    en: [
      ["Create a note inbox/call-dana.md with the text: Call Dana about the offsite.", { path: "inbox/call-dana.md", content: "Call Dana about the offsite." }],
      ["Write 'Buy milk' into shopping.md.", { path: "shopping.md", content: "Buy milk" }],
      ["Make a new file ideas/app-name.md containing: Lumen Notes?", { path: "ideas/app-name.md", content: "Lumen Notes?" }],
      ["Save the text 'Standup moved to 10:00' as meetings/update.md.", { path: "meetings/update.md", content: "Standup moved to 10:00" }],
      ["Create journal/2026-11-12.md with '# Thursday'.", { path: "journal/2026-11-12.md", content: "# Thursday" }],
      ["Write a file todo/today.md that says: - [ ] review PR", { path: "todo/today.md", content: "- [ ] review PR" }],
      ["Put 'Draft v2' into drafts/essay.md.", { path: "drafts/essay.md", content: "Draft v2" }],
      ["Create notes/quote.md with the text: Simplicity is prerequisite for reliability.", { path: "notes/quote.md", content: "Simplicity is prerequisite for reliability." }],
      ["New note links.md with the content: https://example.com", { path: "links.md", content: "https://example.com" }],
      ["Write 'Ship it' to work/motto.md.", { path: "work/motto.md", content: "Ship it" }],
    ],
    he: [
      ["צור פתק inbox/להתקשר-לדנה.md עם הטקסט: להתקשר לדנה בעניין הכנס.", { path: "inbox/להתקשר-לדנה.md", content: "להתקשר לדנה בעניין הכנס." }],
      ["כתוב ״לקנות חלב״ לתוך קניות.md.", { path: "קניות.md", content: "לקנות חלב" }],
      ["צור קובץ חדש רעיונות/שם-לאפליקציה.md שמכיל: לומן?", { path: "רעיונות/שם-לאפליקציה.md", content: "לומן?" }],
      ["שמור את הטקסט ״העמידה הוזזה ל-10:00״ בתור פגישות/עדכון.md.", { path: "פגישות/עדכון.md", content: "העמידה הוזזה ל-10:00" }],
      ["צור יומן/2026-11-12.md עם ״# יום חמישי״.", { path: "יומן/2026-11-12.md", content: "# יום חמישי" }],
      ["כתוב קובץ משימות/היום.md שאומר: - [ ] לסקור PR", { path: "משימות/היום.md", content: "- [ ] לסקור PR" }],
      ["שים ״טיוטה 2״ בתוך טיוטות/מאמר.md.", { path: "טיוטות/מאמר.md", content: "טיוטה 2" }],
      ["צור notes/ציטוט.md עם הטקסט: פשטות היא תנאי לאמינות.", { path: "notes/ציטוט.md", content: "פשטות היא תנאי לאמינות." }],
      ["פתק חדש קישורים.md עם התוכן: https://example.com", { path: "קישורים.md", content: "https://example.com" }],
      ["כתוב ״לשחרר״ ל-work/מוטו.md.", { path: "work/מוטו.md", content: "לשחרר" }],
    ],
  },
  search_web: {
    en: [
      ["Search the web for the latest Ollama release notes.", { query: "Ollama release notes" }],
      ["Look up online how FSRS spaced repetition works.", { query: "FSRS spaced repetition" }],
      ["Find on the web: Hebrew speech recognition models.", { query: "Hebrew speech recognition models" }],
      ["Search the internet for WebGPU browser support, 5 results.", { query: "WebGPU browser support", count: 5 }],
      ["Google the population of Haifa.", { query: "population of Haifa" }],
      ["Search online for Markdown table syntax.", { query: "Markdown table syntax" }],
      ["Web search: best practices for local-first sync.", { query: "local-first sync best practices" }],
      ["Find articles on the web about Zettelkasten, 3 results.", { query: "Zettelkasten", count: 3 }],
      ["Search the web for the Mermaid gantt chart syntax.", { query: "Mermaid gantt syntax" }],
      ["Look up the weather in Tel Aviv on the web.", { query: "weather Tel Aviv" }],
    ],
    he: [
      ["חפש ברשת את הערות השחרור האחרונות של Ollama.", { query: "Ollama" }],
      ["חפש באינטרנט איך עובדת חזרה מרווחת FSRS.", { query: "FSRS" }],
      ["מצא ברשת: מודלים לזיהוי דיבור בעברית.", { query: "זיהוי דיבור בעברית" }],
      ["חפש באינטרנט תמיכה של דפדפנים ב-WebGPU, 5 תוצאות.", { query: "WebGPU", count: 5 }],
      ["חפש בגוגל את מספר התושבים בחיפה.", { query: "חיפה" }],
      ["חפש ברשת את התחביר של טבלה ב-Markdown.", { query: "Markdown" }],
      ["חיפוש ברשת: שיטות עבודה לסנכרון local-first.", { query: "local-first" }],
      ["מצא ברשת מאמרים על צטלקסטן, 3 תוצאות.", { query: "צטלקסטן", count: 3 }],
      ["חפש ברשת את התחביר של תרשים גאנט ב-Mermaid.", { query: "Mermaid" }],
      ["בדוק ברשת את מזג האוויר בתל אביב.", { query: "תל אביב" }],
    ],
  },
  fetch_page: {
    en: [
      ["Fetch the page https://example.com/docs.", { url: "https://example.com/docs" }],
      ["Open https://example.com/blog/post-1 and get its text.", { url: "https://example.com/blog/post-1" }],
      ["Download the text of https://example.org/changelog.", { url: "https://example.org/changelog" }],
      ["Get https://example.com/pricing, at most 2000 characters.", { url: "https://example.com/pricing", maxChars: 2000 }],
      ["Read the web page https://example.net/about.", { url: "https://example.net/about" }],
      ["Fetch https://example.com/faq for me.", { url: "https://example.com/faq" }],
      ["What does https://example.com/terms say? Fetch it.", { url: "https://example.com/terms" }],
      ["Pull the content of https://example.org/news/42.", { url: "https://example.org/news/42" }],
      ["Load https://example.com/guide?lang=en.", { url: "https://example.com/guide?lang=en" }],
      ["Fetch http://example.com/legacy.", { url: "http://example.com/legacy" }],
    ],
    he: [
      ["הבא את הדף https://example.com/docs.", { url: "https://example.com/docs" }],
      ["פתח את https://example.com/blog/post-1 וקח את הטקסט שלו.", { url: "https://example.com/blog/post-1" }],
      ["הורד את הטקסט של https://example.org/changelog.", { url: "https://example.org/changelog" }],
      ["הבא את https://example.com/pricing, לכל היותר 2000 תווים.", { url: "https://example.com/pricing", maxChars: 2000 }],
      ["קרא את דף האינטרנט https://example.net/about.", { url: "https://example.net/about" }],
      ["הבא בשבילי את https://example.com/faq.", { url: "https://example.com/faq" }],
      ["מה כתוב ב-https://example.com/terms? תביא את זה.", { url: "https://example.com/terms" }],
      ["משוך את התוכן של https://example.org/news/42.", { url: "https://example.org/news/42" }],
      ["טען את https://example.com/guide?lang=he.", { url: "https://example.com/guide?lang=he" }],
      ["הבא את http://example.com/legacy.", { url: "http://example.com/legacy" }],
    ],
  },
  validate_mermaid: {
    en: [
      ["Check this Mermaid diagram: graph TD; A-->B", { code: "graph TD; A-->B" }],
      ["Is this valid Mermaid? flowchart LR\n  start --> stop", { code: "flowchart LR\n  start --> stop" }],
      ["Validate: sequenceDiagram\n  Alice->>Bob: Hi", { code: "sequenceDiagram\n  Alice->>Bob: Hi" }],
      ["Does this Mermaid parse? pie title Pets\n  \"Dogs\" : 3", { code: "pie title Pets\n  \"Dogs\" : 3" }],
      ["Check the Mermaid code: graph LR; X-->", { code: "graph LR; X-->" }],
      ["Validate this diagram: stateDiagram-v2\n  [*] --> Idle", { code: "stateDiagram-v2\n  [*] --> Idle" }],
      ["Is my Mermaid correct? gantt\n  title Plan", { code: "gantt\n  title Plan" }],
      ["Check: classDiagram\n  class Note", { code: "classDiagram\n  class Note" }],
      ["Validate the Mermaid: erDiagram\n  NOTE ||--o{ TAG : has", { code: "erDiagram\n  NOTE ||--o{ TAG : has" }],
      ["Will this render? mindmap\n  root((Lumen))", { code: "mindmap\n  root((Lumen))" }],
    ],
    he: [
      ["בדוק את תרשים ה-Mermaid הזה: graph TD; א-->ב", { code: "graph TD; א-->ב" }],
      ["האם זה Mermaid תקין? flowchart LR\n  התחלה --> סוף", { code: "flowchart LR\n  התחלה --> סוף" }],
      ["אמת: sequenceDiagram\n  דנה->>טל: שלום", { code: "sequenceDiagram\n  דנה->>טל: שלום" }],
      ["האם ה-Mermaid הזה עובר? pie title חיות\n  \"כלבים\" : 3", { code: "pie title חיות\n  \"כלבים\" : 3" }],
      ["בדוק את קוד ה-Mermaid: graph LR; X-->", { code: "graph LR; X-->" }],
      ["אמת את התרשים: stateDiagram-v2\n  [*] --> ממתין", { code: "stateDiagram-v2\n  [*] --> ממתין" }],
      ["ה-Mermaid שלי נכון? gantt\n  title תוכנית", { code: "gantt\n  title תוכנית" }],
      ["בדוק: classDiagram\n  class Note", { code: "classDiagram\n  class Note" }],
      ["אמת את ה-Mermaid: erDiagram\n  NOTE ||--o{ TAG : has", { code: "erDiagram\n  NOTE ||--o{ TAG : has" }],
      ["זה יוצג? mindmap\n  root((לומן))", { code: "mindmap\n  root((לומן))" }],
    ],
  },
};

const NAMES = PROBE_TOOLS.map((t) => t.name);

/** The offered set: the expected tool and the four that follow it in the list (so the position varies). */
function offered(tool: string, i: number): string[] {
  const at = NAMES.indexOf(tool);
  const others = NAMES.filter((n) => n !== tool);
  const pick = [0, 1, 2, 3].map((k) => others[(at + i + k * 2) % others.length]);
  const set = [...new Set(pick)];
  set.splice(i % (set.length + 1), 0, tool);
  return set;
}

export const TOOL_PROBES: ToolProbe[] = Object.entries(ROWS).flatMap(([tool, langs]) =>
  (["en", "he"] as const).flatMap((lang) =>
    langs[lang].map(([prompt, args], i) => ({ id: `${tool}-${lang}-${i + 1}`, lang, prompt, tools: offered(tool, i), expect: { tool, args } })),
  ),
);
