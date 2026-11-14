/**
 * Plan 11.3 — #tags in the text and search operators.
 *
 * Acceptance: "30 operator queries correct". A fixed vault of 12 notes
 * (English, Hebrew, nested tags, tags in code, front matter in each form)
 * and 30 queries, each with the exact set of notes it must return, run
 * through `searchWorkspace` — the same path the search dialog and the
 * agent tool use (facade → index engine → VaultIndex).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createMemoryBackend, setVaultBackend } from "../storage/vault";
import { writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex, searchWorkspace } from "../storage/workspaceIndex";
import { noteTags, parseQuery } from "../search/queryOps";
import { VaultIndex } from "../storage/vaultIndexCore";

const VAULT: Record<string, string> = {
  "projects/alpha.md": "---\ntags: [project, work]\n---\n# Alpha\n\nThe alpha launch plan. Status: draft.\n",
  "projects/beta.md": "---\ntags: project\n---\n# Beta\n\nBeta is #blocked by legal. Meeting notes inside.\n",
  "projects/gamma.md": "---\ntags:\n  - project\n  - archive\n---\n# Gamma\n\nOld project, shipped 2024-03-01.\n",
  "daily/2026-10-20.md": "# Monday\n\nStandup. #work #meeting/standup\nCall with Dana at 10:30.\n",
  "daily/2026-10-21.md": "# Tuesday\n\nWrote the #draft of the alpha launch plan. #work\n",
  "daily/2026-10-22.md": "# Wednesday\n\n```js\n// #notatag in code\nconst x = '#alsonot';\n```\nInline `#nope` too. Real one: #personal\n",
  "notes/עברית.md": "# פגישה\n\nסיכום הפגישה עם הצוות. #פגישות #עבודה\nתאריך 2026-10-23\n",
  "notes/ניקוד.md": "# שלום\n\nשָׁלוֹם עוֹלָם — טקסט עם ניקוד. #עבודה\n",
  "notes/recipes.md": "# Recipes\n\nShakshuka and #food/breakfast ideas. Issue #42 is not a tag.\n",
  "notes/urls.md": "# Links\n\nSee https://example.com/page#section and the heading below.\n\n# Not a tag heading\n",
  "archive/old.md": "---\ntags: [archive]\n---\n# Old\n\nMeeting notes from 2019. #meeting\n",
  "inbox.md": "# Inbox\n\nTODO: call the bank. TODO: renew passport.\n",
};

const ALL = Object.keys(VAULT);

/** query → exactly the notes it must return (order-free). */
const CASES: Array<[string, string[]]> = [
  // tag: — front matter (inline list, plain value, block list) and body tags
  ["tag:project", ["projects/alpha.md", "projects/beta.md", "projects/gamma.md"]],
  ["tag:work", ["projects/alpha.md", "daily/2026-10-20.md", "daily/2026-10-21.md"]],
  ["tag:archive", ["projects/gamma.md", "archive/old.md"]],
  ["tag:blocked", ["projects/beta.md"]],
  ["tag:#Blocked", ["projects/beta.md"]],
  ["tag:meeting", ["daily/2026-10-20.md", "archive/old.md"]],
  ["tag:meeting/standup", ["daily/2026-10-20.md"]],
  ["tag:food", ["notes/recipes.md"]],
  ["tag:עבודה", ["notes/עברית.md", "notes/ניקוד.md"]],
  ["tag:פגישות", ["notes/עברית.md"]],
  // not tags: code, inline code, issue numbers, URL fragments, headings
  ["tag:notatag", []],
  ["tag:nope", []],
  ["tag:42", []],
  ["tag:section", []],
  // path:
  ["path:daily/", ["daily/2026-10-20.md", "daily/2026-10-21.md", "daily/2026-10-22.md"]],
  ["path:PROJECTS", ["projects/alpha.md", "projects/beta.md", "projects/gamma.md"]],
  ["path:notes/ -path:עברית", ["notes/ניקוד.md", "notes/recipes.md", "notes/urls.md"]],
  // "phrase"
  ['"alpha launch plan"', ["projects/alpha.md", "daily/2026-10-21.md"]],
  ['"meeting notes"', ["projects/beta.md", "archive/old.md"]],
  ['"שלום עולם"', ["notes/ניקוד.md"]],
  // /regex/
  ["/\\d{4}-\\d{2}-\\d{2}/", ["projects/gamma.md", "notes/עברית.md"]],
  ["/^TODO:/m", ["inbox.md"]],
  ["/dana|bank/i", ["daily/2026-10-20.md", "inbox.md"]],
  ["/[/", []],
  // - (negation) of each kind
  ["tag:project -tag:archive", ["projects/alpha.md", "projects/beta.md"]],
  ["tag:work -path:daily", ["projects/alpha.md"]],
  ['tag:meeting -"meeting notes"', ["daily/2026-10-20.md"]],
  ["path:projects -/shipped/", ["projects/alpha.md", "projects/beta.md"]],
  ["path:projects -legal", ["projects/alpha.md", "projects/gamma.md"]],
  // operators with ranked words
  ["plan tag:draft", ["daily/2026-10-21.md"]],
];

beforeAll(async () => {
  setVaultBackend(createMemoryBackend());
  __resetWorkspaceIndex();
  for (const [p, c] of Object.entries(VAULT)) await writeWorkspaceFile(p, c);
});

describe("search operators (plan 11.3.2): 30 queries", () => {
  it("has 30 cases", () => expect(CASES.length).toBe(30));

  for (const [query, want] of CASES) {
    it(`${query} → ${want.length} note(s)`, async () => {
      const hits = await searchWorkspace(query, { limit: 100 });
      expect(hits.map((h) => h.path).sort()).toEqual([...want].sort());
    });
  }

  it("an operator-only query puts the snippet on the match", async () => {
    const [hit] = await searchWorkspace('"meeting notes" path:archive');
    expect(hit.path).toBe("archive/old.md");
    expect(hit.snippet!.slice(hit.match!.start, hit.match!.end).toLowerCase()).toBe("meeting notes");
  });

  it("the path filter of the caller still applies on top of the operators", async () => {
    const hits = await searchWorkspace("tag:work", { limit: 100, filter: (p) => p.startsWith("daily/") });
    expect(hits.map((h) => h.path).sort()).toEqual(["daily/2026-10-20.md", "daily/2026-10-21.md"]);
  });

  it("a query without operators ranks as before", async () => {
    const hits = await searchWorkspace("shakshuka");
    expect(hits[0].path).toBe("notes/recipes.md");
    expect(ALL).toContain(hits[0].path);
  });
});

describe("body tags (plan 11.3.1)", () => {
  it("reads front matter and #tags, not code, headings, issue numbers or URL fragments", () => {
    expect(noteTags(VAULT["daily/2026-10-22.md"])).toEqual(["personal"]);
    expect(noteTags(VAULT["notes/recipes.md"])).toEqual(["food/breakfast"]);
    expect(noteTags(VAULT["notes/urls.md"])).toEqual([]);
    expect(noteTags(VAULT["projects/gamma.md"])).toEqual(["project", "archive"]);
    expect(noteTags("(#a) [#b] \"#c\" x#d")).toEqual(["a", "b", "c"]);
    expect(noteTags("#עברית ו-#מילים")).toEqual(["עברית"]);
  });

  it("the index keeps a note's tags in step with its edits", () => {
    const idx = new VaultIndex();
    idx.upsert({ path: "a.md", name: "a.md", content: "#one #two", modified: 1 });
    idx.upsert({ path: "b.md", name: "b.md", content: "#two", modified: 1 });
    expect(idx.tagIndex()).toEqual([
      { tag: "one", paths: ["a.md"] },
      { tag: "two", paths: ["a.md", "b.md"] },
    ]);
    idx.upsert({ path: "a.md", name: "a.md", content: "#three", modified: 2 });
    idx.remove("b.md");
    expect(idx.tagIndex()).toEqual([{ tag: "three", paths: ["a.md"] }]);
  });
});

describe("parseQuery", () => {
  it("splits operators from the words to rank", () => {
    const p = parseQuery('plan tag:Work -path:daily "launch plan" /a+/i -draft');
    expect(p.text).toBe("plan launch plan");
    expect(p.ops.map((o) => `${o.negate ? "-" : ""}${o.kind}`)).toEqual(["tag", "-path", "phrase", "regex", "-word"]);
    expect(p.invalid).toEqual([]);
  });

  it("an invalid regex is reported, not thrown", () => {
    expect(parseQuery("/[/").invalid).toEqual(["/[/"]);
  });
});

describe("regressions vs #232 restored in the worker core (S1 review on #306)", () => {
  it("(a) the in-thread engine yields to the event loop during a large upsert", async () => {
    const { localEngine } = await import("../storage/vaultIndexLocal");
    vi.useFakeTimers();
    try {
      // A clock that advances 1 ms per note: 200 notes with a 30 ms slice → yields after notes 31, 62, …
      let t = 0;
      const index = new VaultIndex();
      const engine = localEngine(index, { sliceMs: 30, now: () => t++ });
      const files = Array.from({ length: 200 }, (_, i) => ({ path: `n${i}.md`, name: `n${i}.md`, content: `note ${i}`, modified: 1 }));
      let done = false;
      const p = engine.upsert(files).then(() => (done = true));
      // Before any timer runs, only the first slice is in: the rest waits for the event loop.
      await Promise.resolve();
      await Promise.resolve();
      expect(done).toBe(false);
      const firstSlice = index.size;
      expect(firstSlice).toBeGreaterThan(0);
      expect(firstSlice).toBeLessThan(200);
      // A search queued now waits for the whole upsert (requests stay in order).
      const search = engine.search("note", { limit: 1000 });
      await vi.runAllTimersAsync();
      await p;
      expect(done).toBe(true);
      expect(index.size).toBe(200);
      expect((await search).length).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(b) an unchanged re-upsert re-tokenises nothing", async () => {
    const tokens = await import("../text/searchTokens");
    const spy = vi.spyOn(tokens, "documentTerms");
    const index = new VaultIndex();
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `n${i}.md`, name: `n${i}.md`, content: `note ${i} text`, modified: 1 }));
    for (const f of files) index.upsert(f);
    const first = spy.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(index.stats().tokenised).toBe(50);
    // A redundant full re-upsert (e.g. a rebuild of the same vault): 0 tokenise calls.
    for (const f of files) expect(index.upsert(f)).toBe(false);
    expect(spy.mock.calls.length).toBe(first);
    expect(index.stats()).toMatchObject({ tokenised: 50, unchanged: 50 });
    // One changed note: that note alone is re-tokenised.
    expect(index.upsert({ ...files[3], content: "changed", modified: 2 })).toBe(true);
    expect(index.stats().tokenised).toBe(51);
    expect(spy.mock.calls.length).toBeGreaterThan(first);
    spy.mockRestore();
  });
});
