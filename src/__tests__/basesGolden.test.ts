/**
 * Obsidian Bases compatibility (plan W1.11): 20 golden `.base` files run
 * over a fixed vault give the rows, order, groups and values in
 * fixtures/bases/expected.json; each file read and written back without an
 * edit holds the same YAML data; ≥ 90 % of the documented functions run.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { basesFileFromText, basesLatLng, parseBase, runBase, sameBaseData, serializeBase, setViewSort, viewKind } from "../views/bases/base";
import { basesCoverage, BASES_DOCUMENTED, BASES_UNSUPPORTED } from "../views/bases/evaluate";
import { toPlain } from "../views/bases/values";
import { GOLDEN_NOW, VAULT } from "./fixtures/bases/vault";

const dir = join(__dirname, "fixtures", "bases");
const files = VAULT.map((v) => basesFileFromText(v.path, v.text, { mtime: new Date(v.mtime), size: v.size }));
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".base"))
  .sort();
interface Expected {
  rows: string[];
  cells?: Record<string, Record<string, unknown>>;
  groups?: Array<[string, number]>;
  total?: number;
  kind?: string;
  view2?: string[];
  points?: Array<[number, number]>;
  this?: string;
  summaries?: Record<string, unknown>;
  labels?: string[];
}
const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Record<string, Expected>;

describe("Obsidian Bases golden set (W1.11)", () => {
  it("has 20 .base files, each with an expected result", () => {
    expect(names).toHaveLength(20);
    for (const n of names) expect(expected[n.replace(/\.base$/, "")], n).toBeDefined();
  });

  for (const name of names) {
    const id = name.replace(/\.base$/, "");
    it(`${id}: same rows in the same order`, () => {
      const text = readFileSync(join(dir, name), "utf8");
      const p = parseBase(text);
      if (!p.ok) throw new Error(p.error);
      const want = expected[id];
      const thisFile = want.this ? files.find((f) => f.path === want.this) : null;
      const r = runBase(p.base, files, { now: GOLDEN_NOW, thisFile });
      expect(r.errors, `${id} errors`).toEqual([]);
      expect(
        r.rows.map((x) => x.file.path),
        id,
      ).toEqual(want.rows);
      for (const [path, cells] of Object.entries(want.cells ?? {})) {
        const row = r.rows.find((x) => x.file.path === path);
        expect(row, `${id} ${path}`).toBeDefined();
        for (const [col, v] of Object.entries(cells)) expect(toPlain(row!.cells[col]), `${id} ${path} ${col}`).toEqual(v);
      }
      if (want.groups) expect(r.groups?.map((g) => [toPlain(g.key), g.rows.length])).toEqual(want.groups);
      if (want.total !== undefined) expect(r.total).toBe(want.total);
      if (want.kind) expect(viewKind(r.view)).toBe(want.kind);
      if (want.points) expect(r.rows.map((x) => basesLatLng(x.cells[r.view.coordinates ?? "note.location"])).map((pt) => (pt ? [pt.lat, pt.lng] : null))).toEqual(want.points);
      if (want.summaries) expect(Object.fromEntries(Object.entries(r.summaries).map(([k, v]) => [k, toPlain(v)]))).toEqual(want.summaries);
      if (want.labels) expect(r.columns.map((c) => c.label)).toEqual(want.labels);
      if (want.view2) {
        const r2 = runBase(p.base, files, { now: GOLDEN_NOW, view: 1 });
        expect(r2.rows.map((x) => x.file.path)).toEqual(want.view2);
        expect(runBase(p.base, files, { now: GOLDEN_NOW, view: p.base.views[1].name }).rows.map((x) => x.file.path)).toEqual(want.view2);
      }
    });

    it(`${id}: read and written back unedited, the YAML is the same`, () => {
      const text = readFileSync(join(dir, name), "utf8");
      const p = parseBase(text);
      if (!p.ok) throw new Error(p.error);
      const out = serializeBase(p.doc);
      expect(sameBaseData(text, out), id).toBe(true);
      // Comments survive too.
      for (const line of text.split("\n").filter((l) => l.trim().startsWith("#"))) expect(out).toContain(line.trim());
    });
  }

  it("writing a view's sort changes only that view and keeps the comments", () => {
    const text = readFileSync(join(dir, "01-all-books.base"), "utf8");
    const w = setViewSort(text, 0, [{ property: "note.author", direction: "DESC" }]);
    if (!w.ok) throw new Error(w.error);
    expect(w.text).toContain("# Every book, by name.");
    const p = parseBase(w.text);
    if (!p.ok) throw new Error(p.error);
    expect(p.base.views[0].sort).toEqual([{ property: "note.author", direction: "DESC" }]);
    // Hebrew sorts after Latin, so by author descending the Hebrew author comes first.
    expect(runBase(p.base, files, { now: GOLDEN_NOW }).rows.map((x) => x.file.path).slice(0, 2)).toEqual(["Books/הנסיך הקטן.md", "Books/Neuromancer.md"]);
    expect(setViewSort(text, 3, []).ok).toBe(false);
  });

  it("supports at least 90% of the documented Bases functions", () => {
    const { supported, documented } = basesCoverage();
    expect(documented).toBe(BASES_DOCUMENTED.length);
    expect(documented).toBeGreaterThanOrEqual(68);
    expect(supported / documented).toBeGreaterThanOrEqual(0.9);
    expect([...BASES_UNSUPPORTED].every((n) => BASES_DOCUMENTED.includes(n))).toBe(true);
  });
});
