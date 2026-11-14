/**
 * Plan W2.12 — embedded queries and saved searches.
 *
 * Acceptance:
 *   - 30 golden queries correct: ```query blocks (plan 11.3 operators plus
 *     view/sort/limit) run through `searchWorkspace` and `rowsFor`, the path
 *     the block itself takes, each with its exact expected notes.
 *   - 20 common Dataview blocks from real vaults render: parsed and run over
 *     a vault written the way Obsidian vaults are (front matter, inline
 *     `key:: value` fields, #tags, folders, links), each with its exact rows.
 *   - Update after a save < 100 ms: a note changes in a 1000-note vault, the
 *     index takes it and both kinds of block re-run, timed.
 *   - 0 eval: a static check of the query code.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryBackend, setVaultBackend } from "../storage/vault";
import { writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex, ensureIndex, indexedNotes, searchWorkspace } from "../storage/workspaceIndex";
import { VaultIndex } from "../storage/vaultIndexCore";
import { parseEmbeddedQuery, rowsFor, filterNotes, type QueryNote } from "../search/embeddedQuery";
import { DataviewError, frontMatter, inlineFields, parseDataview, runDataview, show, type DvNote } from "../search/dataview";
import { isSaved, removeSavedSearch, saveSearch, savedSearches } from "../search/savedSearches";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12); // 10.11.2026

/** path → [content, days ago modified] */
const VAULT: Record<string, [string, number]> = {
  "projects/alpha.md": ["---\ntags: [project, work]\nstatus: active\ndue: 2026-11-20\nrating: 4\nowner: Dana\n---\n# Alpha\n\nThe alpha launch plan. Links to [[Beta]].\n", 1],
  "projects/beta.md": ["---\ntags: project\nstatus: blocked\ndue: 2026-11-05\nrating: 2\nowner: Yossi\n---\n# Beta\n\nBeta is #blocked by legal. Meeting notes inside.\n", 3],
  "projects/gamma.md": ["---\ntags:\n  - project\n  - archive\nstatus: done\ndue: 2024-03-01\nrating: 5\nowner: Dana\n---\n# Gamma\n\nOld project, shipped.\n", 400],
  "daily/2026-11-08.md": ["# Sunday\n\nmood:: good\nStandup. #work #meeting/standup\n", 2],
  "daily/2026-11-09.md": ["# Monday\n\nmood:: tired\nWrote the #draft of the alpha launch plan. #work [[Alpha]]\n", 1],
  "daily/2026-11-10.md": ["# Tuesday\n\n[mood:: great] and a [[Gamma]] review. #personal\n", 0],
  "books/שלום.md": ["---\ntype: book\nauthor: עמוס עוז\nyear: 2002\nrating: 5\ntags: [book, עברית]\n---\n# סיפור על אהבה וחושך\n\nספר. #קריאה\n", 30],
  "books/dune.md": ["---\ntype: book\nauthor: Frank Herbert\nyear: 1965\nrating: 4\ntags: [book, scifi]\n---\n# Dune\n\nRead in 2025.\n", 60],
  "books/neuromancer.md": ["---\ntype: book\nauthor: William Gibson\nyear: 1984\nrating: 3\ntags: [book, scifi]\nfinished: false\n---\n# Neuromancer\n\nHalf way.\n", 10],
  "notes/recipes.md": ["# Recipes\n\nShakshuka and #food/breakfast ideas.\n\n```query\ntag:food\n```\n", 5],
  "notes/עברית.md": ["# פגישה\n\nסיכום הפגישה עם הצוות. #פגישות #עבודה\n", 4],
  "inbox.md": ["# Inbox\n\nTODO: call the bank.\n", 0],
};

const notes = (): DvNote[] => Object.entries(VAULT).map(([path, [content, ago]]) => ({ path, name: path.split("/").pop()!, content, modified: NOW - ago * DAY }));

beforeAll(async () => {
  setVaultBackend(createMemoryBackend());
  __resetWorkspaceIndex();
  for (const [path, [content]] of Object.entries(VAULT)) await writeWorkspaceFile(path, content);
  await ensureIndex(true);
});

/** Run a ```query block the way QueryBlock does, from `self` (the note that holds it). */
async function runQuery(src: string, self: string | null = null): Promise<string[]> {
  const q = parseEmbeddedQuery(src);
  const hits = await searchWorkspace(q.query, { limit: 501 });
  // As QueryBlock does (W2.22): the hits' text, read from the index.
  const byPath = new Map<string, QueryNote>((await indexedNotes(hits.map((h) => h.path))).map((f) => [f.path, { ...f, modified: NOW - (VAULT[f.path]?.[1] ?? 0) * DAY }]));
  return rowsFor(q, hits, byPath, self).map((r) => r.path);
}

/** The block source → the notes it must list. `ordered` ones compare in order. */
const QUERIES: Array<{ src: string; want: string[]; ordered?: boolean; self?: string }> = [
  { src: "tag:project", want: ["projects/alpha.md", "projects/beta.md", "projects/gamma.md"] },
  { src: "tag:project -tag:archive", want: ["projects/alpha.md", "projects/beta.md"] },
  { src: "tag:book", want: ["books/שלום.md", "books/dune.md", "books/neuromancer.md"] },
  { src: "tag:scifi", want: ["books/dune.md", "books/neuromancer.md"] },
  { src: "tag:עברית", want: ["books/שלום.md"] },
  { src: "tag:קריאה", want: ["books/שלום.md"] },
  { src: "tag:work", want: ["projects/alpha.md", "daily/2026-11-08.md", "daily/2026-11-09.md"] },
  { src: "tag:meeting", want: ["daily/2026-11-08.md"] },
  { src: "tag:food", want: [], self: "notes/recipes.md" },
  { src: "tag:food", want: ["notes/recipes.md"] },
  { src: "path:daily/", want: ["daily/2026-11-08.md", "daily/2026-11-09.md", "daily/2026-11-10.md"] },
  { src: "path:daily/\nsort: name", want: ["daily/2026-11-08.md", "daily/2026-11-09.md", "daily/2026-11-10.md"], ordered: true },
  { src: "path:daily/\nsort: name desc", want: ["daily/2026-11-10.md", "daily/2026-11-09.md", "daily/2026-11-08.md"], ordered: true },
  { src: "path:daily/\nsort: modified", want: ["daily/2026-11-10.md", "daily/2026-11-09.md", "daily/2026-11-08.md"], ordered: true },
  { src: "path:daily/\nsort: modified asc", want: ["daily/2026-11-08.md", "daily/2026-11-09.md", "daily/2026-11-10.md"], ordered: true },
  { src: "path:books/\nsort: path\nlimit: 2", want: ["books/dune.md", "books/neuromancer.md"], ordered: true },
  { src: "path:books/\nview: table\nsort: path desc\nlimit: 1", want: ["books/שלום.md"], ordered: true },
  { src: '"alpha launch plan"', want: ["projects/alpha.md", "daily/2026-11-09.md"] },
  { src: '"meeting notes"', want: ["projects/beta.md"] },
  { src: '"סיכום הפגישה"', want: ["notes/עברית.md"] },
  { src: "/shakshuka/i", want: ["notes/recipes.md"] },
  { src: "/^status: (active|blocked)$/m", want: ["projects/alpha.md", "projects/beta.md"] },
  { src: "/[unclosed/", want: [] },
  { src: "path:projects/ -blocked", want: ["projects/alpha.md", "projects/gamma.md"] },
  { src: "tag:book -tag:scifi", want: ["books/שלום.md"] },
  { src: "alpha", want: ["projects/alpha.md", "daily/2026-11-09.md"] },
  { src: "shakshuka", want: ["notes/recipes.md"] },
  { src: "tag:work\npath:daily/", want: ["daily/2026-11-08.md", "daily/2026-11-09.md"] },
  { src: "// my projects\ntag:project\nsort: name\nlimit: 2", want: ["projects/alpha.md", "projects/beta.md"], ordered: true },
  { src: "tag:nothing-here", want: [] },
];

describe("```query blocks — 30 golden queries", () => {
  it("has 30 cases", () => expect(QUERIES).toHaveLength(30));
  for (const c of QUERIES) {
    it(JSON.stringify(c.src), async () => {
      const got = await runQuery(c.src, c.self ?? null);
      if (c.ordered) expect(got).toEqual(c.want);
      else expect([...got].sort()).toEqual([...c.want].sort());
    });
  }

  it("reads the options and reports the ones it can't use", () => {
    const q = parseEmbeddedQuery("tag:a\nview: table\nsort: modified\nlimit: 5\nview: grid\nlimit: -1");
    expect(q).toMatchObject({ query: "tag:a", view: "table", sort: { key: "modified", desc: true }, limit: 5 });
    expect(q.problems).toEqual(["view: grid", "limit: -1"]);
  });

  it("filterNotes (no index) agrees with the index on operator queries", () => {
    const all = notes();
    for (const src of ["tag:project -tag:archive", "path:daily/", "tag:book -tag:scifi", '"meeting notes"']) {
      const viaIndex = QUERIES.find((c) => c.src === src)!.want;
      expect(filterNotes(parseEmbeddedQuery(src), all).map((h) => h.path).sort()).toEqual([...viaIndex].sort());
    }
  });
});

/** 20 blocks as they appear in Obsidian vaults, with their exact rows. */
const DATAVIEW: Array<{ src: string; want: Array<string | string[]>; headers?: string[] }> = [
  { src: 'LIST FROM #project', want: ["alpha", "beta", "gamma"] },
  { src: 'LIST FROM "books"', want: ["dune", "neuromancer", "שלום"] },
  { src: 'LIST FROM #book SORT rating DESC', want: ["שלום", "dune", "neuromancer"] },
  { src: 'TABLE author, year FROM #book SORT year ASC', headers: ["File", "author", "year"], want: [["dune", "Frank Herbert", "1965"], ["neuromancer", "William Gibson", "1984"], ["שלום", "עמוס עוז", "2002"]] },
  { src: 'TABLE status, due FROM #project WHERE status != "done" SORT due ASC', headers: ["File", "status", "due"], want: [["beta", "blocked", "2026-11-05"], ["alpha", "active", "2026-11-20"]] },
  { src: 'LIST WHERE status = "active"', want: ["alpha"] },
  { src: 'LIST FROM #project WHERE due < date(today)', want: ["beta", "gamma"] },
  { src: 'LIST FROM #project WHERE due >= date(today) AND status != "done"', want: ["alpha"] },
  { src: 'TABLE rating AS "Stars" FROM #book WHERE rating >= 4 SORT file.name', headers: ["File", "Stars"], want: [["dune", "4"], ["שלום", "5"]] },
  { src: 'TABLE WITHOUT ID file.link AS "Book", author FROM #scifi SORT file.name', headers: ["Book", "author"], want: [["dune", "Frank Herbert"], ["neuromancer", "William Gibson"]] },
  { src: 'LIST FROM "daily" SORT file.name DESC LIMIT 2', want: ["2026-11-10", "2026-11-09"] },
  { src: 'TABLE mood FROM "daily" SORT file.name', headers: ["File", "mood"], want: [["2026-11-08", "good"], ["2026-11-09", "tired"], ["2026-11-10", "great"]] },
  { src: 'LIST FROM [[Alpha]]', want: ["2026-11-09"] },
  { src: 'LIST FROM #project AND -#archive', want: ["alpha", "beta"] },
  { src: 'LIST FROM #scifi OR #עברית', want: ["dune", "neuromancer", "שלום"] },
  { src: 'LIST WHERE contains(file.tags, "#work")', want: ["2026-11-08", "2026-11-09", "alpha"] },
  { src: 'LIST WHERE contains(owner, "Dan") SORT file.name', want: ["alpha", "gamma"] },
  { src: 'LIST FROM #book WHERE finished = false', want: ["neuromancer"] },
  { src: 'TABLE file.mtime AS "Modified" FROM "daily" WHERE file.mtime >= date(today) - dur(1 day) SORT file.mtime DESC', headers: ["File", "Modified"], want: [["2026-11-10", new Date(NOW).toISOString().slice(0, 16).replace("T", " ")], ["2026-11-09", new Date(NOW - DAY).toISOString().slice(0, 16).replace("T", " ")]] },
  { src: 'LIST length(file.outlinks) FROM "daily" WHERE length(file.outlinks) > 0 SORT file.name', want: [["2026-11-09", "1"], ["2026-11-10", "1"]] },
];

describe("```dataview blocks — 20 common blocks from real vaults", () => {
  it("has 20 cases", () => expect(DATAVIEW).toHaveLength(20));
  for (const c of DATAVIEW) {
    it(c.src, () => {
      const r = runDataview(parseDataview(c.src), notes(), NOW);
      if (c.headers) expect(r.headers).toEqual(c.headers);
      const got = r.rows.map((row) => {
        if (r.type === "list") return row.cells.length && row.cells[0] !== null ? [row.name, show(row.cells[0])] : row.name;
        const withId = r.headers.length > row.cells.length;
        return [...(withId ? [row.name] : []), ...row.cells.map(show)];
      });
      const sorted = /SORT/i.test(c.src);
      if (sorted) expect(got).toEqual(c.want);
      else expect([...got].map(String).sort()).toEqual([...c.want].map(String).sort());
    });
  }

  it("reads front matter and inline fields", () => {
    expect(frontMatter(VAULT["projects/gamma.md"][0])).toMatchObject({ tags: ["project", "archive"], status: "done", rating: 5 });
    expect(inlineFields(VAULT["daily/2026-11-10.md"][0])).toEqual({ mood: "great" });
  });

  it("says what it does not support instead of guessing", () => {
    expect(() => parseDataview("TASK FROM #project")).toThrow(DataviewError);
    expect(() => parseDataview("LIST FROM #a GROUP BY status")).toThrow(/not supported/);
    expect(() => parseDataview('LIST WHERE nosuch(x)')).not.toThrow();
    expect(() => runDataview(parseDataview("LIST WHERE nosuch(x)"), notes(), NOW)).toThrow(/unknown function/);
  });
});

describe("live update after a save", () => {
  it("re-runs both kinds of block in under 100 ms in a 1000-note vault", () => {
    const big: DvNote[] = [];
    for (let i = 0; i < 1000; i++) {
      big.push({ path: `vault/n${i}.md`, name: `n${i}.md`, content: `---\nstatus: ${i % 3 ? "open" : "done"}\nrating: ${i % 5}\ntags: [t${i % 10}]\n---\n# Note ${i}\n\nSome text #topic${i % 7} and words.\n`, modified: NOW - i * 1000 });
    }
    const index = new VaultIndex();
    for (const n of big) index.upsert(n);
    const dv = parseDataview('TABLE status, rating FROM #t3 WHERE status = "open" SORT rating DESC LIMIT 20');
    const q = parseEmbeddedQuery("tag:t3 -tag:topic1\nsort: modified\nlimit: 20");
    const byPath = new Map<string, QueryNote>(big.map((n) => [n.path, n]));
    // Warm up once, as the block has run before the save.
    runDataview(dv, big, NOW);
    rowsFor(q, index.search(q.query, { limit: 501 }), byPath, null);

    const t0 = performance.now();
    const changed = { ...big[3], content: big[3].content.replace("status: open", "status: done"), modified: NOW };
    index.upsert(changed);
    big[3] = changed;
    byPath.set(changed.path, changed);
    const dvRows = runDataview(dv, big, NOW).rows;
    const qRows = rowsFor(q, index.search(q.query, { limit: 501 }), byPath, null);
    const ms = performance.now() - t0;
    expect(dvRows.some((r) => r.path === "vault/n3.md")).toBe(false);
    expect(qRows[0].path).toBe("vault/n3.md");
    expect(ms).toBeLessThan(100);
  });
});

describe("0 eval", () => {
  it("no eval, Function or string timers in the query code", () => {
    for (const f of ["src/search/dataview.ts", "src/search/embeddedQuery.ts", "src/search/savedSearches.ts", "src/views/QueryBlock.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(src, f).not.toMatch(/\beval\s*\(/);
      expect(src, f).not.toMatch(/\bnew\s+Function\b|\bFunction\s*\(/);
      expect(src, f).not.toMatch(/set(?:Timeout|Interval)\s*\(\s*["'`]/);
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});

describe("saved searches", () => {
  beforeEach(() => localStorage.clear());
  it("saves, keeps one per query, renames and removes", () => {
    saveSearch("tag:project", "Projects");
    saveSearch("path:daily/");
    saveSearch("tag:project", "My projects");
    expect(savedSearches()).toEqual([
      { name: "My projects", query: "tag:project" },
      { name: "path:daily/", query: "path:daily/" },
    ]);
    expect(isSaved(" tag:project ")).toBe(true);
    removeSavedSearch("tag:project");
    expect(savedSearches()).toEqual([{ name: "path:daily/", query: "path:daily/" }]);
    expect(saveSearch("   ")).toBeNull();
  });
});
