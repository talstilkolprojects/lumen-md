/**
 * Obsidian Bases files (plan W1.11): read and write `.base` YAML, and run a
 * view over the vault.
 *
 *   filters:                 # every view: a statement, or and / or / not lists
 *     and:
 *       - file.hasTag("book")
 *       - 'file.ext == "md"'
 *   formulas:
 *     ppu: (price / pages).toFixed(2)
 *   properties:
 *     note.author: { displayName: Author }
 *   views:
 *     - type: table          # table | cards | list | kanban | map
 *       name: Best
 *       filters: 'note.rating >= 4'
 *       order: [file.name, note.author, formula.ppu]
 *       sort: [{ property: note.rating, direction: DESC }]
 *       groupBy: { property: note.status, direction: ASC }
 *       limit: 10
 *       summaries: { note.price: Sum }
 *
 * Reading keeps the parsed YAML document, so writing back (`updateBase`)
 * changes only what was edited: comments, key order and quoting stay, and
 * keys this reader does not know (plugin views, column sizes) survive.
 */

import YAML, { isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq, type Document } from "yaml";
import { FormulaError } from "../formula/ast";
import { evaluateBases, parseBases, type BasesEvalOptions, type BasesScope, type BasesVault } from "./evaluate";
import type { BasesNode } from "./expr";
import { equalValues, fromYaml, isEmptyValue, isTagged, parseWikiLink, sortCompare, toText, truthy, type BasesFile, type BValue } from "./values";
import { builtinSummary, compileFilter, sortDate } from "./fastFilters";
export { builtinSummary, compileFilter } from "./fastFilters";

export type BasesFilter = string | { and: BasesFilter[] } | { or: BasesFilter[] } | { not: BasesFilter[] };

export type BasesViewType = "table" | "cards" | "list" | "kanban" | "map" | "calendar" | "timeline";

export interface BasesSort {
  property: string;
  direction: "ASC" | "DESC";
}

export interface BasesView {
  /** As written; unknown types (a plugin's) show as a table. */
  type: string;
  name: string;
  limit?: number;
  filters?: BasesFilter;
  order: string[];
  sort: BasesSort[];
  groupBy?: BasesSort;
  /**
   * Obsidian 1.14+: the group values to show, in order (`null` is the group
   * of notes with no value). Groups not listed are hidden, and an empty list
   * hides them all, as the Bases reference says. Absent: every group, sorted.
   */
  groupOrder?: Array<string | null>;
  /** Property → summary name (`Sum`, `Average`, or one of the file's own `summaries:`). */
  summaries: Record<string, string>;
  /** Cards: the property with the cover image. */
  image?: string;
  /** Map: the property with the coordinates. */
  coordinates?: string;
  /** Calendar and timeline (W1.12): the date property (default `note.date`). */
  date?: string;
  /** Timeline: the end-date property; without it an item is one day long. */
  end?: string;
}

/**
 * A relation (plan W1.12, a Lumen extension of the format): the notes a link
 * property points to, or — `incoming` — the notes whose property points here.
 * `property` holds `[[links]]` (one, or a list), as Obsidian writes them.
 */
export interface BasesRelation {
  property: string;
  incoming: boolean;
}

export const ROLLUP_FUNCTIONS = ["count", "sum", "avg", "min", "max", "earliest", "latest"] as const;
export type RollupFunction = (typeof ROLLUP_FUNCTIONS)[number];

/** A rollup: `function` over `property` of the notes of `relation`. */
export interface BasesRollup {
  relation: string;
  /** A property id of the related notes (`note.x`, `file.x`, `formula.x`); not needed for count. */
  property?: string;
  function: RollupFunction;
}

export interface BaseModel {
  filters?: BasesFilter;
  formulas: Record<string, string>;
  displayNames: Record<string, string>;
  summaries: Record<string, string>;
  views: BasesView[];
  /** W1.12: `relations:` and `rollups:` by name (columns `relation.<name>`, `rollup.<name>`). */
  relations: Record<string, BasesRelation>;
  rollups: Record<string, BasesRollup>;
}

export type BaseParse = { ok: true; base: BaseModel; doc: Document } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

function readFilter(v: unknown, where: string): BasesFilter | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isRecord(v)) {
    const keys = Object.keys(v);
    if (keys.length !== 1 || !["and", "or", "not"].includes(keys[0])) throw new Error(`${where}: a filter group is one of and:, or:, not:`);
    const k = keys[0] as "and" | "or" | "not";
    const items = v[k];
    const list = Array.isArray(items) ? items : items === null || items === undefined ? [] : [items];
    const out = list.map((x, i) => readFilter(x, `${where}.${k}[${i}]`)).filter((x): x is BasesFilter => x !== undefined);
    if (k === "and") return { and: out };
    if (k === "or") return { or: out };
    return { not: out };
  }
  throw new Error(`${where}: a filter is a statement or an and: / or: / not: list`);
}

function readSort(v: unknown): BasesSort | null {
  if (typeof v === "string") return { property: v, direction: "ASC" };
  if (!isRecord(v)) return null;
  // `column:` is how the first Bases releases (1.9) wrote it, and real
  // files still have it (plan W4.30); it means the same as `property:`.
  const property = typeof v.property === "string" ? v.property : typeof v.column === "string" ? v.column : null;
  if (property === null) return null;
  return { property, direction: String(v.direction ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC" };
}

/** Parse a `.base` file. Never throws. */
export function parseBase(text: string): BaseParse {
  let doc: Document;
  try {
    doc = parseDocument(text, { prettyErrors: false });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (doc.errors.length) return { ok: false, error: doc.errors[0].message };
  const raw: unknown = doc.toJS() ?? {};
  if (!isRecord(raw)) return { ok: false, error: "a .base file is a YAML map (filters:, formulas:, views:)" };
  try {
    const formulas: Record<string, string> = {};
    if (isRecord(raw.formulas)) for (const [k, v] of Object.entries(raw.formulas)) if (v !== null && v !== undefined) formulas[k] = String(v);
    const displayNames: Record<string, string> = {};
    // `display: { note.x: Label }`: the 1.9 form of `properties: { x: { displayName } }` (W4.30).
    if (isRecord(raw.display)) for (const [k, v] of Object.entries(raw.display)) if (typeof v === "string") displayNames[propertyId(k)] = v;
    if (isRecord(raw.properties))
      for (const [k, v] of Object.entries(raw.properties)) if (isRecord(v) && typeof v.displayName === "string") displayNames[propertyId(k)] = v.displayName;
    const summaries: Record<string, string> = {};
    if (isRecord(raw.summaries)) for (const [k, v] of Object.entries(raw.summaries)) if (typeof v === "string") summaries[k] = v;
    const views: BasesView[] = [];
    const rawViews = Array.isArray(raw.views) ? raw.views : [];
    rawViews.forEach((rv, i) => {
      if (!isRecord(rv)) return;
      const sort = (Array.isArray(rv.sort) ? rv.sort : rv.sort ? [rv.sort] : []).map(readSort).filter((x): x is BasesSort => !!x);
      const groupBy = rv.groupBy === undefined || rv.groupBy === null ? undefined : (readSort(rv.groupBy) ?? undefined);
      const viewSummaries: Record<string, string> = {};
      if (isRecord(rv.summaries)) for (const [k, v] of Object.entries(rv.summaries)) if (typeof v === "string") viewSummaries[propertyId(k)] = v;
      views.push({
        type: typeof rv.type === "string" ? rv.type : "table",
        name: typeof rv.name === "string" ? rv.name : `View ${i + 1}`,
        limit: typeof rv.limit === "number" && rv.limit > 0 ? Math.floor(rv.limit) : undefined,
        filters: readFilter(rv.filters, `views[${i}].filters`),
        order: Array.isArray(rv.order) ? rv.order.map((x) => propertyId(String(x))) : [],
        sort: sort.map((s) => ({ ...s, property: propertyId(s.property) })),
        groupBy: groupBy ? { ...groupBy, property: propertyId(groupBy.property) } : undefined,
        // A groupOrder that is not a list is ignored (Obsidian 1.14.4 fixed a base that failed to load over it).
        groupOrder: Array.isArray(rv.groupOrder) ? rv.groupOrder.map((x) => (x === null || x === undefined || x === "" ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x))) : undefined,
        summaries: viewSummaries,
        image: typeof rv.image === "string" ? propertyId(rv.image) : undefined,
        coordinates: typeof rv.coordinates === "string" ? propertyId(rv.coordinates) : undefined,
        date: typeof rv.date === "string" ? propertyId(rv.date) : undefined,
        end: typeof rv.end === "string" ? propertyId(rv.end) : undefined,
      });
    });
    if (!views.length) views.push({ type: "table", name: "Table", order: [], sort: [], summaries: {} });
    const relations: Record<string, BasesRelation> = {};
    if (isRecord(raw.relations))
      for (const [name, r] of Object.entries(raw.relations)) {
        const rel = typeof r === "string" ? { property: r } : r;
        if (!isRecord(rel) || typeof rel.property !== "string" || !rel.property.trim()) throw new Error(`relations.${name}: needs a property (the link property)`);
        relations[name] = { property: rel.property.trim().replace(/^note\./, ""), incoming: rel.incoming === true || rel.direction === "incoming" };
      }
    const rollups: Record<string, BasesRollup> = {};
    if (isRecord(raw.rollups))
      for (const [name, r] of Object.entries(raw.rollups)) {
        if (!isRecord(r) || typeof r.relation !== "string") throw new Error(`rollups.${name}: needs a relation`);
        if (!relations[r.relation]) throw new Error(`rollups.${name}: no relation named ${r.relation}`);
        const fn = String(r.function ?? "count").toLowerCase();
        if (!(ROLLUP_FUNCTIONS as readonly string[]).includes(fn)) throw new Error(`rollups.${name}: function is one of ${ROLLUP_FUNCTIONS.join(", ")}`);
        if (fn !== "count" && typeof r.property !== "string") throw new Error(`rollups.${name}: ${fn} needs a property`);
        rollups[name] = { relation: r.relation, property: typeof r.property === "string" ? propertyId(r.property) : undefined, function: fn as RollupFunction };
      }
    return { ok: true, doc, base: { filters: readFilter(raw.filters, "filters"), formulas, displayNames, summaries, views, relations, rollups } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The text of a parsed `.base`: what was read, with only the edits made to `doc`. */
export function serializeBase(doc: Document): string {
  return doc.toString({ lineWidth: 0 });
}

/**
 * Edit a `.base` in place: `edit` gets the YAML document (comments, order
 * and keys this reader does not know survive). Returns the new text, or the
 * error when the text is not a base.
 */
export function updateBase(text: string, edit: (doc: Document) => void): { ok: true; text: string } | { ok: false; error: string } {
  const p = parseBase(text);
  if (!p.ok) return p;
  try {
    edit(p.doc);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, text: serializeBase(p.doc) };
}

/** Writer: set one view's sort (what clicking a column header saves). */
export function setViewSort(text: string, view: number, sort: BasesSort[]): { ok: true; text: string } | { ok: false; error: string } {
  return updateBase(text, (doc) => {
    const views = doc.get("views");
    if (!isSeq(views) || !isMap(views.get(view))) throw new Error(`no view ${view + 1}`);
    doc.setIn(["views", view, "sort"], doc.createNode(sort.map((s) => ({ property: s.property, direction: s.direction }))));
  });
}

/** Two `.base` texts hold the same YAML data (what "saved without changes" must keep). */
export function sameBaseData(a: string, b: string): boolean {
  const x: unknown = YAML.parse(a);
  const y: unknown = YAML.parse(b);
  return JSON.stringify(canonical(x)) === JSON.stringify(canonical(y));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

/* ─── Property ids ───────────────────────────────────────────────────── */

/** `status` → `note.status`; `file.name`, `formula.x`, `note.x` stay. */
export function propertyId(id: string): string {
  const s = id.trim();
  if (/^(note|file|formula|relation|rollup)\./.test(s)) return s;
  return `note.${s}`;
}

/** The column header: `properties:` displayName, else the name without its namespace. */
export function propertyLabel(base: BaseModel, id: string): string {
  return base.displayNames[id] ?? (/^(note|formula|relation|rollup)\./.test(id) ? id.slice(id.indexOf(".") + 1) : id);
}

/* ─── Vault: files from notes ────────────────────────────────────────── */

const FM = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/;

/** A vault file as Bases sees it, from its path, text (notes) and size / times. */
export function basesFileFromText(path: string, text: string | null, meta: { size?: number; mtime?: Date | null; ctime?: Date | null } = {}): BasesFile {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const basename = dot > 0 ? name.slice(0, dot) : name;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  let fm: Record<string, unknown> = {};
  let body = text ?? "";
  if (text !== null) {
    const m = FM.exec(text);
    if (m) {
      try {
        const parsed: unknown = YAML.parse(m[1]);
        if (isRecord(parsed)) fm = parsed;
      } catch {
        // why: unreadable frontmatter: the note has no properties, as Obsidian shows it
        // A broken frontmatter is a note without properties, as in Obsidian.
      }
      body = text.slice(m[0].length);
    }
  }
  const tags = new Set<string>();
  const fmTags = fm.tags ?? fm.tag;
  for (const t of Array.isArray(fmTags) ? fmTags : typeof fmTags === "string" ? fmTags.split(/[,\s]+/) : []) {
    const s = String(t ?? "").trim().replace(/^#/, "");
    if (s) tags.add(s);
  }
  const links: string[] = [];
  const embeds: string[] = [];
  // Frontmatter links count as links (`up: "[[Index]]"`).
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof v === "string") {
      const l = parseWikiLink(v);
      if (l && l.path) links.push(l.path);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (isRecord(v)) Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(fm, 0);
  if (text !== null) {
    const prose = body.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
    for (const m of prose.matchAll(/(^|[^\w&/])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) tags.add(m[2]);
    for (const m of prose.matchAll(/(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) (m[1] ? embeds : links).push(m[2].trim());
    for (const m of prose.matchAll(/(!?)\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const target = decodeURIComponent(m[2]).replace(/#.*$/, "");
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      (m[1] ? embeds : links).push(target);
    }
  }
  return { path, name, basename, ext, folder, size: meta.size ?? (text === null ? 0 : new TextEncoder().encode(text).length), ctime: meta.ctime ?? meta.mtime ?? null, mtime: meta.mtime ?? null, tags: [...tags], links, embeds, fm };
}

/** Resolve links the way Obsidian does: by path, path without `.md`, or note name (shortest path first). */
export function buildVault(files: readonly BasesFile[]): BasesVault {
  const byPath = new Map<string, BasesFile>();
  const byName = new Map<string, BasesFile>();
  // Built on the first lookup (W6.46): a view without links never pays for it (10,000 files: ~14 ms a run).
  let built = false;
  const build = () => {
    built = true;
    const sorted = [...files].sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1));
    for (const f of sorted) {
      const p = f.path.toLowerCase();
      byPath.set(p, f);
      if (f.ext === "md") byPath.set(p.replace(/\.md$/, ""), f);
      const n = f.ext === "md" ? f.basename.toLowerCase() : f.name.toLowerCase();
      if (!byName.has(n)) byName.set(n, f);
    }
  };
  const resolve = (target: string) => {
    if (!built) build();
    const t = target.trim().replace(/^\/+/, "").toLowerCase();
    return byPath.get(t) ?? byName.get(t) ?? byName.get(t.slice(t.lastIndexOf("/") + 1)) ?? null;
  };
  let back: Map<string, BasesFile[]> | null = null;
  return {
    resolve,
    backlinks(file) {
      if (!back) {
        back = new Map();
        for (const f of files) {
          for (const l of new Set(f.links)) {
            const to = resolve(l);
            if (!to) continue;
            if (!back.has(to.path)) back.set(to.path, []);
            back.get(to.path)!.push(f);
          }
        }
      }
      return back.get(file.path) ?? [];
    },
  };
}

/* ─── Running a view ─────────────────────────────────────────────────── */

export interface BaseRow {
  file: BasesFile;
  /** Property id → value, for every column, sort and group property. */
  cells: Record<string, BValue>;
}

export interface BaseGroup {
  key: BValue;
  rows: BaseRow[];
}

export interface BaseResult {
  view: BasesView;
  viewIndex: number;
  columns: Array<{ id: string; label: string }>;
  rows: BaseRow[];
  /** Present when the view has `groupBy`, in group order. */
  groups?: BaseGroup[];
  /** Matching files before `limit`. */
  total: number;
  summaries: Record<string, BValue>;
  /** Parse and evaluation errors, one line each (deduplicated). */
  errors: string[];
}

export interface RunOptions extends BasesEvalOptions {
  /** View index or name. Default the first. */
  view?: number | string;
  /** `this`: the base file, or the note that embeds it. */
  thisFile?: BasesFile | null;
}

const err = (where: string, e: FormulaError) => `${where}: ${e.message}${e.at >= 0 ? ` (character ${e.at + 1})` : ""}`;

/** A view's rows, columns, groups and summaries. Pure: the same files give the same result. */
export function runBase(base: BaseModel, files: readonly BasesFile[], opts: RunOptions = {}): BaseResult {
  const errors = new Set<string>();
  const viewIndex = typeof opts.view === "string" ? Math.max(0, base.views.findIndex((v) => v.name === opts.view)) : Math.min(Math.max(0, opts.view ?? 0), base.views.length - 1);
  const view = base.views[viewIndex];
  const vault = buildVault(files);
  // Parsed once per run, by place and source (two maps: no key string built per row).
  const parsed = new Map<string, Map<string, BasesNode | null>>();
  const parse = (src: string, where: string): BasesNode | null => {
    let at = parsed.get(where);
    if (!at) parsed.set(where, (at = new Map()));
    const hit = at.get(src);
    if (hit !== undefined) return hit;
    const p = parseBases(src);
    if (!p.ok) errors.add(err(where, p.error));
    at.set(src, p.ok ? p.tree : null);
    return p.ok ? p.tree : null;
  };
  const compiled = new Map<BasesNode, ((file: BasesFile) => boolean) | null>();
  const formulaTrees = new Map<string, BasesNode | null>();
  // An empty formula (`name: ""`, as Obsidian saves a new column) is an empty column, not an error.
  for (const [name, src] of Object.entries(base.formulas)) formulaTrees.set(name, src.trim() ? parse(src, `formula ${name}`) : null);

  // One "now" for the whole run (and no clock read per expression).
  const evalOpts: BasesEvalOptions = { now: opts.now ?? new Date(), limits: opts.limits, locale: opts.locale, random: opts.random };
  const scopeFor = (file: BasesFile) => {
    let memo: Map<string, BValue> | null = null;
    let busy: Set<string> | null = null;
    const scope: BasesScope & { formula: (name: string) => BValue } = {
      file,
      thisFile: opts.thisFile ?? null,
      vault,
      // W6.46: formulas reach relations and rollups (`relation.tasks.map(current.prop("Estimate"))`).
      relation: (name: string): BValue => (base.relations[name] ? related(file, base.relations[name]).map((f): BValue => ({ $: "file", file: f })) : null),
      rollup: (name: string): BValue => rollup(name, file),
      formula: (name: string): BValue => {
        memo ??= new Map();
        busy ??= new Set();
        if (memo.has(name)) return memo.get(name)!;
        const tree = formulaTrees.get(name);
        if (!tree) return null;
        if (busy.has(name)) throw new FormulaError("syntax", `formula ${name} refers to itself`);
        busy.add(name);
        try {
          const r = evaluateBases(tree, scope, evalOpts);
          const v = r.ok ? r.value : null;
          if (!r.ok) errors.add(err(`formula ${name}`, r.error));
          memo.set(name, v);
          return v;
        } finally {
          busy!.delete(name);
        }
      },
    };
    return scope;
  };

  const test = (f: BasesFilter | undefined, scope: ReturnType<typeof scopeFor>, where: string): boolean => {
    if (f === undefined) return true;
    if (typeof f === "string") {
      const tree = parse(f, where);
      if (!tree) return false;
      let fast = compiled.get(tree);
      if (fast === undefined) compiled.set(tree, (fast = compileFilter(tree)));
      if (fast) return fast(scope.file);
      const r = evaluateBases(tree, scope, evalOpts);
      if (!r.ok) {
        errors.add(err(where, r.error));
        return false;
      }
      return truthy(r.value);
    }
    if ("and" in f) return f.and.every((x) => test(x, scope, where));
    if ("or" in f) return f.or.some((x) => test(x, scope, where));
    return !f.not.some((x) => test(x, scope, where));
  };

  const value = (id: string, scope: ReturnType<typeof scopeFor>): BValue => {
    const dot = id.indexOf(".");
    const ns = id.slice(0, dot);
    const key = id.slice(dot + 1);
    if (ns === "formula") return scope.formula(key);
    if (ns === "relation") return base.relations[key] ? related(scope.file, base.relations[key]).map((f): BValue => ({ $: "file", file: f })) : null;
    if (ns === "rollup") return rollup(key, scope.file);
    // note.x is read straight from the frontmatter (the same value the interpreter gives).
    if (ns === "note") return Object.prototype.hasOwnProperty.call(scope.file.fm, key) ? fromYaml(scope.file.fm[key]) : null;
    // The plain file fields, without the interpreter (W6.46: 10,000 rows × every column).
    if (ns === "file") {
      const f = scope.file;
      switch (key) {
        case "name":
          return f.name;
        case "basename":
          return f.basename;
        case "path":
          return f.path;
        case "folder":
          return f.folder;
        case "ext":
          return f.ext;
        case "size":
          return f.size;
        case "ctime":
          return f.ctime;
        case "mtime":
          return f.mtime;
      }
    }
    const tree = parse(id, `property ${id}`);
    return tree ? evaluateNode(tree, scope) : null;
  };
  const evaluateNode = (tree: BasesNode, scope: ReturnType<typeof scopeFor>): BValue => {
    const r = evaluateBases(tree, scope, evalOpts);
    if (!r.ok) errors.add(err("property", r.error));
    return r.ok ? r.value : null;
  };

  // Relations: outgoing — the files a link property points to; incoming —
  // the files whose property points here (one index per property, built once).
  const incomingIndex = new Map<string, Map<string, BasesFile[]>>();
  const linksIn = (f: BasesFile, prop: string): string[] => {
    const raw = f.fm[prop];
    const out: string[] = [];
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (typeof v !== "string") continue;
      const l = parseWikiLink(v);
      if (l?.path) out.push(l.path);
    }
    return out;
  };
  const related = (file: BasesFile, rel: BasesRelation): BasesFile[] => {
    if (!rel.incoming) {
      const seen = new Set<string>();
      const out: BasesFile[] = [];
      for (const target of linksIn(file, rel.property)) {
        const f = vault.resolve(target);
        if (f && !seen.has(f.path)) {
          seen.add(f.path);
          out.push(f);
        }
      }
      return out;
    }
    let index = incomingIndex.get(rel.property);
    if (!index) {
      index = new Map();
      for (const f of files) {
        for (const target of new Set(linksIn(f, rel.property).map((t) => vault.resolve(t)?.path).filter((p): p is string => !!p))) {
          if (!index.has(target)) index.set(target, []);
          index.get(target)!.push(f);
        }
      }
      incomingIndex.set(rel.property, index);
    }
    return index.get(file.path) ?? [];
  };
  const rollupBusy = new Set<string>();
  const rollup = (name: string, file: BasesFile): BValue => {
    const r = base.rollups[name];
    if (!r) return null;
    const rel = base.relations[r.relation];
    const targets = related(file, rel);
    if (r.function === "count") return targets.length;
    const key = `${name}\u0000${file.path}`;
    if (rollupBusy.has(key)) {
      errors.add(`rollup ${name}: refers to itself`);
      return null;
    }
    rollupBusy.add(key);
    try {
      const values = targets.map((f) => value(r.property!, scopeFor(f)));
      const flat = values.flatMap((v) => (Array.isArray(v) ? v : [v]));
      const summary = { sum: "Sum", avg: "Average", min: "Min", max: "Max", earliest: "Earliest", latest: "Latest" }[r.function];
      const out = builtinSummary(summary, flat);
      return out === undefined ? null : out;
    } finally {
      rollupBusy.delete(key);
    }
  };

  const columns = (view.order.length ? view.order : ["file.name"]).map((id) => ({ id, label: propertyLabel(base, id) }));
  const needed = new Set<string>([...columns.map((c) => c.id), ...view.sort.map((s) => s.property), ...Object.keys(view.summaries)]);
  if (view.groupBy) needed.add(view.groupBy.property);
  if (view.image) needed.add(view.image);
  if (view.coordinates) needed.add(view.coordinates);
  const kind = viewKind(view);
  if (kind === "calendar" || kind === "timeline") needed.add(view.date ?? "note.date");
  if (kind === "timeline" && view.end) needed.add(view.end);

  const matched: BaseRow[] = [];
  for (const file of files) {
    const scope = scopeFor(file);
    if (!test(base.filters, scope, "filters")) continue;
    if (!test(view.filters, scope, `view ${view.name} filters`)) continue;
    const cells: Record<string, BValue> = {};
    for (const id of needed) cells[id] = value(id, scope);
    matched.push({ file, cells });
  }

  const keys = [...(view.groupBy ? [view.groupBy] : []), ...view.sort];
  // Dates parsed once per row, not once per comparison (10,000 rows: ~5× faster).
  // …and emptiness once per row too (W6.46).
  const decorated = matched.map((r) => ({ r, d: keys.map((k) => sortDate(r.cells[k.property])), e: keys.map((k) => isEmptyValue(r.cells[k.property])) }));
  decorated.sort((x, y) => {
    const a = x.r;
    const b = y.r;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const da = x.d[i];
      const db = y.d[i];
      const d = da !== null && db !== null ? Math.sign(da - db) : sortCompare(a.cells[k.property], b.cells[k.property]);
      // Empty values stay last in both directions.
      if (d) return x.e[i] || y.e[i] ? d : k.direction === "DESC" ? -d : d;
    }
    return a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0;
  });
  for (let i = 0; i < decorated.length; i++) matched[i] = decorated[i].r;
  const total = matched.length;
  const rows = view.limit ? matched.slice(0, view.limit) : matched;

  let groups: BaseGroup[] | undefined;
  if (view.groupBy) {
    groups = [];
    const prop = view.groupBy.property;
    for (const r of rows) {
      const k = r.cells[prop];
      const last = groups[groups.length - 1];
      if (last && (equalValues(last.key, k) || (isEmptyValue(last.key) && isEmptyValue(k)))) last.rows.push(r);
      else groups.push({ key: isEmptyValue(k) ? null : k, rows: [r] });
    }
    if (view.groupOrder) groups = orderGroups(groups, view.groupOrder);
  }

  const summaries: Record<string, BValue> = {};
  for (const [id, name] of Object.entries(view.summaries)) {
    const values = rows.map((r) => r.cells[id]);
    const custom = base.summaries[name];
    if (custom !== undefined) {
      const tree = parse(custom, `summary ${name}`);
      if (!tree) continue;
      const r = evaluateBases(tree, { file: rows[0]?.file ?? basesFileFromText(".base", null), vault, locals: { values } }, evalOpts);
      if (r.ok) summaries[id] = r.value;
      else errors.add(err(`summary ${name}`, r.error));
      continue;
    }
    const s = builtinSummary(name, values);
    if (s === undefined) errors.add(`summary ${name}: not a summary (Average, Min, Max, Sum, Range, Median, Stddev, Earliest, Latest, Checked, Unchecked, Empty, Filled, Unique)`);
    else summaries[id] = s;
  }

  return { view, viewIndex, columns, rows, groups, total, summaries, errors: [...errors] };
}

/**
 * Groups in a view's `groupOrder` (Obsidian 1.14+): the listed values, in
 * that order, matched as text (`null` / an empty item: no value); the rest
 * hidden. Rows of a group with several values (a list) stay where they were.
 */
export function orderGroups(groups: BaseGroup[], order: ReadonlyArray<string | null>): BaseGroup[] {
  const keyText = (k: BValue) => (isEmptyValue(k) ? null : toText(k));
  const out: BaseGroup[] = [];
  for (const want of order) {
    const g = groups.find((x) => keyText(x.key) === want && !out.includes(x));
    if (g) out.push(g);
  }
  return out;
}

/* ─── Writers for the filter editor (Obsidian 1.15) ───────────────────── */

/**
 * A text literal for a filter: double quotes, with `\` and `"` escaped.
 * Obsidian 1.15 fixed filters whose value holds a quote or a backslash
 * (they were saved broken); this writes them the way the parser reads them.
 */
export function basesTextLiteral(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** Where a filter lives: the base's own (`All views`) or one view's (`This view`). */
export type FilterScope = { view: null } | { view: number };

function filterPath(scope: FilterScope): (string | number)[] {
  return scope.view === null ? ["filters"] : ["views", scope.view, "filters"];
}

/**
 * Move one filter statement (Obsidian 1.15: drag to reorder, and a filter
 * row's menu that moves it between All views and This view). Both ends are
 * top-level `and:` lists; a single statement or a missing `filters:` becomes
 * one. Everything else in the file stays as written.
 */
export function moveFilter(text: string, from: FilterScope & { index: number }, to: FilterScope & { index: number }): { ok: true; text: string } | { ok: false; error: string } {
  return updateBase(text, (doc) => {
    /** The `and:` list at a scope, made into one when it is a single statement or a group of another kind. */
    const andList = (scope: FilterScope, create: boolean): YAMLSeq => {
      if (scope.view !== null && !isMap(doc.getIn(["views", scope.view]))) throw new Error(`no view ${scope.view + 1}`);
      const path = filterPath(scope);
      const cur = doc.getIn(path, true);
      if (isMap(cur) && cur.items.length === 1) {
        const and = cur.get("and", true);
        if (isSeq(and)) return and;
      }
      const empty = cur === undefined || cur === null || (isScalar(cur) && (cur.value === null || cur.value === ""));
      if (empty && !create) throw new Error("no filters there");
      const seq = new YAMLSeq();
      if (!empty) seq.items.push(cur);
      const map = new YAMLMap();
      map.set("and", seq);
      doc.setIn(path, map);
      return seq;
    };
    const src = andList(from, false);
    if (from.index < 0 || from.index >= src.items.length) throw new Error(`no filter ${from.index + 1}`);
    const [item] = src.items.splice(from.index, 1);
    const dst = andList(to, true);
    dst.items.splice(Math.max(0, Math.min(to.index, dst.items.length)), 0, item);
  });
}

/** The kind of view to draw: a plugin's view type (unknown here) is drawn as a table. */
export function viewKind(view: BasesView): BasesViewType {
  const t = view.type.toLowerCase();
  return t === "cards" || t === "list" || t === "kanban" || t === "map" || t === "calendar" || t === "timeline" ? t : "table";
}

/** A cell value as a point, for the map view: `[lat, lng]`, `"lat, lng"` or `{lat, lng}`. */
export function basesLatLng(v: BValue): { lat: number; lng: number } | null {
  let lat = Number.NaN;
  let lng = Number.NaN;
  if (Array.isArray(v) && v.length === 2) {
    lat = Number(v[0]);
    lng = Number(v[1]);
  } else if (typeof v === "string") {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v);
    if (m) {
      lat = Number(m[1]);
      lng = Number(m[2]);
    }
  } else if (isTagged(v) && v.$ === "object") {
    lat = Number(v.map.lat ?? v.map.latitude);
    lng = Number(v.map.lng ?? v.map.lon ?? v.map.longitude);
  }
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
