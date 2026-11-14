/**
 * Lumen's Bases against Obsidian itself (plan W6.34). The check runs on the
 * owner's machine with the real Obsidian (1.15 or later):
 *
 *   1. `probeBases()` writes, next to each `.base` of a vault, one probe file
 *      per view: the same filters, formulas and view, with the view's type
 *      set to `lumen-export`. A tiny Obsidian plugin
 *      (tools/obsidian-lumen-compare) registers that view type and saves the
 *      rows Obsidian shows into `_lumen-compare/results/<id>.json`.
 *   2. `lumenResults()` runs the same probes with Lumen's engine, over the
 *      same files (probes included, `this` = the probe file, as in Obsidian).
 *   3. `diffResults()` compares them: the same rows (as a set, and the count),
 *      the same order where the view sorts or groups, the same groups.
 *
 * Probes sit beside the original, not in a folder of their own, so that
 * `this.file.folder` and links resolve the same way. `cleanProbes()`'s list
 * removes them again. Pure functions; scripts/obsidian-compare.mjs does the I/O.
 */

import { parseDocument } from "yaml";
import { basesFileFromText, parseBase, runBase } from "./base";
import { isEmptyValue, toText, type BasesFile } from "./values";

export const PROBE_TYPE = "lumen-export";
/** Probe files end with this, before `.base`: `Books ~lumen-probe 2.base`. */
export const PROBE_MARK = " ~lumen-probe ";
export const RESULTS_DIR = "_lumen-compare/results";

export interface Probe {
  /** A file-name-safe id: the probe's path, slashes as `__`. */
  id: string;
  /** The probe's path in the vault. */
  path: string;
  source: string;
  view: string;
  viewIndex: number;
  /** The view sorts or groups: row order is compared too. */
  ordered: boolean;
  text: string;
}

export const isProbe = (path: string) => path.includes(PROBE_MARK) && path.endsWith(".base");
const probeId = (path: string) => path.replace(/\.base$/, "").replace(/[\\/]/g, "__").replace(/[^\p{L}\p{N}_ .~-]/gu, "_");

/** One probe per view of each `.base` (probes and unparsable files skipped). */
export function probeBases(files: ReadonlyArray<{ path: string; text: string }>): { probes: Probe[]; skipped: string[] } {
  const probes: Probe[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (!f.path.endsWith(".base") || isProbe(f.path)) continue;
    const p = parseBase(f.text);
    if (!p.ok) {
      skipped.push(`${f.path}: ${p.error}`);
      continue;
    }
    p.base.views.forEach((view, i) => {
      const doc = parseDocument(f.text);
      const views = doc.get("views", true) as { items?: unknown[] } | undefined;
      const one = views?.items?.[i];
      if (one === undefined) {
        // A base without views: Lumen shows one table; so does Obsidian.
        doc.set("views", doc.createNode([{ type: PROBE_TYPE, name: view.name }]));
      } else {
        doc.set("views", doc.createNode([]));
        (doc.get("views", true) as { items: unknown[] }).items.push(one);
        doc.setIn(["views", 0, "type"], PROBE_TYPE);
      }
      const path = `${f.path.replace(/\.base$/, "")}${PROBE_MARK}${i + 1}.base`;
      probes.push({ id: probeId(path), path, source: f.path, view: view.name, viewIndex: i, ordered: view.sort.length > 0 || !!view.groupBy, text: doc.toString({ lineWidth: 0 }) });
    });
  }
  return { probes, skipped };
}

/** What a view shows, as both sides save it. */
export interface ViewResult {
  id: string;
  rows: string[];
  groups: Array<{ key: string; rows: string[] }>;
}

export interface VaultFile {
  path: string;
  /** Text of notes and bases; null for other files. */
  text: string | null;
  size: number;
  mtime: Date | null;
  ctime: Date | null;
}

/** Lumen's rows for every probe, over the vault's files (the probes among them). */
export function lumenResults(probes: readonly Probe[], vault: readonly VaultFile[], now: Date = new Date()): { results: ViewResult[]; errors: string[] } {
  const files: BasesFile[] = vault.map((f) => basesFileFromText(f.path, f.path.endsWith(".md") ? f.text : null, { size: f.size, mtime: f.mtime, ctime: f.ctime }));
  const results: ViewResult[] = [];
  const errors: string[] = [];
  for (const p of probes) {
    const parsed = parseBase(p.text);
    if (!parsed.ok) {
      errors.push(`${p.id}: ${parsed.error}`);
      continue;
    }
    const thisFile = files.find((f) => f.path === p.path) ?? basesFileFromText(p.path, null);
    const r = runBase(parsed.base, files, { view: 0, thisFile, now });
    for (const e of r.errors) errors.push(`${p.id}: ${e}`);
    const groups = (r.groups ?? []).map((g) => ({ key: isEmptyValue(g.key) ? "" : toText(g.key), rows: g.rows.map((x) => x.file.path) }));
    results.push({ id: p.id, rows: r.rows.map((x) => x.file.path), groups });
  }
  return { results, errors };
}

export type DiffStatus = "same" | "order" | "rows" | "missing";

export interface DiffLine {
  id: string;
  source: string;
  view: string;
  status: DiffStatus;
  lumen: number;
  obsidian: number | null;
  onlyLumen: string[];
  onlyObsidian: string[];
}

/**
 * Compare Lumen with Obsidian, probe by probe. `rows`: a different set of
 * rows (the acceptance check); `order`: the same rows in another order in a
 * view that sorts or groups; `missing`: Obsidian saved no result for it.
 */
export function diffResults(probes: readonly Probe[], lumen: readonly ViewResult[], obsidian: readonly ViewResult[]): { lines: DiffLine[]; same: number; total: number } {
  const L = new Map(lumen.map((r) => [r.id, r]));
  const O = new Map(obsidian.map((r) => [r.id, r]));
  const lines: DiffLine[] = probes.map((p) => {
    const l = L.get(p.id) ?? { id: p.id, rows: [], groups: [] };
    const o = O.get(p.id);
    if (!o) return { id: p.id, source: p.source, view: p.view, status: "missing", lumen: l.rows.length, obsidian: null, onlyLumen: [], onlyObsidian: [] };
    const ls = new Set(l.rows);
    const os = new Set(o.rows);
    const onlyLumen = l.rows.filter((x) => !os.has(x));
    const onlyObsidian = o.rows.filter((x) => !ls.has(x));
    let status: DiffStatus = onlyLumen.length || onlyObsidian.length || l.rows.length !== o.rows.length ? "rows" : "same";
    if (status === "same" && p.ordered) {
      const groupsDiffer = JSON.stringify(l.groups.map((g) => g.key)) !== JSON.stringify(o.groups.map((g) => g.key));
      if (groupsDiffer || l.rows.some((x, i) => x !== o.rows[i])) status = "order";
    }
    return { id: p.id, source: p.source, view: p.view, status, lumen: l.rows.length, obsidian: o.rows.length, onlyLumen, onlyObsidian };
  });
  return { lines, same: lines.filter((x) => x.status === "same").length, total: lines.length };
}

/** The report as Markdown. */
export function diffMarkdown(d: ReturnType<typeof diffResults>): string {
  const mark: Record<DiffStatus, string> = { same: "✅", order: "↕ order", rows: "❌ rows", missing: "⏳ no result" };
  const out = [`# Lumen vs Obsidian: ${d.same}/${d.total} views the same`, "", "| Base | View | Lumen | Obsidian | |", "|---|---|---|---|---|"];
  for (const l of d.lines) out.push(`| ${l.source} | ${l.view} | ${l.lumen} | ${l.obsidian ?? "—"} | ${mark[l.status]} |`);
  const bad = d.lines.filter((l) => l.status === "rows");
  if (bad.length) {
    out.push("", "## Rows that differ", "");
    for (const l of bad) {
      out.push(`### ${l.source} — ${l.view}`, "");
      for (const x of l.onlyLumen.slice(0, 20)) out.push(`- only in Lumen: ${x}`);
      for (const x of l.onlyObsidian.slice(0, 20)) out.push(`- only in Obsidian: ${x}`);
      out.push("");
    }
  }
  return out.join("\n") + "\n";
}

/** Read a result file the plugin saved; null when it is not one. */
export function readResult(text: string): ViewResult | null {
  try {
    const v = JSON.parse(text) as Partial<ViewResult>;
    if (typeof v.id !== "string" || !Array.isArray(v.rows)) return null;
    return { id: v.id, rows: v.rows.map(String), groups: Array.isArray(v.groups) ? v.groups.map((g) => ({ key: String(g?.key ?? ""), rows: Array.isArray(g?.rows) ? g.rows.map(String) : [] })) : [] };
  } catch {
    return null;
  }
}
