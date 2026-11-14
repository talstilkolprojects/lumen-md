/**
 * Local voice commands (plan W5.20): a small intent grammar over the
 * dictation transcript, Hebrew first, English too. Nothing leaves the
 * device: the speech is the Zipformer's (6.1 / W4.13), the parsing is the
 * table below. Each intent runs one palette command; the ones with a slot
 * (a title, a query, a task) carry the words after the trigger. An intent
 * that removes something asks before it runs (`confirm`).
 */

export type IntentId =
  | "new-note"
  | "search"
  | "add-task"
  | "open-daily"
  | "read-aloud"
  | "stop-reading"
  | "capture"
  | "open-tasks"
  | "delete-note"
  | "save"
  | "summarize"
  | "translate"
  | "dictate"
  | "toggle-theme"
  | "open-settings"
  | "open-calendar"
  | "open-graph"
  | "outline"
  | "backlinks"
  | "check-grammar";

export interface IntentDef {
  id: IntentId;
  /** The palette command it runs. */
  command: string;
  /** Trigger phrases after normalisation (see normalizeCommand); the longest match wins. */
  he: string[];
  en: string[];
  /** The words after the trigger are the slot (title, query, task text). */
  slot?: "title" | "query" | "text";
  /** Ask before running: it removes something. */
  confirm?: boolean;
}

export const INTENTS: IntentDef[] = [
  { id: "new-note", command: "file.new", slot: "title", he: ["צור פתק חדש", "צור פתק", "פתק חדש", "פתח פתק חדש", "תיצור פתק", "תפתח פתק חדש", "רשומה חדשה"], en: ["create a new note", "create a note", "new note", "make a note", "start a new note"] },
  { id: "search", command: "view.search", slot: "query", he: ["חפש בפתקים", "תחפש בפתקים", "חפש", "תחפש", "חיפוש", "מצא", "תמצא"], en: ["search my notes for", "search for", "search", "find", "look for"] },
  { id: "add-task", command: "tasks.open", slot: "text", he: ["הוסף משימה", "תוסיף משימה", "משימה חדשה", "צור משימה", "תזכיר לי"], en: ["add a task", "add task", "new task", "create a task", "remind me to"] },
  { id: "open-daily", command: "note.today", he: ["פתח את הפתק היומי", "פתח פתק יומי", "הפתק היומי", "פתק יומי", "פתח את היומן", "היומן של היום", "פתק של היום"], en: ["open the daily note", "open today's note", "open daily note", "daily note", "today's note", "open my journal"] },
  { id: "read-aloud", command: "note.read", he: ["הקרא את הפתק", "תקריא את הפתק", "הקרא", "תקריא", "קרא בקול", "תקרא בקול", "הקראה"], en: ["read this note aloud", "read it aloud", "read aloud", "read the note", "read this to me"] },
  { id: "stop-reading", command: "note.read", he: ["הפסק להקריא", "תפסיק להקריא", "עצור הקראה", "די להקריא"], en: ["stop reading", "stop reading aloud", "be quiet"] },
  { id: "capture", command: "note.capture", he: ["לכידה מהירה", "רשום מהר", "פתק מהיר"], en: ["quick capture", "quick note", "capture"] },
  { id: "open-tasks", command: "tasks.open", he: ["פתח משימות", "הראה משימות", "תראה משימות", "תראה לי משימות", "להראות משימות", "רשימת המשימות", "המשימות שלי"], en: ["open tasks", "show my tasks", "show tasks", "my tasks"] },
  { id: "delete-note", command: "file.trash", confirm: true, he: ["מחק את הפתק", "תמחק את הפתק", "מחק פתק", "העבר לאשפה", "זרוק לפח"], en: ["delete this note", "delete the note", "delete note", "move to trash"] },
  { id: "save", command: "file.save", he: ["שמור", "תשמור", "שמור את הפתק", "שמירה"], en: ["save", "save the note", "save this"] },
  { id: "summarize", command: "ai.summarize", he: ["סכם את הפתק", "תסכם את הפתק", "סכם", "תסכם", "סיכום"], en: ["summarize this note", "summarize the note", "summarize", "give me a summary"] },
  { id: "translate", command: "ai.translate", he: ["תרגם את הפתק", "תתרגם", "תרגם"], en: ["translate this note", "translate this", "translate"] },
  { id: "dictate", command: "voice.dictate", he: ["התחל הכתבה", "הכתבה", "תכתוב מה שאני אומר", "הכתב"], en: ["start dictation", "dictation", "dictate", "take dictation"] },
  { id: "toggle-theme", command: "theme.toggle", he: ["מצב כהה", "מצב לילה", "מצב בהיר", "החלף ערכת נושא", "שנה צבעים"], en: ["dark mode", "light mode", "night mode", "toggle theme", "switch theme"] },
  { id: "open-settings", command: "settings.open", he: ["פתח הגדרות", "הגדרות", "תפתח את ההגדרות"], en: ["open settings", "settings", "preferences"] },
  { id: "open-calendar", command: "view.calendar", he: ["פתח לוח שנה", "לוח שנה", "הראה לוח שנה", "פתח יומן חודשי"], en: ["open the calendar", "open calendar", "calendar", "show calendar"] },
  { id: "open-graph", command: "view.graphView", he: ["תצוגת גרף", "פתח גרף", "הראה גרף", "גרף הקשרים"], en: ["graph view", "open graph", "show graph", "show the graph"] },
  { id: "outline", command: "view.outline", he: ["תוכן עניינים", "הראה כותרות", "מתאר", "ראשי פרקים"], en: ["outline", "show outline", "table of contents", "show headings"] },
  { id: "backlinks", command: "view.backlinks", he: ["קישורים חוזרים", "מי מקשר לכאן", "הראה קישורים"], en: ["backlinks", "show backlinks", "what links here"] },
  { id: "check-grammar", command: "tools.checkGrammar", he: ["בדוק דקדוק", "תבדוק דקדוק", "בדיקת דקדוק", "בדוק איות"], en: ["check grammar", "check spelling", "grammar check", "proofread"] },
];

export interface Intent {
  id: IntentId;
  command: string;
  slot?: string;
  confirm: boolean;
  /** The trigger that matched, for the trace. */
  trigger: string;
}

/** Fillers and courtesy words people add to a spoken command. */
const FILLERS_HE = ["בבקשה", "אממ", "אמ", "אה", "אהה", "יאללה", "רגע", "טוב", "אוקיי", "אוקי", "לומן", "היי לומן", "תוכל", "תוכלי", "אפשר", "בוא", "בואי", "נא"];
const FILLERS_EN = ["please", "um", "uh", "hey lumen", "lumen", "ok", "okay", "can you", "could you", "would you", "i want to", "i'd like to", "let's"];

/** Lower case, no niqqud or punctuation, single spaces — the asr-he normal form, so ASR output and the table agree. */
export function normalizeCommand(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[֑-ׇ]/g, "")
    .normalize("NFC")
    .replace(/[־\-‐-―]/g, " ")
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const stripFillers = (words: string): string => {
  let s = ` ${words} `;
  for (const f of [...FILLERS_HE, ...FILLERS_EN].sort((a, b) => b.length - a.length)) s = s.split(` ${f} `).join(" ");
  return s.replace(/\s+/g, " ").trim();
};

/** Strip a leading "ו"/"ה"… a speaker or the ASR may glue onto the first word ("ותחפש", "והקרא"). */
const variants = (s: string): string[] => {
  const out = [s];
  if (/^[וה][א-ת]/.test(s)) out.push(s.slice(1));
  return out;
};

/** Slot words: what follows the trigger, without a leading connective ("על", "בשם", "for", "called"…). */
function slotOf(rest: string): string | undefined {
  let s = rest;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^(?:לי|את|על|בשם|שנקרא|שנקראת|עם הכותרת|עם השם|called|named|titled|about|for|to|that says|me)\s+/u, "").trim();
  }
  return s || undefined;
}

/**
 * The intent of a spoken command, or null. A trigger must start the
 * utterance (after fillers); the longest trigger that does wins, so
 * "צור פתק חדש בשם קניות" is new-note with the title "קניות", and
 * "הפסק להקריא" is stop-reading, not read-aloud.
 */
export function parseIntent(transcript: string): Intent | null {
  const base = stripFillers(normalizeCommand(transcript));
  if (!base) return null;
  let best: { def: IntentDef; trigger: string; rest: string } | null = null;
  for (const text of variants(base)) {
    for (const def of INTENTS) {
      for (const trigger of [...def.he, ...def.en]) {
        const t = normalizeCommand(trigger);
        if (text !== t && !text.startsWith(`${t} `)) continue;
        if (!best || t.length > best.trigger.length) best = { def, trigger: t, rest: text.slice(t.length).trim() };
      }
    }
    if (best) break;
  }
  if (!best) return null;
  const { def, trigger, rest } = best;
  // A trigger without a slot must be the whole command (besides fillers): "שמור את זה בצד" is not "save".
  if (!def.slot && rest && !/^(?:את (?:ה)?(?:פתק|זה)|הזה|this|it|the note|now|עכשיו)$/.test(rest)) return null;
  return { id: def.id, command: def.command, slot: def.slot ? slotOf(rest) : undefined, confirm: !!def.confirm, trigger };
}
