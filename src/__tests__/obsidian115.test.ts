/**
 * Obsidian 1.15 (plan W6.34): the format changes, against real files from
 * public vaults written by Obsidian 1.14–1.15 (fixtures/obsidian-corpus,
 * licences checked: obsidianmd/obsidian-importer, Munin-Template-Vault, NOAT,
 * all MIT), and the probe / diff tooling for the owner's run in the real app.
 *
 * What 1.14–1.15 changed in files (obsidian.md/changelog, 1.14.4 → 1.15.1):
 *   - `groupOrder:` on a grouped view: the groups to show, in order (a null
 *     item is "no value"); 1.14.4 stopped failing on a groupOrder that is not
 *     a list;
 *   - filters reordered by dragging, and moved between All views (top-level
 *     `filters:`) and This view (`views[i].filters:`);
 *   - a filter value with `"` or `\` is saved escaped (1.15.0 fix);
 *   - view keys written by the app: columnSize, columnWidth, imageFit,
 *     imageAspectRatio, enableSearch, rowHeight (kept as written).
 *   Canvas and callouts: no file-format change in 1.15 (performance and
 *   display fixes only).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { basesFileFromText, basesTextLiteral, moveFilter, orderGroups, parseBase, runBase, serializeBase, type BaseGroup } from "../views/bases/base";
import { BASES_MAX_LENGTH } from "../views/bases/evaluate";
import { diffResults, lumenResults, probeBases, PROBE_TYPE, readResult, type VaultFile } from "../views/bases/compare";
import { decodeUtf8 } from "../storage/textCodec";

const root = join(__dirname, "fixtures", "obsidian-corpus");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { vaults: Array<{ id: string; licence: string; files: Array<{ path: string }> }> };
const all = manifest.vaults.flatMap((v) => v.files.map((f) => ({ vault: v.id, path: f.path, text: decodeUtf8(new Uint8Array(readFileSync(join(root, v.id, f.path)))) })));
const bases = all.filter((f) => f.path.endsWith(".base"));
const NEW = ["obsidian-importer", "munin-template-vault", "noat"];

describe("the 1.15-era corpus", () => {
  it("adds three MIT vaults written by Obsidian 1.14–1.15, with their syntax", () => {
    for (const id of NEW) expect(manifest.vaults.find((v) => v.id === id)?.licence, id).toBe("MIT");
    const newer = bases.filter((f) => NEW.includes(f.vault));
    expect(newer.length).toBe(30);
    const has = (re: RegExp) => newer.filter((f) => re.test(f.text)).length;
    expect(has(/^\s+groupOrder:/m), "groupOrder").toBeGreaterThanOrEqual(8);
    expect(has(/type: kanban/), "kanban views").toBeGreaterThanOrEqual(8);
    expect(has(/^\s+columnSize:/m), "columnSize").toBeGreaterThanOrEqual(15);
    expect(has(/note\["/), 'note["…"]').toBeGreaterThanOrEqual(1);
    expect(has(/groupOrder:\n\s+- *\n/), "a null group").toBeGreaterThanOrEqual(1);
  });

  it("every .base still saves byte-identical, and every view runs without an error", () => {
    for (const f of bases) {
      const p = parseBase(f.text);
      expect(p.ok, `${f.vault}/${f.path}`).toBe(true);
      if (p.ok) expect(serializeBase(p.doc), `${f.vault}/${f.path}`).toBe(f.text);
    }
  });

  it("the TaskNotes formulas past 2,000 characters parse (Bases allow 8,000)", () => {
    const longest = Math.max(...bases.flatMap((f) => (f.text.match(/^ {2}\w+: (.+)$/gm) ?? []).map((l) => l.length)));
    expect(longest).toBeGreaterThan(2000);
    expect(longest).toBeLessThan(BASES_MAX_LENGTH);
  });
});

describe("groupOrder", () => {
  const files = [
    basesFileFromText("a.md", "---\nstatus: done\n---\n"),
    basesFileFromText("b.md", "---\nstatus: active\n---\n"),
    basesFileFromText("c.md", "---\nstatus: backlog\n---\n"),
    basesFileFromText("d.md", "---\ntitle: none\n---\n"),
    basesFileFromText("e.md", "---\nstatus: dropped\n---\n"),
  ];
  const view = (order: string) => `views:\n  - type: kanban\n    name: K\n    groupBy:\n      property: status\n      direction: ASC\n${order}`;
  const keys = (src: string) => {
    const p = parseBase(src);
    if (!p.ok) throw new Error(p.error);
    return runBase(p.base, files).groups!.map((g) => g.key);
  };

  it("shows the listed groups in that order, null for no value; the rest hidden", () => {
    expect(keys(view("    groupOrder:\n      - \n      - backlog\n      - active\n      - done\n"))).toEqual([null, "backlog", "active", "done"]);
    expect(keys(view("    groupOrder: []\n"))).toEqual([]);
  });

  it("absent or not a list (1.14.4's fix): every group, sorted", () => {
    expect(keys(view(""))).toEqual(["active", "backlog", "done", "dropped", null]);
    expect(keys(view("    groupOrder: done\n"))).toEqual(["active", "backlog", "done", "dropped", null]);
  });

  it("the official importer's board: the groups as Obsidian lists them", () => {
    const f = bases.find((x) => x.path.endsWith("notion-api/expected/board-views.base"))!;
    const p = parseBase(f.text);
    expect(p.ok && p.base.views[1].groupOrder).toEqual([null, "Not started", "In progress", "Done"]);
    const g = (k: string | null): BaseGroup => ({ key: k, rows: [] });
    expect(orderGroups([g("Done"), g(null), g("Other"), g("Not started")], [null, "Not started", "In progress", "Done"]).map((x) => x.key)).toEqual([null, "Not started", "Done"]);
  });
});

describe("filters: values with quotes and backslashes (1.15.0 fix)", () => {
  it("a literal written for a filter reads back as the same value", () => {
    for (const v of ['say "hi"', "C:\\notes\\x", 'a\\"b', "שורה\nשנייה", "tab\there", ""]) {
      const statement = `note.title == ${basesTextLiteral(v)}`;
      const base = parseBase(`views:\n  - type: table\n    name: T\n    filters: ${JSON.stringify(statement)}\n`);
      expect(base.ok, statement).toBe(true);
      if (!base.ok) continue;
      const files = [basesFileFromText("hit.md", `---\ntitle: ${JSON.stringify(v)}\n---\n`), basesFileFromText("miss.md", "---\ntitle: other\n---\n")];
      expect(runBase(base.base, files).rows.map((r) => r.file.path), statement).toEqual(["hit.md"]);
    }
  });
});

describe("filters: reorder, and move between All views and This view (1.15)", () => {
  const src = [
    "# My base",
    "filters:",
    "  and:",
    '    - file.ext == "md"',
    "views:",
    "  - type: table",
    "    name: Open",
    "    filters:",
    "      and:",
    '        - status != "done"',
    "        - priority > 1 # keep this comment",
    "    columnSize:",
    "      file.name: 200",
    "",
  ].join("\n");

  it("reorder inside a view, and back again: byte-identical", () => {
    const a = moveFilter(src, { view: 0, index: 1 }, { view: 0, index: 0 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const p = parseBase(a.text);
    expect(p.ok && p.base.views[0].filters).toEqual({ and: ["priority > 1", 'status != "done"'] });
    const b = moveFilter(a.text, { view: 0, index: 0 }, { view: 0, index: 1 });
    expect(b.ok && b.text).toBe(src);
  });

  it("This view → All views, and a single statement becomes an and: list", () => {
    const a = moveFilter(src, { view: 0, index: 0 }, { view: null, index: 1 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const p = parseBase(a.text);
    expect(p.ok && p.base.filters).toEqual({ and: ['file.ext == "md"', 'status != "done"'] });
    expect(p.ok && p.base.views[0].filters).toEqual({ and: ["priority > 1"] });
    expect(a.text).toContain("# My base");
    expect(a.text).toContain("# keep this comment");
    expect(a.text).toContain("file.name: 200");
    const single = moveFilter("filters: file.ext == \"md\"\nviews:\n  - type: table\n    name: T\n", { view: null, index: 0 }, { view: 0, index: 0 });
    expect(single.ok).toBe(true);
    if (single.ok) {
      const q = parseBase(single.text);
      expect(q.ok && q.base.views[0].filters).toEqual({ and: ['file.ext == "md"'] });
      expect(q.ok && q.base.filters).toEqual({ and: [] });
    }
    expect(moveFilter(src, { view: 3, index: 0 }, { view: null, index: 0 }).ok).toBe(false);
    expect(moveFilter(src, { view: 0, index: 9 }, { view: null, index: 0 }).ok).toBe(false);
  });

  it("every real view with two or more filters: reorder and back is byte-identical", () => {
    let n = 0;
    for (const f of bases) {
      const p = parseBase(f.text);
      if (!p.ok) continue;
      p.base.views.forEach((v, i) => {
        if (!v.filters || typeof v.filters === "string" || !("and" in v.filters) || v.filters.and.length < 2) return;
        // Only plain `and:` lists written as such (the writer's target).
        if (!new RegExp(`\\n {4}filters:\\n {6}and:\\n`).test(f.text)) return;
        const a = moveFilter(f.text, { view: i, index: 1 }, { view: i, index: 0 });
        expect(a.ok, `${f.vault}/${f.path}`).toBe(true);
        if (!a.ok) return;
        const b = moveFilter(a.text, { view: i, index: 0 }, { view: i, index: 1 });
        expect(b.ok && b.text, `${f.vault}/${f.path} [${v.name}]`).toBe(f.text);
        n++;
      });
    }
    expect(n).toBeGreaterThanOrEqual(10);
  });
});

describe("the owner's check against the real Obsidian: probes and the diff", () => {
  const vault = "munin-template-vault";
  const mine = all.filter((f) => f.vault === vault);
  const { probes, skipped } = probeBases(mine);

  it("one probe per view, each a single lumen-export view beside its base", () => {
    expect(skipped).toEqual([]);
    const views = mine.filter((f) => f.path.endsWith(".base")).reduce((n, f) => {
      const p = parseBase(f.text);
      return n + (p.ok ? p.base.views.length : 0);
    }, 0);
    expect(probes.length).toBe(views);
    for (const p of probes) {
      const parsed = parseBase(p.text);
      expect(parsed.ok, p.id).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.base.views.length).toBe(1);
      expect(parsed.base.views[0].type).toBe(PROBE_TYPE);
      expect(p.path.startsWith(p.source.replace(/\.base$/, ""))).toBe(true);
    }
    expect(new Set(probes.map((p) => p.id)).size).toBe(probes.length);
  });

  it("Lumen's probe rows are the original view's rows (where the view does not use `this`)", () => {
    const vf: VaultFile[] = mine.map((f) => ({ path: f.path, text: f.text, size: f.text.length, mtime: new Date("2026-01-01T00:00:00Z"), ctime: null }));
    const now = new Date("2026-11-12T12:00:00Z");
    const { results, errors } = lumenResults(probes, vf, now);
    expect(errors).toEqual([]);
    const files = vf.map((f) => basesFileFromText(f.path, f.path.endsWith(".md") ? f.text : null, { size: f.size, mtime: f.mtime }));
    let compared = 0;
    for (const p of probes) {
      const src = mine.find((f) => f.path === p.source)!;
      if (/\bthis\b/.test(src.text)) continue;
      const parsed = parseBase(src.text);
      if (!parsed.ok) continue;
      const want = runBase(parsed.base, files, { view: p.viewIndex, now }).rows.map((r) => r.file.path);
      expect(results.find((r) => r.id === p.id)!.rows, p.id).toEqual(want);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(20);
  });

  it("the diff: same, a different row, another order, no result", () => {
    const vf: VaultFile[] = mine.map((f) => ({ path: f.path, text: f.text, size: f.text.length, mtime: null, ctime: null }));
    const { results } = lumenResults(probes, vf);
    const same = diffResults(probes, results, results);
    expect(same.same).toBe(probes.length);
    const withRows = results.filter((r) => r.rows.length >= 2);
    const ordered = probes.find((p) => p.ordered && withRows.some((r) => r.id === p.id))!;
    const changed = results.map((r) => (r.id === withRows[0].id ? { ...r, rows: [...r.rows.slice(1), "extra.md"] } : r.id === ordered.id && ordered.id !== withRows[0].id ? { ...r, rows: [...r.rows].reverse() } : r)).filter((r) => r.id !== results[results.length - 1].id);
    const d = diffResults(probes, results, changed);
    const status = (id: string) => d.lines.find((l) => l.id === id)!.status;
    expect(status(withRows[0].id)).toBe("rows");
    if (ordered.id !== withRows[0].id) expect(status(ordered.id)).toBe("order");
    expect(status(results[results.length - 1].id)).toBe("missing");
    expect(readResult('{"id":"x","rows":["a.md"],"groups":[{"key":null,"rows":["a.md"]}]}')).toEqual({ id: "x", rows: ["a.md"], groups: [{ key: "", rows: ["a.md"] }] });
    expect(readResult("nope")).toBeNull();
  });

  it("the plugin writes only inside _lumen-compare/ and uses the public Bases view API", () => {
    const js = readFileSync(join(__dirname, "..", "..", "tools", "obsidian-lumen-compare", "main.js"), "utf8");
    expect(js).toContain("registerBasesView(TYPE");
    expect(js).toContain('const TYPE = "lumen-export"');
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|require\("(?:fs|child_process|electron)"\)/);
    for (const m of js.matchAll(/adapter\.(?:write|mkdir)\(([^,)]+)/g)) expect(m[1]).toMatch(/^`\$\{DIR\}/);
  });
});
