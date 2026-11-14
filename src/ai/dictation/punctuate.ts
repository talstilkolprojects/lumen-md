/**
 * Dictation text: voice commands and rule-based punctuation (plan 6.1).
 *
 * The streaming model writes words only. A finished segment (the speaker
 * paused) gets a full stop, or a question mark when it opens with a
 * question word; spoken punctuation ("פסיק", "comma", "שורה חדשה") becomes
 * the mark itself; "מחק את זה" / "delete that" removes the last segment.
 * An optional pass through the local model (polish.ts) can improve this;
 * these rules are what always runs.
 */

export type DictationAction = { type: "delete-last" } | { type: "stop" };

export interface Segment {
  /** Text to insert (may be empty when the segment was only a command). */
  text: string;
  actions: DictationAction[];
}

type Command = { phrase: string[]; mark?: string; action?: DictationAction["type"] };

/** Longest phrases first, so "סימן שאלה" wins over a lone word. */
const COMMANDS: Command[] = (
  [
    { phrase: ["סימן", "שאלה"], mark: "?" },
    { phrase: ["סימן", "קריאה"], mark: "!" },
    { phrase: ["שורה", "חדשה"], mark: "\n" },
    { phrase: ["פסקה", "חדשה"], mark: "\n\n" },
    { phrase: ["פתח", "סוגריים"], mark: "(" },
    { phrase: ["סגור", "סוגריים"], mark: ")" },
    { phrase: ["מחק", "את", "זה"], action: "delete-last" },
    { phrase: ["עצור", "הכתבה"], action: "stop" },
    { phrase: ["נקודתיים"], mark: ":" },
    { phrase: ["נקודה"], mark: "." },
    { phrase: ["פסיק"], mark: "," },
    { phrase: ["question", "mark"], mark: "?" },
    { phrase: ["exclamation", "mark"], mark: "!" },
    { phrase: ["exclamation", "point"], mark: "!" },
    { phrase: ["new", "line"], mark: "\n" },
    { phrase: ["new", "paragraph"], mark: "\n\n" },
    { phrase: ["full", "stop"], mark: "." },
    { phrase: ["open", "paren"], mark: "(" },
    { phrase: ["close", "paren"], mark: ")" },
    { phrase: ["delete", "that"], action: "delete-last" },
    { phrase: ["stop", "dictation"], action: "stop" },
    { phrase: ["period"], mark: "." },
    { phrase: ["comma"], mark: "," },
    { phrase: ["colon"], mark: ":" },
  ] as Command[]
).sort((a, b) => b.phrase.length - a.phrase.length);

const QUESTION_HE = new Set(["האם", "מה", "מי", "איפה", "היכן", "מתי", "למה", "מדוע", "איך", "כיצד", "כמה", "לאן", "מאין", "מאיפה", "איזה", "איזו", "אילו", "הלא"]);
const QUESTION_EN = new Set(["what", "who", "whom", "whose", "where", "when", "why", "how", "which", "is", "are", "am", "was", "were", "do", "does", "did", "can", "could", "would", "will", "should", "shall", "may", "might", "have", "has"]);

const TERMINAL = /[.?!:…]$/;
const NO_SPACE_BEFORE = /^[.,?!:)]$/;
const NO_SPACE_AFTER = /^[(\n]$|\n$/;

/** Join words and marks with the right spacing. */
function join(parts: string[]): string {
  let out = "";
  for (const p of parts) {
    if (!out) out = p;
    else if (NO_SPACE_BEFORE.test(p) || NO_SPACE_AFTER.test(out.slice(-1)) || p.startsWith("\n")) out += p;
    else out += " " + p;
  }
  return out.replace(/ +\n/g, "\n");
}

/**
 * Turn a finished segment's words into text: commands applied, a terminal
 * mark added when the speaker did not say one, Latin sentences capitalised.
 * `commands: false` keeps every word literally (for notes where "נקודה" is a word).
 */
export function finishSegment(words: string, opts: { commands?: boolean; final?: boolean } = {}): Segment {
  const commands = opts.commands ?? true;
  const tokens = words.trim().split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  const actions: DictationAction[] = [];
  for (let i = 0; i < tokens.length; ) {
    const cmd = commands ? COMMANDS.find((c) => c.phrase.every((w, k) => tokens[i + k]?.toLowerCase() === w)) : undefined;
    if (cmd) {
      if (cmd.mark) parts.push(cmd.mark);
      if (cmd.action) actions.push({ type: cmd.action });
      i += cmd.phrase.length;
    } else parts.push(tokens[i++]);
  }
  const words_ = parts.filter((p) => !/^[.,?!:()\n]+$/.test(p));
  if ((opts.final ?? true) && words_.length && !TERMINAL.test(parts[parts.length - 1]) && !/\n$/.test(parts[parts.length - 1])) {
    const first = words_[0].toLowerCase();
    parts.push(QUESTION_HE.has(first) || QUESTION_EN.has(first) ? "?" : ".");
  }
  let text = join(parts);
  // Capitalise Latin sentence starts.
  text = text.replace(/(^|[.?!]\s+|\n)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  return { text, actions };
}

/** Text to show while the speaker is still talking: words only, commands shown as their marks. */
export function interimText(words: string, opts: { commands?: boolean } = {}): string {
  return finishSegment(words, { ...opts, final: false }).text;
}

/** Glue a new segment after existing text (one space, none after a newline or at the start). */
export function appendSegment(before: string, segment: string): string {
  if (!segment) return before;
  if (!before || /\s$/.test(before) || segment.startsWith("\n") || NO_SPACE_BEFORE.test(segment[0])) return before + segment;
  return before + " " + segment;
}
