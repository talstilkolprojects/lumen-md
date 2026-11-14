/**
 * No-code automations (plan W5.24): "when … then …" rules that run locally
 * over the vault, with a dry run that changes nothing, a log of every run,
 * an undo that puts every byte back, and a guard against rules that trigger
 * each other forever.
 *
 *   when: note created (in a folder) · tag added · property changed (to a
 *         value) · daily (once a day) · a row of a base view changes (W6.46)
 *   then: move to a folder · add a tag · apply a template · add a line to
 *         the daily note
 *
 * Pure: `plan` reads a snapshot of the vault and returns the changes; the
 * caller writes them (`applyPlan`) through an injected file system.
 */
import YAML from "yaml";
import { setProperty } from "../properties/frontmatter";
import { basesFileFromText, parseBase, runBase } from "../views/bases/base";

export type Trigger =
  | { kind: "created"; folder?: string }
  | { kind: "tagAdded"; tag: string }
  | { kind: "propertyChanged"; key: string; value?: string }
  | { kind: "daily" }
  /**
   * W6.46: a row of a `.base` view changes — a note that is in the view
   * (after the change) has a property changed (`property`, or any), or a new
   * note joins the view. The view's filters decide, as in the table itself.
   */
  | { kind: "rowChanged"; base: string; view?: string; property?: string };

export type Action =
  | { kind: "move"; folder: string }
  | { kind: "tag"; tag: string }
  | { kind: "template"; template: string }
  | { kind: "appendDaily"; text: string };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  when: Trigger;
  then: Action[];
}

export type VaultEvent =
  | { kind: "created"; path: string; text: string; /** Moved here by a rule: a "created" for folder rules, not a new tag. */ moved?: boolean }
  | { kind: "changed"; path: string; before: string; after: string }
  | { kind: "daily"; date: string };

export type Change =
  | { kind: "write"; path: string; before: string | null; after: string; rule: string }
  | { kind: "move"; from: string; to: string; rule: string };

/** What a rule may read: the vault as it is now. */
export interface VaultView {
  read(path: string): string | null;
  exists(path: string): boolean;
}

export interface PlanContext {
  vault: VaultView;
  /** The daily note's path for `date` (YYYY-MM-DD). */
  dailyPath(date: string): string;
  today: string;
  /** Rule id → the last day it ran (daily rules run once a day). */
  lastDaily?: Readonly<Record<string, string>>;
}

/** How deep a cascade may go: a rule's change may trigger rules, theirs may too, then it stops. */
export const MAX_DEPTH = 3;

const FM = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const norm = (tag: string) => tag.trim().replace(/^#/, "").toLowerCase();
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const cleanFolder = (f: string) => f.trim().replace(/^\/+|\/+$/g, "");

function frontmatter(text: string): Record<string, unknown> {
  const m = FM.exec(text);
  if (!m) return {};
  try {
    const v: unknown = YAML.parse(m[1]);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A note's tags: frontmatter `tags:` and #tags in the text (not in code). */
export function tagsOf(text: string): Set<string> {
  const out = new Set<string>();
  const fm = frontmatter(text);
  const t = fm.tags ?? fm.tag;
  for (const x of Array.isArray(t) ? t : typeof t === "string" ? t.split(/[,\s]+/) : []) if (String(x ?? "").trim()) out.add(norm(String(x)));
  const body = text.replace(FM, "").replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
  for (const m of body.matchAll(/(^|[^\w&/#])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) out.add(norm(m[2]));
  return out;
}

const scalar = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : Array.isArray(v) ? v.map(String).join(", ") : String(v));

/**
 * Is the note a row of the view? Its filters run over the note alone (a
 * filter that looks at other notes — backlinks, a linked note's property —
 * sees only this one). A base that is missing or broken has no rows.
 */
export function isRowOf(baseText: string | null, view: string | undefined, path: string, text: string): boolean {
  if (baseText === null) return false;
  const p = parseBase(baseText);
  if (!p.ok) return false;
  if (view !== undefined && !p.base.views.some((v) => v.name === view)) return false;
  return runBase(p.base, [basesFileFromText(path, text)], { view }).total > 0;
}

/** The note's properties changed (`key`, or any of them). */
function propsChanged(before: string, after: string, key?: string): boolean {
  const a = frontmatter(before);
  const b = frontmatter(after);
  if (key) return scalar(a[key]) !== scalar(b[key]);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].some((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}

/** Does `rule` fire on `event`? */
export function fires(rule: Rule, event: VaultEvent, ctx: Pick<PlanContext, "today" | "lastDaily"> & { vault?: VaultView }): boolean {
  if (!rule.enabled) return false;
  const w = rule.when;
  switch (w.kind) {
    case "created":
      return event.kind === "created" && event.path.endsWith(".md") && (!w.folder || dir(event.path) === cleanFolder(w.folder) || event.path.startsWith(`${cleanFolder(w.folder)}/`));
    case "tagAdded": {
      if (event.kind === "daily" || (event.kind === "created" && event.moved)) return false;
      const before = event.kind === "created" ? new Set<string>() : tagsOf(event.before);
      const after = tagsOf(event.kind === "created" ? event.text : event.after);
      return after.has(norm(w.tag)) && !before.has(norm(w.tag));
    }
    case "propertyChanged": {
      if (event.kind !== "changed") return false;
      const a = scalar(frontmatter(event.before)[w.key]);
      const b = scalar(frontmatter(event.after)[w.key]);
      return a !== b && (w.value === undefined || b === w.value);
    }
    case "daily":
      return event.kind === "daily" && ctx.lastDaily?.[rule.id] !== event.date;
    case "rowChanged": {
      if (event.kind === "daily" || !event.path.endsWith(".md") || !ctx.vault) return false;
      if (event.kind === "created") {
        if (event.moved || w.property) return false;
        return isRowOf(ctx.vault.read(w.base), w.view, event.path, event.text);
      }
      return propsChanged(event.before, event.after, w.property) && isRowOf(ctx.vault.read(w.base), w.view, event.path, event.after);
    }
  }
}

/** `{{title}}`, `{{path}}`, `{{link}}`, `{{date}}` in an action's text. */
export function fill(text: string, path: string | null, date: string): string {
  const title = path ? base(path).replace(/\.md$/i, "") : "";
  return text.replace(/\{\{(title|path|link|date)\}\}/g, (_, k: string) => (k === "title" ? title : k === "path" ? path ?? "" : k === "link" ? (path ? `[[${title}]]` : "") : date));
}

/** Add `tag` to the note's frontmatter `tags:` (only that value changes). */
function withTag(text: string, tag: string): string {
  if (tagsOf(text).has(norm(tag))) return text;
  const fm = frontmatter(text);
  const cur = fm.tags;
  const list = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" && cur.trim() ? cur.split(/[,\s]+/).filter(Boolean) : [];
  return setProperty(text, "tags", [...list, tag.replace(/^#/, "")]);
}

/** A template's text appended to the note (its frontmatter merged key by key, the note's own values win). */
function withTemplate(text: string, template: string, path: string, date: string): string {
  const tm = FM.exec(template);
  let out = text;
  if (tm) {
    const own = frontmatter(text);
    for (const [k, v] of Object.entries(frontmatter(template))) {
      if (k in own) continue;
      const value = Array.isArray(v) ? v.map(String) : typeof v === "number" || typeof v === "boolean" ? v : v === null ? null : fill(scalar(v), path, date);
      out = setProperty(out, k, value);
    }
  }
  const body = fill(tm ? template.slice(tm[0].length) : template, path, date);
  if (!body.trim() || out.includes(body.trim())) return out;
  return out.replace(/\s*$/, "") + "\n\n" + body.replace(/^\s+/, "");
}

export interface Plan {
  changes: Change[];
  /** Rules that fired, in order (with the event they fired on). */
  fired: Array<{ rule: string; on: string; depth: number }>;
  /** Cascades cut by the loop guard. */
  stopped: Array<{ rule: string; on: string; reason: "depth" | "repeat" }>;
  /** Daily rules that ran (rule id → date), for the caller to remember. */
  dailyRan: Record<string, string>;
}

/**
 * Everything `rules` would do after `event`, including what their own
 * changes trigger (up to MAX_DEPTH), without touching the vault. A rule
 * runs at most once per note in one cascade, so two rules that undo each
 * other (tag A → move to X, in X → tag A …) stop instead of looping.
 */
export function plan(rules: readonly Rule[], event: VaultEvent, ctx: PlanContext): Plan {
  const files = new Map<string, string | null>();
  const read = (p: string) => (files.has(p) ? files.get(p)! : ctx.vault.read(p));
  const exists = (p: string) => (files.has(p) ? files.get(p) !== null : ctx.vault.exists(p));
  const out: Plan = { changes: [], fired: [], stopped: [], dailyRan: {} };
  const seen = new Set<string>();
  const queue: Array<{ event: VaultEvent; depth: number }> = [{ event, depth: 0 }];
  const write = (path: string, after: string, rule: string, depth: number, cascade = true) => {
    const before = read(path);
    if (before === after) return;
    out.changes.push({ kind: "write", path, before, after, rule });
    files.set(path, after);
    // A line added to the daily note is a log entry: it triggers nothing.
    if (cascade) queue.push({ event: before === null ? { kind: "created", path, text: after } : { kind: "changed", path, before, after }, depth: depth + 1 });
  };
  while (queue.length) {
    const { event: ev, depth } = queue.shift()!;
    const on = ev.kind === "daily" ? `daily:${ev.date}` : ev.path;
    for (const rule of rules) {
      if (!fires(rule, ev, { ...ctx, vault: { read, exists } })) continue;
      const key = `${rule.id}\u0000${on}`;
      if (seen.has(key)) {
        out.stopped.push({ rule: rule.id, on, reason: "repeat" });
        continue;
      }
      if (depth >= MAX_DEPTH) {
        out.stopped.push({ rule: rule.id, on, reason: "depth" });
        continue;
      }
      seen.add(key);
      out.fired.push({ rule: rule.id, on, depth });
      if (ev.kind === "daily") out.dailyRan[rule.id] = ev.date;
      let path = ev.kind === "daily" ? null : ev.path;
      for (const a of rule.then) {
        if (a.kind === "appendDaily") {
          const daily = ctx.dailyPath(ctx.today);
          const cur = read(daily) ?? "";
          const line = fill(a.text, path, ctx.today);
          if (!cur.split("\n").includes(line)) write(daily, cur ? `${cur.replace(/\s*$/, "")}\n${line}\n` : `${line}\n`, rule.id, depth, false);
          continue;
        }
        if (!path) continue; // a daily rule has no note of its own
        const text = read(path);
        if (text === null) continue;
        if (a.kind === "tag") write(path, withTag(text, a.tag), rule.id, depth);
        else if (a.kind === "template") {
          const tpl = read(a.template);
          if (tpl !== null) write(path, withTemplate(text, tpl, path, ctx.today), rule.id, depth);
        } else if (a.kind === "move") {
          const folder = cleanFolder(a.folder);
          if (dir(path) === folder) continue;
          let to = folder ? `${folder}/${base(path)}` : base(path);
          for (let n = 2; exists(to); n++) to = `${folder ? `${folder}/` : ""}${base(path).replace(/(\.md)?$/i, ` ${n}$1`)}`;
          out.changes.push({ kind: "move", from: path, to, rule: rule.id });
          files.set(to, text);
          files.set(path, null);
          queue.push({ event: { kind: "created", path: to, text, moved: true }, depth: depth + 1 });
          path = to;
        }
      }
    }
  }
  return out;
}

/* ─── Applying, the log and undo ─────────────────────────────────────── */

export interface Fs {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface RunLogEntry {
  id: string;
  at: string;
  event: string;
  changes: Change[];
  undone?: boolean;
}

/** Write a plan's changes; returns the log entry that undoes them. */
export async function applyPlan(p: Plan, fs: Fs, id: string, event: string, now: Date): Promise<RunLogEntry> {
  const done: Change[] = [];
  for (const c of p.changes) {
    if (c.kind === "write") {
      // The file as it is on disk right now is what undo restores.
      const before = await fs.read(c.path);
      await fs.write(c.path, c.after);
      done.push({ ...c, before });
    } else {
      await fs.move(c.from, c.to);
      done.push(c);
    }
  }
  return { id, at: now.toISOString(), event, changes: done };
}

/** Undo one run: every change in reverse, the files back byte for byte. Refuses when a file changed since. */
export async function undoRun(entry: RunLogEntry, fs: Fs): Promise<{ ok: true } | { ok: false; path: string }> {
  // Check first, against the state each step expects (a note may have been tagged, then moved).
  const overlay = new Map<string, string | null>();
  const cur = async (p: string) => (overlay.has(p) ? overlay.get(p)! : await fs.read(p));
  for (const c of [...entry.changes].reverse()) {
    if (c.kind === "write") {
      if ((await cur(c.path)) !== c.after) return { ok: false, path: c.path };
      overlay.set(c.path, c.before);
    } else {
      const text = await cur(c.to);
      if (text === null || (await cur(c.from)) !== null) return { ok: false, path: c.to };
      overlay.set(c.from, text);
      overlay.set(c.to, null);
    }
  }
  for (const c of [...entry.changes].reverse()) {
    if (c.kind === "write") {
      if (c.before === null) await fs.remove(c.path);
      else await fs.write(c.path, c.before);
    } else await fs.move(c.to, c.from);
  }
  return { ok: true };
}

/** Rules from the rules file (`.lumen/automations.json`); invalid entries are skipped. */
export function parseRules(json: string): Rule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { rules?: unknown }).rules) ? (raw as { rules: unknown[] }).rules : [];
  return list.filter((r): r is Rule => !!r && typeof r === "object" && typeof (r as Rule).id === "string" && !!(r as Rule).when && Array.isArray((r as Rule).then));
}
