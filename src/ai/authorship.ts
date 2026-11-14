/**
 * Which text in a note the AI wrote (plan 5.9).
 *
 * Every AI command runs through the agent runtime (plan 5.5), and the
 * runtime hands each answer here (`noteAiOutput`, streamed answers as they
 * grow). The editor then marks any text that reaches the document without
 * being typed — inserted at the cursor, replacing a selection, or as part
 * of a whole-document update — when it is a recent AI answer or a line of
 * one. Typing inside marked text turns that part into ordinary text.
 *
 * This module is pure (no CodeMirror): the registry, the matching, the
 * span arithmetic, the per-note storage and the export footer.
 */

/** A half-open range [from, to) of the document, in UTF-16 code units. */
export type Span = readonly [from: number, to: number];

const RECENT_MS = 15 * 60_000;
const MAX_RUNS = 64;
/** A line of an answer must be at least this long to be matched on its own. */
const MIN_LINE = 16;
/** An insertion must be at least this long to count as a piece of an answer. */
const MIN_PIECE = 4;

const recent = new Map<string, { at: number; texts: string[] }>();

/** Every string leaf of an answer (a JSON answer: its text fields). */
function stringsOf(output: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof output === "string") {
    if (output.trim()) out.push(output);
  } else if (depth < 6 && output && typeof output === "object") {
    for (const v of Array.isArray(output) ? output : Object.values(output)) stringsOf(v, out, depth + 1);
  }
  return out;
}

/** The runtime calls this with each answer (and a streamed answer so far). */
export function noteAiOutput(runId: string, output: unknown, now = Date.now()): void {
  const texts = stringsOf(output);
  if (!texts.length) return;
  recent.delete(runId);
  recent.set(runId, { at: now, texts });
  while (recent.size > MAX_RUNS) recent.delete(recent.keys().next().value as string);
}

export function recentAiTexts(now = Date.now()): string[] {
  const out: string[] = [];
  for (const [id, r] of recent) {
    if (now - r.at > RECENT_MS) recent.delete(id);
    else out.push(...r.texts);
  }
  return out;
}

/** Test hook. */
export function clearAiOutputs(): void {
  recent.clear();
}

/** Sorted, non-overlapping, non-empty spans. */
export function normalize(spans: Iterable<Span>): Span[] {
  const sorted = [...spans].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `spans` with [from, to) cut out. */
export function subtract(spans: readonly Span[], from: number, to: number): Span[] {
  if (to <= from) return [...spans];
  const out: Span[] = [];
  for (const [a, b] of spans) {
    if (b <= from || a >= to) out.push([a, b]);
    else {
      if (a < from) out.push([a, from]);
      if (b > to) out.push([to, b]);
    }
  }
  return out;
}

function trimmedRange(text: string): Span | null {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return end > start ? [start, end] : null;
}

/**
 * The parts of `inserted` that an AI answer wrote, relative to `inserted`.
 * Whole answers are found anywhere; a line of an answer counts once it is
 * long enough not to match by chance (an answer reformatted on the way in —
 * quoted, put in a list or a code fence — still matches line by line). An
 * insertion that is itself part of an answer (a streamed piece, an accepted
 * completion) is marked whole.
 */
export function aiSpansIn(inserted: string, texts: readonly string[] = recentAiTexts()): Span[] {
  const core = trimmedRange(inserted);
  if (!core || !texts.length) return [];
  const piece = inserted.slice(core[0], core[1]);
  // Short pieces (markup a formatting command adds: `**`, `- [ ]`) would
  // match any answer; an editor that inserts a short answer says so with
  // the `aiAuthored` annotation instead.
  if (piece.length >= MIN_PIECE && /[\p{L}\p{N}]/u.test(piece) && texts.some((t) => t.includes(piece))) return [core];
  const found: Span[] = [];
  const findAll = (needle: string) => {
    if (!needle) return;
    for (let i = inserted.indexOf(needle); i !== -1; i = inserted.indexOf(needle, i + needle.length)) {
      found.push([i, i + needle.length]);
    }
  };
  for (const t of texts) {
    const whole = t.trim();
    if (inserted.includes(whole)) {
      findAll(whole);
      continue;
    }
    for (const line of whole.split("\n")) {
      const l = line.trim();
      if (l.length >= MIN_LINE) findAll(l);
    }
  }
  return normalize(found);
}

/**
 * How a whole-document replacement changed the text: the common prefix and
 * suffix stay, the middle is new. Lets the spans survive an update that
 * rewrites the document from outside the editor (an AI command that sets
 * the content, a sync), instead of collapsing.
 */
export function diffMiddle(before: string, after: string): { start: number; endBefore: number; endAfter: number } {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < max - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  return { start, endBefore: before.length - tail, endAfter: after.length - tail };
}

// ── Per-note storage ────────────────────────────────────────────────────

const STORE_KEY = "lumen.ai.authorship";
const SHOW_KEY = "lumen.ai.authorship.hidden";
const MAX_NOTES = 200;
const MAX_SPANS = 2000;

/** FNV-1a over the span's text: a span is restored only if its text is unchanged. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

type Stored = Record<string, { at: number; spans: Array<[number, number, string]> }>;

function readStore(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Stored) : {};
  } catch {
    return {};
  }
}

export function saveSpans(noteKey: string, doc: string, spans: readonly Span[], now = Date.now()): void {
  const store = readStore();
  if (!spans.length) delete store[noteKey];
  else store[noteKey] = { at: now, spans: spans.slice(0, MAX_SPANS).map(([a, b]) => [a, b, textHash(doc.slice(a, b))]) };
  const keys = Object.keys(store).sort((x, y) => store[y].at - store[x].at);
  for (const k of keys.slice(MAX_NOTES)) delete store[k];
  try {
    if (Object.keys(store).length) localStorage.setItem(STORE_KEY, JSON.stringify(store));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* why: storage full or denied: the marks stay for this session */
  }
}

/** The saved spans whose text is still the same. */
export function loadSpans(noteKey: string, doc: string): Span[] {
  const entry = readStore()[noteKey];
  if (!entry || !Array.isArray(entry.spans)) return [];
  const out: Span[] = [];
  for (const s of entry.spans) {
    if (!Array.isArray(s) || s.length !== 3) continue;
    const [a, b, h] = s;
    if (typeof a === "number" && typeof b === "number" && b > a && b <= doc.length && h === textHash(doc.slice(a, b))) out.push([a, b]);
  }
  return normalize(out);
}

export function marksShown(): boolean {
  try {
    return localStorage.getItem(SHOW_KEY) !== "1";
  } catch {
    return true;
  }
}

export function setMarksShown(shown: boolean): void {
  try {
    if (shown) localStorage.removeItem(SHOW_KEY);
    else localStorage.setItem(SHOW_KEY, "1");
  } catch {
    /* why: storage denied */
  }
  if (typeof document !== "undefined") document.documentElement.toggleAttribute("data-ai-marks-hidden", !shown);
}

// ── Export ──────────────────────────────────────────────────────────────

const FOOTER_RE = /\n<!-- lumen-ai-authorship v1: [\d\- ]* -->\n?$/;

/**
 * The note with an HTML comment at the end that lists the AI-written
 * ranges (offsets into the text before the comment). Markdown renderers
 * show nothing for it; Lumen and other tools can read it back.
 */
export function withAuthorshipFooter(doc: string, spans: readonly Span[]): string {
  const body = doc.replace(FOOTER_RE, "");
  const kept = normalize(spans).filter(([, b]) => b <= body.length);
  if (!kept.length) return body;
  // A blank line before the comment; the body keeps its own last newline.
  const sep = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${sep}<!-- lumen-ai-authorship v1: ${kept.map(([a, b]) => `${a}-${b}`).join(" ")} -->\n`;
}

/** The spans listed by a footer, and the text without it. */
export function readAuthorshipFooter(doc: string): { body: string; spans: Span[] } {
  const m = FOOTER_RE.exec(doc);
  if (!m) return { body: doc, spans: [] };
  const body = doc.slice(0, m.index);
  const list = /v1: ([\d\- ]*) -->/.exec(m[0])?.[1] ?? "";
  const spans = list
    .split(" ")
    .map((p) => p.split("-").map(Number))
    .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isInteger) && p[1] > p[0] && p[1] <= body.length)
    .map(([a, b]) => [a, b] as const);
  return { body, spans: normalize(spans) };
}
