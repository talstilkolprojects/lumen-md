/**
 * Automatic Hebrew typography (plan W2.9) — what Word's Hebrew AutoFormat
 * does, for Markdown. Every rule acts only in a Hebrew context and can be
 * turned off on its own:
 *
 *  - gershayim  צה"ל → צה״ל          (" between Hebrew letters)
 *  - geresh     ג'ירפה → ג׳ירפה       (' after a Hebrew letter)
 *  - quotes     "שלום" → „שלום”       (Hebrew quotation marks)
 *  - maqaf      בית-ספר → בית־ספר     (- between Hebrew letters)
 *  - dash       מילה - מילה → מילה – מילה
 *  - numbers    50 % → 50%, %50 → 50%, 10–20 → 10-20 (a range reads in order in RTL)
 *  - mixedLine  a Hebrew line that starts with a Latin word gets an RLM
 *               mark first, so it reads right to left and its final
 *               punctuation lands at its end, not on the wrong side
 *
 * Nothing changes inside code (fenced, inline), links and URLs, wiki-links,
 * HTML tags, math or the frontmatter. Pure and dependency-free; the editor
 * applies it as you type (editor/hebrewTypographyExtension) and the
 * "Hebrew typography" dialog to the whole note with a preview.
 */

export type TypoRule = "gershayim" | "geresh" | "quotes" | "maqaf" | "dash" | "numbers" | "mixedLine";

export const TYPO_RULES: readonly TypoRule[] = ["gershayim", "geresh", "quotes", "maqaf", "dash", "numbers", "mixedLine"];

export interface TypoEdit {
  from: number;
  to: number;
  insert: string;
  rule: TypoRule;
}

export const RLM = "‏";
const HE = "א-ת";
const MARKS = "֑-ׇ";
const HE_LETTER = new RegExp(`[${HE}]`);
const LATIN_LETTER = /[A-Za-z]/;

/* ─── What must never change ─────────────────────────────────────────── */

/** [from, to) ranges that rules never touch: code, links, URLs, HTML, math, frontmatter. */
export function protectedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  // Frontmatter.
  const fm = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (fm) out.push([0, fm[0].length]);
  // Fenced code: ``` or ~~~ (3+), to the matching fence or the end.
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n?/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const start = m.index;
    const marker = m[2];
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`, "gm");
    close.lastIndex = fence.lastIndex;
    const c = close.exec(text);
    const end = c ? c.index + c[0].length : text.length;
    out.push([start, end]);
    fence.lastIndex = end;
  }
  // Math blocks $$…$$.
  for (const mm of text.matchAll(/\$\$[\s\S]*?\$\$/g)) out.push([mm.index!, mm.index! + mm[0].length]);
  // Inline: code spans (a whole backtick run to the same run), $math$, links, wiki-links, autolinks, HTML, bare URLs, reference definitions.
  const inline = [
    /(`+)[\s\S]*?\1/g,
    /(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$/g,
    /!?\[[^\]\n]*\]\([^)\n]*\)/g,
    /\[\[[^\]\n]*\]\]/g,
    /<[A-Za-z][^>\n]*>/g,
    /<\/[A-Za-z][^>\n]*>/g,
    /\b(?:https?|ftp|mailto):[^\s<>()]+/g,
    /^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm,
  ];
  for (const re of inline) for (const mm of text.matchAll(re)) out.push([mm.index!, mm.index! + mm[0].length]);
  // A code span still being typed (`צה"ל with no closing ` yet): from its backticks to the end of the line.
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const runs = [...line.matchAll(/`+/g)];
    let open: RegExpMatchArray | null = null;
    for (const r of runs) {
      if (!open) open = r;
      else if (r[0].length === open[0].length) open = null;
    }
    if (open) out.push([lineStart + open.index!, lineStart + line.length]);
    lineStart += line.length + 1;
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

const inside = (ranges: ReadonlyArray<[number, number]>, from: number, to: number) => ranges.some(([a, b]) => from < b && to > a);

/* ─── The rules ──────────────────────────────────────────────────────── */

/** The line containing `pos`: [start, end). */
function lineAt(text: string, pos: number): [number, number] {
  const s = text.lastIndexOf("\n", pos - 1) + 1;
  const e = text.indexOf("\n", pos);
  return [s, e < 0 ? text.length : e];
}

const hebrewLine = (text: string, pos: number) => {
  const [s, e] = lineAt(text, pos);
  return HE_LETTER.test(text.slice(s, e));
};

/** Markdown markers at the start of a line: heading, quote, list, task. */
const LINE_MARKERS = /^(?:[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+))*/;

function candidates(text: string, rules: ReadonlySet<TypoRule>): TypoEdit[] {
  const out: TypoEdit[] = [];
  const add = (rule: TypoRule, re: RegExp, insert: (m: RegExpExecArray) => string, offset: (m: RegExpExecArray) => number = () => 0, len?: (m: RegExpExecArray) => number) => {
    if (!rules.has(rule)) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const from = m.index + offset(m);
      out.push({ from, to: from + (len ? len(m) : m[0].length - offset(m)), insert: insert(m), rule });
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  // ״ between two Hebrew letters (an acronym): צה"ל — unless it opens a quote
  // after a prefix letter (ו"ההגנה" → ו„ההגנה”): 1–3 of ו ה ב כ ל מ ש, and the
  // same word closes with another ".
  {
    const re = new RegExp(`(?<=[${HE}][${MARKS}]*)"(?=[${HE}])`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(0, m.index);
      const wordStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t"), before.lastIndexOf("(")) + 1;
      const prefix = before.slice(wordStart);
      const rest = /^[^\s]*/.exec(text.slice(m.index + 1))?.[0] ?? "";
      const opensQuote = /^[והבכלמש]{1,3}$/.test(prefix) && new RegExp(`[${HE}][${MARKS}]*[.,!?]?"`).test(rest);
      if (opensQuote) {
        if (rules.has("quotes")) out.push({ from: m.index, to: m.index + 1, insert: "„", rule: "quotes" });
      } else if (rules.has("gershayim")) out.push({ from: m.index, to: m.index + 1, insert: "״", rule: "gershayim" });
    }
  }
  // ׳ after a Hebrew letter — unless the word opened with ' (then it closes a quote).
  if (rules.has("geresh")) {
    const re = new RegExp(`(?<=[${HE}][${MARKS}]*)'`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(0, m.index);
      const wordStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1;
      if (text[wordStart] === "'") continue;
      out.push({ from: m.index, to: m.index + 1, insert: "׳", rule: "geresh" });
    }
  }
  // „ before a Hebrew word, ” after one.
  add("quotes", new RegExp(`(?<=^|[\\s(\\[{—–-])"(?=[${HE}])`, "gm"), () => "„");
  add("quotes", new RegExp(`(?<=[${HE}][${MARKS}]*[.,!?;:]?)"(?=$|[\\s.,!?;:)\\]}—–-])`, "gm"), () => "”");
  // ־ between Hebrew letters.
  add("maqaf", new RegExp(`(?<=[${HE}][${MARKS}]*)-(?=[${HE}])`, "g"), () => "־");
  // " - " between Hebrew words → " – ".
  add("dash", new RegExp(`(?<=[${HE}][${MARKS}]*[.,!?"'”׳״]? )-(?= [„"]?[${HE}])`, "g"), () => "–");
  if (rules.has("numbers")) {
    for (const m of text.matchAll(/(?<=\d) +%/g)) if (hebrewLine(text, m.index!)) out.push({ from: m.index!, to: m.index! + m[0].length, insert: "%", rule: "numbers" });
    for (const m of text.matchAll(/(?<=^|[\s(])%(\d+(?:[.,]\d+)?)(?![\d%])/gm)) if (hebrewLine(text, m.index!)) out.push({ from: m.index!, to: m.index! + m[0].length, insert: `${m[1]}%`, rule: "numbers" });
    for (const m of text.matchAll(/(?<=\d)[–—](?=\d)/g)) if (hebrewLine(text, m.index!)) out.push({ from: m.index!, to: m.index! + 1, insert: "-", rule: "numbers" });
  }
  if (rules.has("mixedLine")) {
    let pos = 0;
    for (const line of text.split("\n")) {
      const markers = LINE_MARKERS.exec(line)?.[0] ?? "";
      const body = line.slice(markers.length);
      const he = (body.match(new RegExp(`[${HE}]`, "g")) ?? []).length;
      const la = (body.match(/[A-Za-z]/g) ?? []).length;
      const first = /[A-Za-zא-ת‏‎]/.exec(body)?.[0];
      if (he > la && first !== undefined && LATIN_LETTER.test(first) && /[.!?:]\s*$/.test(body)) {
        out.push({ from: pos + markers.length, to: pos + markers.length, insert: RLM, rule: "mixedLine" });
      }
      pos += line.length + 1;
    }
  }
  return out;
}

export type RuleSettings = Partial<Record<TypoRule, boolean>>;

const enabledSet = (rules: RuleSettings | ReadonlySet<TypoRule>): ReadonlySet<TypoRule> =>
  rules instanceof Set ? rules : new Set(TYPO_RULES.filter((r) => (rules as RuleSettings)[r] !== false));

/**
 * The typography edits for `text`, in order, never overlapping and never in
 * protected text. `within` limits them to edits that touch that range (the
 * text just typed).
 */
export function typographyEdits(text: string, rules: RuleSettings | ReadonlySet<TypoRule> = {}, within?: { from: number; to: number }): TypoEdit[] {
  let list = candidates(text, enabledSet(rules));
  if (within) list = list.filter((e) => e.to >= within.from && e.from <= within.to);
  if (!list.length) return [];
  const guard = protectedRanges(text);
  list = list.filter((e) => !inside(guard, e.from, Math.max(e.to, e.from + 1)));
  list.sort((a, b) => a.from - b.from || a.to - b.to);
  const out: TypoEdit[] = [];
  let end = -1;
  for (const e of list) {
    if (e.from < end || (e.from === end && e.from === e.to && out.length && out[out.length - 1].from === e.from)) continue;
    out.push(e);
    end = Math.max(end, e.to);
  }
  return out;
}

/** `text` with `edits` applied (as typographyEdits returns them). */
export function applyEdits(text: string, edits: readonly TypoEdit[]): string {
  let out = "";
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.from) + e.insert;
    at = e.to;
  }
  return out + text.slice(at);
}

/** Every rule on, as typed: Hebrew typography for the whole text. */
export function hebrewTypography(text: string, rules: RuleSettings = {}): string {
  return applyEdits(text, typographyEdits(text, rules));
}

const WORDLIKE = /[\p{L}\p{N}]/u;

/** Of the line's edits, the ones the character typed just before `head` completed. */
export function editsForKeystroke(edits: readonly TypoEdit[], head: number, typed: string, lineEnd: number): TypoEdit[] {
  return edits.filter((e) => {
    if (e.rule === "mixedLine") return /[.!?:]/.test(typed) && head === lineEnd;
    if (e.to === head - 1) return true;
    // A " just typed after a Hebrew letter may still become ״ (צה"ל): it is fixed with the next key.
    if (e.to === head) return !WORDLIKE.test(typed) && e.insert !== "”";
    return e.rule === "dash" && e.to === head - 2;
  });
}

/* ─── Settings ───────────────────────────────────────────────────────── */

export interface TypographySettings {
  /** Fix as you type (the dialog's "Apply to note" works either way). */
  asYouType: boolean;
  rules: RuleSettings;
}

const KEY = "lumen-hebrew-typography";

export function loadTypographySettings(): TypographySettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TypographySettings> | null;
    return { asYouType: raw?.asYouType !== false, rules: raw?.rules && typeof raw.rules === "object" ? raw.rules : {} };
  } catch {
    return { asYouType: true, rules: {} };
  }
}

export function saveTypographySettings(s: TypographySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode: the settings last for this session only.
  }
  listeners.forEach((fn) => fn(s));
}

const listeners = new Set<(s: TypographySettings) => void>();
export function onTypographySettings(fn: (s: TypographySettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
