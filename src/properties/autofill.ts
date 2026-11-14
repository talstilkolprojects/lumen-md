/**
 * Plan 5.10 — AI fills properties for chosen notes, through an approval
 * queue. Nothing is written until the user approves a proposal:
 *
 *   fieldsFrom(vault)        the properties the vault uses (name, type, the
 *                            values seen — a small closed set becomes an enum)
 *   autofillSchema(fields)   the JSON Schema the model's answer must match
 *   proposeFor(note, values) a proposal: per property before → after, and the
 *                            note's text with them written (byte-preserving,
 *                            ./frontmatter.ts) — computed, not written
 *   AutofillQueue            pending proposals; approve() is the only writer,
 *                            and only when the note is still what was proposed on
 */
import { collectPropertySuggestions, inferType, rankSuggestions, readProperties, setProperty, type PropertyType, type PropertyValue } from "./frontmatter";

export interface FieldSpec {
  key: string;
  type: PropertyType;
  /** The values the vault uses, when they are few: the answer must be one of them. */
  options?: string[];
}

/** Values used by at most this many distinct values (and in ≥ 2 notes) make an enum. */
const ENUM_MAX = 12;

/** Fields from the vault: every property name used in at least `minNotes` notes. */
export function fieldsFrom(files: Iterable<{ path: string; content: string }>, minNotes = 2): FieldSpec[] {
  const list = [...files];
  const { keys, values } = collectPropertySuggestions(list);
  const types = new Map<string, PropertyType>();
  for (const f of list) for (const p of readProperties(f.content)) if (!types.has(p.key) && p.value !== null) types.set(p.key, p.type);
  const out: FieldSpec[] = [];
  for (const key of rankSuggestions(keys, [], 40)) {
    if ((keys.get(key) ?? 0) < minNotes) continue;
    const type = types.get(key) ?? inferType(null, key);
    const seen = rankSuggestions(values.get(key), [], ENUM_MAX + 1);
    const closed = (type === "text" || type === "list") && seen.length > 0 && seen.length <= ENUM_MAX;
    out.push({ key, type, ...(closed ? { options: seen } : {}) });
  }
  return out;
}

type Schema = Record<string, unknown>;

function valueSchema(f: FieldSpec): Schema {
  const str: Schema = f.options ? { type: "string", enum: f.options } : { type: "string", minLength: 1, maxLength: 200 };
  switch (f.type) {
    case "number":
      return { type: "number" };
    case "checkbox":
      return { type: "boolean" };
    case "date":
      return { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    case "list":
      return { type: "array", maxItems: 10, items: str };
    default:
      return str;
  }
}

/** The answer's JSON Schema: `{ "values": { <field>: <typed value> } }`, no other keys. */
export function autofillSchema(fields: readonly FieldSpec[]): Schema {
  return {
    type: "object",
    properties: {
      values: { type: "object", properties: Object.fromEntries(fields.map((f) => [f.key, valueSchema(f)])), additionalProperties: false },
    },
    required: ["values"],
    additionalProperties: false,
  };
}

export interface PropertyChange {
  key: string;
  before: unknown;
  after: PropertyValue;
}

export interface Proposal {
  id: string;
  path: string;
  /** The note's text the proposal was computed from (approve() refuses if it changed). */
  base: string;
  /** The note's text with the changes written. */
  next: string;
  changes: PropertyChange[];
}

const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * A proposal for one note, or null when there is nothing to change. Only
 * properties that are missing or empty are filled; a value the note already
 * has is kept (unless `overwrite`).
 */
export function proposeFor(path: string, text: string, values: Record<string, unknown>, fields: readonly FieldSpec[], opts: { overwrite?: boolean } = {}): Proposal | null {
  const current = new Map(readProperties(text).map((p) => [p.key, p.value]));
  let next = text;
  const changes: PropertyChange[] = [];
  for (const f of fields) {
    if (!(f.key in values)) continue;
    const v = values[f.key] as PropertyValue;
    if (empty(v)) continue;
    // The schema checker doesn't know `pattern`: a date must still look like one.
    if (f.type === "date" && !(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))) continue;
    const before = current.get(f.key);
    if (!opts.overwrite && !empty(before)) continue;
    if (JSON.stringify(before) === JSON.stringify(v)) continue;
    next = setProperty(next, f.key, v);
    changes.push({ key: f.key, before: before ?? null, after: v });
  }
  if (!changes.length) return null;
  return { id: `${path}#${hash(text)}`, path, base: text, next, changes };
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface QueueIo {
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
}

export type ApproveResult = "written" | "stale" | "missing";

/**
 * The approval queue. Proposals wait here; `approve()` is the one place a
 * proposal is written, and it writes only when the note is still exactly
 * the text the proposal was computed from.
 */
export class AutofillQueue {
  private items: Proposal[] = [];
  private listeners = new Set<() => void>();
  private readonly io: QueueIo;

  constructor(io: QueueIo) {
    this.io = io;
  }

  list(): readonly Proposal[] {
    return this.items;
  }

  add(p: Proposal): void {
    this.items = [...this.items.filter((x) => x.path !== p.path), p];
    this.emit();
  }

  reject(id: string): void {
    this.items = this.items.filter((x) => x.id !== id);
    this.emit();
  }

  async approve(id: string): Promise<ApproveResult> {
    const p = this.items.find((x) => x.id === id);
    if (!p) return "missing";
    const now = await this.io.read(p.path).catch(() => null);
    this.items = this.items.filter((x) => x.id !== id);
    if (now !== p.base) {
      this.emit();
      return "stale";
    }
    await this.io.write(p.path, p.next);
    this.emit();
    return "written";
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** What `runAutofill` needs: the notes, a reader, and the agent run (injected in tests). */
export interface AutofillDeps {
  read: (path: string) => Promise<string>;
  ask: (text: string, fields: FieldSpec[], schema: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown> | null>;
}

/**
 * Ask the model for each note and put a proposal in the queue. Writes
 * nothing: the queue's approve() is the only writer.
 */
export async function runAutofill(paths: readonly string[], fields: readonly FieldSpec[], queue: AutofillQueue, deps: AutofillDeps, opts: { signal?: AbortSignal; onNote?: (i: number, n: number) => void } = {}): Promise<{ proposed: number; unchanged: number; failed: number }> {
  const schema = autofillSchema(fields);
  let proposed = 0;
  let unchanged = 0;
  let failed = 0;
  for (let i = 0; i < paths.length; i++) {
    if (opts.signal?.aborted) break;
    opts.onNote?.(i + 1, paths.length);
    try {
      const text = await deps.read(paths[i]);
      const values = await deps.ask(text, [...fields], schema, opts.signal);
      const p = values ? proposeFor(paths[i], text, values, fields) : null;
      if (p) {
        queue.add(p);
        proposed++;
      } else if (values) unchanged++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return { proposed, unchanged, failed };
}
