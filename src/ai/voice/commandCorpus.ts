/**
 * Plan W5.20 — 200 spoken commands (10 per intent: 6 Hebrew, 4 English),
 * as people say them: with fillers, courtesy words, a glued "ו", different
 * verbs. The intent test scores the grammar on this text; the owner reads
 * the same 200 aloud (different speakers) for `npm run eval:voice-commands`,
 * which scores them through the speech model. Plus 20 sentences that are
 * not commands, which must not run anything.
 */
import type { IntentId } from "./intents";

export interface SpokenCommand {
  text: string;
  intent: IntentId;
  /** The slot the command carries, when it has one. */
  slot?: string;
}

const rows: Array<[IntentId, string, string?]> = [
  ["new-note", "צור פתק חדש בשם רשימת קניות", "רשימת קניות"], ["new-note", "פתק חדש", undefined], ["new-note", "בבקשה צור פתק על הטיול לאילת", "הטיול לאילת"], ["new-note", "תיצור פתק פגישה עם דנה", "פגישה עם דנה"], ["new-note", "אממ פתק חדש רעיונות לספר", "רעיונות לספר"], ["new-note", "ותפתח פתק חדש", undefined],
  ["new-note", "create a new note called groceries", "groceries"], ["new-note", "new note", undefined], ["new-note", "please make a note about the offsite", "the offsite"], ["new-note", "start a new note", undefined],
  ["search", "חפש מתכון לשקשוקה", "מתכון לשקשוקה"], ["search", "תחפש בפתקים על תקציב", "תקציב"], ["search", "מצא את הפגישה עם יוסי", "הפגישה עם יוסי"], ["search", "חיפוש חזרה מרווחת", "חזרה מרווחת"], ["search", "היי לומן חפש קוברנטיס", "קוברנטיס"], ["search", "ותמצא לי את דוח הרבעון", "דוח הרבעון"],
  ["search", "search for budget review", "budget review"], ["search", "find the meeting with Dana", "the meeting with dana"], ["search", "search my notes for kubernetes", "kubernetes"], ["search", "look for tax receipts", "tax receipts"],
  ["add-task", "הוסף משימה להתקשר לרופא", "להתקשר לרופא"], ["add-task", "משימה חדשה לקנות חלב", "לקנות חלב"], ["add-task", "תזכיר לי לשלם חשבון חשמל", "לשלם חשבון חשמל"], ["add-task", "תוסיף משימה לשלוח את המצגת", "לשלוח את המצגת"], ["add-task", "בבקשה הוסף משימה לסדר את המחסן", "לסדר את המחסן"], ["add-task", "צור משימה לבדוק את הדוח", "לבדוק את הדוח"],
  ["add-task", "add a task call the plumber", "call the plumber"], ["add-task", "remind me to water the plants", "water the plants"], ["add-task", "new task review the pull request", "review the pull request"], ["add-task", "add task book flights", "book flights"],
  ["open-daily", "פתח את הפתק היומי"], ["open-daily", "פתק יומי"], ["open-daily", "הפתק היומי בבקשה"], ["open-daily", "פתח את היומן"], ["open-daily", "אממ פתק של היום"], ["open-daily", "היומן של היום"],
  ["open-daily", "open the daily note"], ["open-daily", "open today's note"], ["open-daily", "daily note please"], ["open-daily", "open my journal"],
  ["read-aloud", "הקרא את הפתק"], ["read-aloud", "תקריא"], ["read-aloud", "קרא בקול"], ["read-aloud", "בבקשה תקריא את הפתק"], ["read-aloud", "והקרא"], ["read-aloud", "הקראה"],
  ["read-aloud", "read this note aloud"], ["read-aloud", "read it aloud"], ["read-aloud", "please read aloud"], ["read-aloud", "read this to me"],
  ["stop-reading", "הפסק להקריא"], ["stop-reading", "תפסיק להקריא"], ["stop-reading", "עצור הקראה"], ["stop-reading", "די להקריא"], ["stop-reading", "רגע הפסק להקריא"], ["stop-reading", "טוב תפסיק להקריא"],
  ["stop-reading", "stop reading"], ["stop-reading", "stop reading aloud"], ["stop-reading", "please stop reading"], ["stop-reading", "be quiet"],
  ["capture", "לכידה מהירה"], ["capture", "רשום מהר"], ["capture", "פתק מהיר"], ["capture", "בבקשה לכידה מהירה"], ["capture", "אה פתק מהיר"], ["capture", "ולכידה מהירה"],
  ["capture", "quick capture"], ["capture", "quick note"], ["capture", "capture"], ["capture", "ok quick capture"],
  ["open-tasks", "פתח משימות"], ["open-tasks", "הראה משימות"], ["open-tasks", "רשימת המשימות"], ["open-tasks", "המשימות שלי"], ["open-tasks", "בבקשה פתח משימות"], ["open-tasks", "תוכל להראות משימות"],
  ["open-tasks", "open tasks"], ["open-tasks", "show my tasks"], ["open-tasks", "my tasks"], ["open-tasks", "show tasks please"],
  ["delete-note", "מחק את הפתק"], ["delete-note", "תמחק את הפתק"], ["delete-note", "מחק פתק"], ["delete-note", "העבר לאשפה"], ["delete-note", "זרוק לפח"], ["delete-note", "בבקשה מחק את הפתק"],
  ["delete-note", "delete this note"], ["delete-note", "delete the note"], ["delete-note", "move to trash"], ["delete-note", "please delete note"],
  ["save", "שמור"], ["save", "תשמור"], ["save", "שמור את הפתק"], ["save", "שמירה"], ["save", "שמור עכשיו"], ["save", "בבקשה שמור"],
  ["save", "save"], ["save", "save the note"], ["save", "save this"], ["save", "please save"],
  ["summarize", "סכם את הפתק"], ["summarize", "תסכם את הפתק"], ["summarize", "סכם"], ["summarize", "סיכום"], ["summarize", "אפשר סיכום"], ["summarize", "ותסכם"],
  ["summarize", "summarize this note"], ["summarize", "summarize"], ["summarize", "give me a summary"], ["summarize", "could you summarize the note"],
  ["translate", "תרגם את הפתק"], ["translate", "תתרגם"], ["translate", "תרגם"], ["translate", "בבקשה תרגם את הפתק"], ["translate", "ותרגם"], ["translate", "טוב תרגם"],
  ["translate", "translate this note"], ["translate", "translate this"], ["translate", "translate"], ["translate", "please translate"],
  ["dictate", "התחל הכתבה"], ["dictate", "הכתבה"], ["dictate", "תכתוב מה שאני אומר"], ["dictate", "הכתב"], ["dictate", "בבקשה התחל הכתבה"], ["dictate", "יאללה הכתבה"],
  ["dictate", "start dictation"], ["dictate", "dictation"], ["dictate", "dictate"], ["dictate", "take dictation"],
  ["toggle-theme", "מצב כהה"], ["toggle-theme", "מצב לילה"], ["toggle-theme", "מצב בהיר"], ["toggle-theme", "החלף ערכת נושא"], ["toggle-theme", "שנה צבעים"], ["toggle-theme", "בבקשה מצב כהה"],
  ["toggle-theme", "dark mode"], ["toggle-theme", "light mode"], ["toggle-theme", "switch theme"], ["toggle-theme", "night mode please"],
  ["open-settings", "פתח הגדרות"], ["open-settings", "הגדרות"], ["open-settings", "תפתח את ההגדרות"], ["open-settings", "בבקשה פתח הגדרות"], ["open-settings", "והגדרות"], ["open-settings", "אממ הגדרות"],
  ["open-settings", "open settings"], ["open-settings", "settings"], ["open-settings", "preferences"], ["open-settings", "can you open settings"],
  ["open-calendar", "פתח לוח שנה"], ["open-calendar", "לוח שנה"], ["open-calendar", "הראה לוח שנה"], ["open-calendar", "פתח יומן חודשי"], ["open-calendar", "בבקשה לוח שנה"], ["open-calendar", "ופתח לוח שנה"],
  ["open-calendar", "open the calendar"], ["open-calendar", "calendar"], ["open-calendar", "show calendar"], ["open-calendar", "open calendar please"],
  ["open-graph", "תצוגת גרף"], ["open-graph", "פתח גרף"], ["open-graph", "הראה גרף"], ["open-graph", "גרף הקשרים"], ["open-graph", "בבקשה פתח גרף"], ["open-graph", "ותצוגת גרף"],
  ["open-graph", "graph view"], ["open-graph", "open graph"], ["open-graph", "show the graph"], ["open-graph", "show graph"],
  ["outline", "תוכן עניינים"], ["outline", "הראה כותרות"], ["outline", "מתאר"], ["outline", "ראשי פרקים"], ["outline", "בבקשה תוכן עניינים"], ["outline", "ותוכן עניינים"],
  ["outline", "outline"], ["outline", "show outline"], ["outline", "table of contents"], ["outline", "show headings"],
  ["backlinks", "קישורים חוזרים"], ["backlinks", "מי מקשר לכאן"], ["backlinks", "הראה קישורים"], ["backlinks", "בבקשה קישורים חוזרים"], ["backlinks", "וקישורים חוזרים"], ["backlinks", "אממ מי מקשר לכאן"],
  ["backlinks", "backlinks"], ["backlinks", "show backlinks"], ["backlinks", "what links here"], ["backlinks", "ok show backlinks"],
  ["check-grammar", "בדוק דקדוק"], ["check-grammar", "תבדוק דקדוק"], ["check-grammar", "בדיקת דקדוק"], ["check-grammar", "בדוק איות"], ["check-grammar", "בבקשה בדוק דקדוק"], ["check-grammar", "ובדוק דקדוק"],
  ["check-grammar", "check grammar"], ["check-grammar", "check spelling"], ["check-grammar", "proofread"], ["check-grammar", "please check grammar"],
];

export const SPOKEN_COMMANDS: SpokenCommand[] = rows.map(([intent, text, slot]) => ({ intent, text, ...(slot ? { slot } : {}) }));

/** Sentences that are not commands: dictated text must never run one. */
export const NOT_COMMANDS: string[] = [
  "הפגישה נדחתה ליום חמישי",
  "שמור את זה בצד לבינתיים",
  "אני חושב שהסיכום של דנה היה טוב",
  "קראתי את הספר בקול רם לילדים",
  "המשימה הייתה קשה מהצפוי",
  "בלוח השנה העברי יש שלוש עשרה חודשים בשנה מעוברת",
  "הגדרתי את המטרות לרבעון",
  "מחר נחפש דירה חדשה",
  "הפתק נמצא במגירה",
  "תודה רבה לכולם",
  "the meeting moved to thursday",
  "save the date for the wedding",
  "we should translate the brochure next week",
  "my calendar is full",
  "the graph shows a clear trend",
  "deleting old files is on my list",
  "she read the letter aloud",
  "settings on the camera were wrong",
  "outline of the talk is ready",
  "thanks everyone",
];
