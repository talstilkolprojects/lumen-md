/**
 * Personal data redaction before a cloud request (plan 2.6).
 *
 * When the AI policy lets a request leave the device, the text is redacted
 * here first, on the device: every match becomes a token such as
 * `⟨EMAIL_1⟩`, the same value always gets the same token within one
 * request, and the tokens in the answer are replaced back with the
 * originals (`restore`, `restoreStream`).
 *
 *   patterns  e-mail, phone (Israeli formats and +972), ת״ז (check digit),
 *             payment card (Luhn), IBAN (mod 97), licence plate, and a date
 *             of birth (a date next to a birth cue). Each number is validated,
 *             so an order number, a parcel code or an invalid ID is left alone.
 *   names     an optional NER pass (DictaBERT-NER for Hebrew, plan 6.0,
 *             downloaded only with consent); without it, patterns only.
 *
 * Pure: no imports from the app, so the golden-set harness can bundle it.
 */

export type PiiType = "EMAIL" | "PHONE" | "IL_ID" | "CREDIT_CARD" | "IBAN" | "LICENSE_PLATE" | "DATE_OF_BIRTH" | "PERSON" | "LOCATION";

export interface PiiSpan {
  start: number;
  end: number;
  type: PiiType;
  text: string;
}

/** A name finder (NER): spans of PERSON / LOCATION in `text`. */
export type NerFn = (text: string) => Promise<Array<{ start: number; end: number; type: PiiType }>>;

/* ── Validators ─────────────────────────────────────────────────────── */

/** Israeli ID (ת״ז): 9 digits, the last a check digit (weights 1,2,1,2…). */
export function validIsraeliId(id: string): boolean {
  if (!/^\d{9}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let v = Number(id[i]) * (i % 2 === 0 ? 1 : 2);
    if (v > 9) v -= 9;
    sum += v;
  }
  return sum % 10 === 0;
}

/** Luhn check over the digits of `n` (13–19 digits). */
export function luhnValid(n: string): boolean {
  const d = n.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let v = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

/** IBAN check (ISO 13616, mod 97). */
export function ibanValid(iban: string): boolean {
  const s = iban.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

/* ── Patterns ───────────────────────────────────────────────────────── */

// Not inside a longer word or number: no letter, digit or joining mark next
// to it. A dash after a letter is a Hebrew prefix (ב-054…, ל-dana@…), not a join.
const L = "(?<![\\p{L}\\p{N}_@.])(?<![\\p{N}_@.]-)";
const R = "(?![\\p{L}\\p{N}_@]|[.\\-]\\p{N})";

const MONTHS_HE = "ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר";
const MONTHS_EN = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const DATE = `(?:\\d{1,2}[./]\\d{1,2}[./](?:19|20)\\d{2}|(?:19|20)\\d{2}-\\d{2}-\\d{2}|\\d{1,2} ב?(?:${MONTHS_HE}) (?:19|20)\\d{2}|\\d{1,2} (?:${MONTHS_EN}),? (?:19|20)\\d{2}|(?:${MONTHS_EN}) \\d{1,2},? (?:19|20)\\d{2})`;
/** Words that make a date someone's birth date (Hebrew and English). */
const BIRTH_CUE = /(?:תאריך\s+(?:ה)?לידה|נולד(?:ה|ו)?|יום\s+ה?הולדת|ילידת?|born|birth\s*date|date\s+of\s+birth|birthday|\bDOB\b|d\.o\.b)/iu;

interface Rule {
  type: PiiType;
  re: RegExp;
  /** Validate the match; `before` is up to 30 characters of the same clause before it. */
  ok?: (match: string, before: string) => boolean;
}

/** A number named as a code right before it is not a phone number (055-5631464 as a product code). */
const CODE_CUE = /(?:קוד|מק["״]?ט|דגם|הזמנה|מעקב|חשבונית|אסמכתא|code|sku|model|order|invoice|tracking|ref(?:erence)?)[^\d]{0,20}$/iu;
const PHONE_CUE = /(?:טלפון|נייד|טל['׳]?|פקס|להתקשר|לחזור|חייג|phone|mobile|cell|tel|call|fax)/iu;

const RULES: Rule[] = [
  { type: "EMAIL", re: new RegExp(`${L}[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}(?![A-Za-z0-9])`, "gu") },
  // IBAN before the card and ID rules: its digits would match them too.
  { type: "IBAN", re: new RegExp(`${L}[A-Z]{2}\\d{2}(?:[ ]?[A-Z0-9]){11,30}${R}`, "gu"), ok: (m) => ibanValid(m) },
  { type: "CREDIT_CARD", re: new RegExp(`${L}\\d(?:[ -]?\\d){12,18}${R}`, "gu"), ok: (m) => luhnValid(m) },
  // Mobile: 05X with or without a separator; landline: 0X / 07X only with a separator (an unseparated 9-digit run is an order number as often as a phone).
  {
    type: "PHONE",
    ok: (_m, before) => !CODE_CUE.test(before) || PHONE_CUE.test(before),
    re: new RegExp(`${L}(?:(?:\\+972[ -]?|0)5\\d[ -]?\\d{3}[ -]?\\d{4}|\\+972[ -]?(?:[23489]|7\\d)[ -]?\\d{3}[ -]?\\d{4}|0(?:[23489]|7\\d)[ -]\\d{3}[ -]?\\d{4}|\\+\\d{1,3}[ -]\\d{2,4}[ -]\\d{3,4}[ -]\\d{3,4})${R}`, "gu"),
  },
  { type: "IL_ID", re: new RegExp(`${L}\\d{9}${R}`, "gu"), ok: (m) => validIsraeliId(m) },
  // Israeli plates: 12-345-67 (7 digits) and 123-45-678 (8 digits).
  { type: "LICENSE_PLATE", re: new RegExp(`${L}(?:\\d{2}-\\d{3}-\\d{2}|\\d{3}-\\d{2}-\\d{3})${R}`, "gu") },
];

const DATE_RE = new RegExp(`${L}${DATE}${R}`, "gu");

/** A date with a birth cue within the same clause (up to 40 characters before, or 25 after). */
function birthDates(text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const before = text.slice(Math.max(0, start - 40), start).split(/[.!?\n]/).pop() ?? "";
    const after = text.slice(end, end + 25).split(/[.!?\n]/)[0] ?? "";
    if (BIRTH_CUE.test(before) || BIRTH_CUE.test(after)) out.push({ start, end, type: "DATE_OF_BIRTH", text: m[0] });
  }
  return out;
}

/** The pattern matches in `text`, without overlaps (earlier rules win, then longer spans). */
export function findPatterns(text: string): PiiSpan[] {
  const found: PiiSpan[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const value = m[0];
      const before = (text.slice(Math.max(0, m.index! - 30), m.index!).split(/[.!?\n]/).pop() ?? "");
      if (rule.ok && !rule.ok(value, before)) continue;
      found.push({ start: m.index!, end: m.index! + value.length, type: rule.type, text: value });
    }
  }
  found.push(...birthDates(text));
  return dropOverlaps(found);
}

function dropOverlaps(spans: PiiSpan[]): PiiSpan[] {
  const kept: PiiSpan[] = [];
  for (const s of spans) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}

/** Patterns, then (when given) the NER's names in what the patterns left. */
export async function findPii(text: string, opts: { ner?: NerFn | null; types?: readonly PiiType[] } = {}): Promise<PiiSpan[]> {
  let spans = findPatterns(text);
  if (opts.ner) {
    let names: Array<{ start: number; end: number; type: PiiType }> = [];
    try {
      names = await opts.ner(text);
    } catch {
      /* why: the model failed: patterns only */
    }
    spans = dropOverlaps([...spans, ...names.filter((n) => n.end > n.start).map((n) => ({ ...n, text: text.slice(n.start, n.end) }))]);
  }
  return opts.types ? spans.filter((s) => opts.types!.includes(s.type)) : spans;
}

/* ── Tokens ─────────────────────────────────────────────────────────── */

const OPEN = "⟨";
const CLOSE = "⟩";
const TOKEN_RE = /⟨([A-Z_]+)_(\d+)⟩/g;

/** One request's token table: the same value gets the same token in every message. */
export class PiiVault {
  private byValue = new Map<string, string>();
  private byToken = new Map<string, string>();
  private counters = new Map<PiiType, number>();
  readonly counts: Partial<Record<PiiType, number>> = {};

  tokenFor(type: PiiType, value: string): string {
    const key = `${type}\u0000${value}`;
    const hit = this.byValue.get(key);
    if (hit) return hit;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const token = `${OPEN}${type}_${n}${CLOSE}`;
    this.byValue.set(key, token);
    this.byToken.set(token, value);
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    return token;
  }

  get size(): number {
    return this.byToken.size;
  }

  /** Replace every known token with its original value; unknown tokens stay as they are. */
  restore(text: string): string {
    if (!this.byToken.size || !text.includes(OPEN)) return text;
    return text.replace(TOKEN_RE, (t) => this.byToken.get(t) ?? t);
  }

  /** Restore a stream: a token split across chunks is held back until it is complete. */
  async *restoreStream(chunks: AsyncIterable<string>): AsyncGenerator<string, void, undefined> {
    let held = "";
    for await (const chunk of chunks) {
      held += chunk;
      const open = held.lastIndexOf(OPEN);
      // An unfinished token at the end (at most 24 characters long): keep it for the next chunk.
      const cut = open >= 0 && !held.includes(CLOSE, open) && held.length - open <= 24 ? open : held.length;
      const ready = held.slice(0, cut);
      held = held.slice(cut);
      if (ready) yield this.restore(ready);
    }
    if (held) yield this.restore(held);
  }
}

/** Redact `text` with `spans`, recording each value in `vault`. */
export function applyRedaction(text: string, spans: readonly PiiSpan[], vault: PiiVault): string {
  let out = "";
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at) continue;
    out += text.slice(at, s.start) + vault.tokenFor(s.type, text.slice(s.start, s.end));
    at = s.end;
  }
  return out + text.slice(at);
}

/** Redact one text (patterns, plus names when `ner` is given). */
export async function redactText(text: string, vault: PiiVault, opts: { ner?: NerFn | null } = {}): Promise<string> {
  if (!text) return text;
  return applyRedaction(text, await findPii(text, opts), vault);
}

/* ── NER output → character spans ──────────────────────────────────── */

/** A token-classification result as transformers.js returns it (`ignore_labels` default). */
export interface NerToken {
  entity: string;
  word: string;
  score: number;
  index?: number;
}

const NER_TYPE: Record<string, PiiType | undefined> = { PER: "PERSON", PERS: "PERSON", PERSON: "PERSON", GPE: "LOCATION", LOC: "LOCATION", FAC: "LOCATION" };

/**
 * Align token-level NER output (B-/I- labels, WordPiece `##` pieces, no
 * offsets) with the text and merge it into spans. Only the types in
 * `keep` (default PERSON) are returned.
 */
export function alignNer(text: string, tokens: readonly NerToken[], opts: { keep?: readonly PiiType[]; minScore?: number } = {}): Array<{ start: number; end: number; type: PiiType }> {
  const keep = opts.keep ?? ["PERSON"];
  const minScore = opts.minScore ?? 0.5;
  const out: Array<{ start: number; end: number; type: PiiType }> = [];
  let cursor = 0;
  let cur: { start: number; end: number; type: PiiType } | null = null;
  for (const tok of tokens) {
    const piece = tok.word.replace(/^##/, "").replace(/^▁/, "");
    if (!piece) continue;
    const at = text.indexOf(piece, cursor);
    if (at < 0) continue;
    const cont = tok.word.startsWith("##");
    cursor = at + piece.length;
    const [bio, raw] = tok.entity.includes("-") ? (tok.entity.split("-", 2) as [string, string]) : ["B", tok.entity];
    const type = NER_TYPE[raw.toUpperCase()];
    if (!type || tok.score < minScore) {
      if (cur && !cont) {
        out.push(cur);
        cur = null;
      } else if (cur && cont) cur.end = cursor;
      continue;
    }
    const gap = cur ? text.slice(cur.end, at) : "";
    if (cur && cur.type === type && (cont || bio === "I" || /^\s?$/.test(gap)) && /^[\s'״"־-]*$/.test(gap)) cur.end = cursor;
    else {
      if (cur) out.push(cur);
      cur = { start: at, end: cursor, type };
    }
  }
  if (cur) out.push(cur);
  return out.filter((s) => keep.includes(s.type));
}
